import type { WaitCause } from '$lib/lage';
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { StudioEvent } from '../events';
import { mask } from '../secrets';
import { appendComment, ticket, type Ticket } from './board';
import { actorLabel, DomainError, OPEN_QUESTION, tx, type Actor } from './core';

export type RunState =
	'queued' | 'running' | 'waiting_approval' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type EndState = 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type RunEventType =
	| 'message'
	| 'reasoning'
	| 'tool_call'
	| 'tool_result'
	| 'permission_request'
	| 'permission_decision'
	| 'diff'
	| 'log'
	| 'error'
	| 'intervention';
/** Payload of an `intervention` event: a recovery step taken in a run, the `attempt` of at most `max`. */
export type Intervention = {
	kind: 'length_stop' | 'stagnation' | 'context_budget' | 'quota';
	attempt: number;
	max: number;
	reason: string;
	hint: string;
	stepTokens?: number;
};
/**
 * Why a paused run continues in a new run: `quota` is a clean stop before a usage limit, `halt` the human resuming a run
 * they paused, the others are fresh runs after getting stuck.
 */
export type ResumeReason = 'context_budget' | 'recovery' | 'quota' | 'halt';
/** Usage adds up: report it per step with the event (visible live, survives crashes) or in total with finishRun. Cost in USD. */
export type Usage = { tokensIn?: number; tokensOut?: number; cost?: number };

export type Profile = {
	name: string;
	executor: 'builtin' | 'acp';
	provider: string | null;
	base_url: string | null;
	model: string | null;
	command: string | null;
	args: string[];
	/** A reference `secret:<name>` or `${ENV_NAME}` — never the key itself. */
	api_key_ref: string | null;
	params: Record<string, unknown>;
	extra_prompt: string;
	permission_policy: Record<string, unknown>;
	max_steps: number | null;
	max_tokens: number | null;
	/** Parallelism pool, e.g. local or cloud; the runner limits active runs per pool. */
	pool: string;
};
/** Slots of a pool without an entry in {@link Limits}: 1, because a local GPU is scarce. */
export const DEFAULT_POOL_SLOTS = 1;
/** Maximum active (running or waiting_approval) runs, overall and per pool; a pool without an entry gets {@link DEFAULT_POOL_SLOTS}. */
export type Limits = { global: number; pools: Record<string, number> };

/** Claim order of queued runs, most urgent first; equal priorities are claimed oldest first. Running runs are never preempted. */
export const PRIORITIES = ['human', 'blocker', 'review', 'normal'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const rank = (column: string) =>
	`CASE ${column} ${PRIORITIES.map((p, i) => `WHEN '${p}' THEN ${i}`).join(' ')} END`;

type Emit = (event: StudioEvent) => void;
type Run = { id: number; ticket_id: number; project_id: number; state: RunState };

/** The run state machine. paused ends the run; it continues in a new run (resumedFromRunId). */
const NEXT: Record<RunState, RunState[]> = {
	queued: ['running', 'cancelled'],
	running: ['waiting_approval', 'paused', 'succeeded', 'failed', 'cancelled'],
	waiting_approval: ['running', 'paused', 'failed', 'cancelled'],
	paused: [],
	succeeded: [],
	failed: [],
	cancelled: []
};
/** Which function performs a transition: startRun creates the token, finishRun revokes it. */
const via = (from: RunState, to: RunState) =>
	NEXT[to].length === 0 ? 'finishRun' : from === 'queued' ? 'startRun' : 'setRunState';

/**
 * SQL condition: the run `alias` was paused by the human and nothing continues it yet. Lives here rather than in
 * domain/halt.ts because `deleteProfile` needs it without importing halt.ts back (halt.ts already imports from
 * here, so the reverse import would cycle).
 */
export const awaitsResume = (alias: string) =>
	`${alias}.state = 'paused' AND ${alias}.halted = 1 AND NOT EXISTS (SELECT 1 FROM runs c WHERE c.resumed_from_run_id = ${alias}.id)`;

const PROFILE_FIELDS = [
	'name',
	'executor',
	'provider',
	'base_url',
	'model',
	'command',
	'args',
	'api_key_ref',
	'params',
	'extra_prompt',
	'permission_policy',
	'max_steps',
	'max_tokens',
	'pool'
] as const;
const JSON_FIELDS = ['args', 'params', 'permission_policy'];

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const usage = (u: Usage = {}) => [u.tokensIn ?? 0, u.tokensOut ?? 0, u.cost ?? 0];
const ADD_USAGE = 'tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost = cost + ?';

function run(db: DatabaseSync, id: number): Run {
	const r = db
		.prepare(
			'SELECT r.id, r.ticket_id, t.project_id, r.state FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE r.id = ?'
		)
		.get(id) as Run | undefined;
	if (!r) throw new DomainError('not_found', `Run ${id} gibt es nicht.`, 'Prüfe die Run-ID.');
	return r;
}

/** Checks the transition against NEXT and the responsible function, then writes it; `set` adds more columns. */
function transition(
	db: DatabaseSync,
	emit: Emit,
	actor: Actor,
	runId: number,
	to: RunState,
	fn: string,
	set = '',
	...params: SQLInputValue[]
) {
	const r = run(db, runId);
	const next = NEXT[r.state];
	if (!next.includes(to) || via(r.state, to) !== fn)
		throw new DomainError(
			'invalid_run_transition',
			next.length
				? `Run ${r.id} ist „${r.state}“ und kann mit ${fn} nicht nach „${to}“ wechseln. Erlaubt: ${next.map((s) => `${s} (${via(r.state, s)})`).join(', ')}.`
				: `Run ${r.id} ist bereits beendet („${r.state}“) und kann nicht nach „${to}“ wechseln.`,
			next.length
				? 'Rufe für den gewünschten Folgezustand die Funktion in Klammern auf.'
				: 'Weitere Arbeit braucht einen neuen Run: createRun, nach „paused“ mit resumedFromRunId.'
		);
	const totals = db
		.prepare(
			`UPDATE runs SET state = ?${set} WHERE id = ? RETURNING tokens_in AS tokensIn, tokens_out AS tokensOut, cost`
		)
		.get(to, ...params, r.id) as { tokensIn: number; tokensOut: number; cost: number };
	emit({
		type: 'run.state_changed',
		projectId: r.project_id,
		ticketId: r.ticket_id,
		actor,
		runId: r.id,
		from: r.state,
		to,
		...totals
	});
	return totals;
}

/**
 * Creates a `queued` run that records the ticket's column as its role. The one place that admits a run: the ticket must
 * stand in a work step (`not_in_work`), have no other pending run (`run_pending`) and no open question (`open_question`).
 * With `resumedFromRunId` it continues a paused run, which does not stand in its own way.
 */
export function createRun(
	db: DatabaseSync,
	actor: Actor,
	r: {
		ticketId: number;
		profileId: number;
		trigger?: 'manual' | 'on_enter';
		resumedFromRunId?: number;
		resumeReason?: ResumeReason;
		notBefore?: string;
	}
): { id: number } {
	return tx(db, (emit) => {
		const t = ticket(db, r.ticketId);
		if (t.column_phase !== 'work') throw notInWork(t);
		getProfile(db, r.profileId);
		if (r.resumedFromRunId !== undefined) assertResumable(db, t, r.resumedFromRunId);
		assertAdmitted(db, t, r.resumedFromRunId);
		const trigger = r.resumedFromRunId === undefined ? (r.trigger ?? 'manual') : 'resume';
		const priority = derivePriority(db, t.id, t.column_id, trigger);
		const notBefore = r.notBefore === undefined ? null : canonicalTime(r.notBefore);
		const { id } = db
			.prepare(
				`INSERT INTO runs (ticket_id, column_id, agent_profile_id, trigger, priority, resumed_from_run_id, resume_reason, not_before)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
			)
			.get(
				t.id,
				t.column_id,
				r.profileId,
				trigger,
				priority,
				r.resumedFromRunId ?? null,
				r.resumeReason ?? null,
				notBefore
			) as { id: number };
		emit({ type: 'run.created', projectId: t.project_id, ticketId: t.id, actor, runId: id });
		return { id };
	});
}

/** Backlog waits for the human's start; acceptance and done are the human's to decide. */
export function notInWork(t: Ticket): DomainError {
	return new DomainError(
		'not_in_work',
		`${t.ref} liegt in „${t.column_name}“; Runs gibt es nur in den Arbeitsschritten.`,
		t.column_phase === 'open'
			? 'Starte das Ticket mit „los“ (startTicket): es rückt in den ersten Arbeitsschritt, und sein Run startet.'
			: 'Hier entscheidet der Mensch: abnehmen (acceptTicket) oder mit Kommentar zurückgeben (returnTicket).'
	);
}

/**
 * A run of the ticket is active, waits in the queue, or was paused by the human and waits to be resumed; a second one
 * would work the same step twice. `except` is the run being resumed, which does not stand in its own way.
 */
function pendingRun(db: DatabaseSync, ticketId: number, except?: number) {
	return db
		.prepare(
			`SELECT id, state FROM runs r WHERE ticket_id = ? AND id IS NOT ?
				AND (state IN ('queued', 'running', 'waiting_approval') OR (${awaitsResume('r')}))
			ORDER BY id LIMIT 1`
		)
		.get(ticketId, except ?? null) as { id: number; state: RunState } | undefined;
}

/** One run per ticket: refuses a second one, with the way out that fits the run already there. */
function assertNoPendingRun(db: DatabaseSync, t: Ticket, except?: number) {
	const pending = pendingRun(db, t.id, except);
	if (!pending) return;
	throw new DomainError(
		'run_pending',
		`${t.ref} hat schon Run ${pending.id} („${pending.state}“).`,
		pending.state === 'paused'
			? `Setz ihn fort (:fortsetzen ${pending.id}) statt einen zweiten zu starten.`
			: 'Warte, bis er endet, oder brich ihn in der Run-Akte ab (x); danach erneut „los“.'
	);
}

const hasOpenQuestion = (db: DatabaseSync, ticketId: number) =>
	db
		.prepare(`SELECT 1 FROM questions q WHERE q.ticket_id = ? AND ${OPEN_QUESTION}`)
		.get(ticketId) !== undefined;

function assertAdmitted(db: DatabaseSync, t: Ticket, resumedFromRunId?: number) {
	assertNoPendingRun(db, t, resumedFromRunId);
	assertNoOpenQuestion(db, t);
}

function assertNoOpenQuestion(db: DatabaseSync, t: Ticket) {
	if (!hasOpenQuestion(db, t.id)) return;
	throw new DomainError(
		'open_question',
		`${t.ref} wartet auf deine Antwort auf eine offene Frage.`,
		'Beantworte zuerst die Frage; die Antwort setzt die Arbeit fort.'
	);
}

/**
 * The human restarts or accepts a ticket from outside the work phase. A run paused earlier would block the new run
 * and can no longer be resumed; it is left behind, and the ticket says so.
 */
export function abandonHaltedRuns(
	db: DatabaseSync,
	emit: Emit,
	actor: Actor,
	t: Ticket,
	because: string
) {
	const dropped = db
		.prepare(`SELECT id FROM runs WHERE ticket_id = ? AND ${awaitsResume('runs')} ORDER BY id`)
		.all(t.id) as { id: number }[];
	for (const { id } of dropped) {
		db.prepare('UPDATE runs SET halted = 0 WHERE id = ?').run(id);
		appendComment(
			db,
			emit,
			{ ...actor, runId: id },
			t,
			`Run ${id} (angehalten) wird nicht fortgesetzt: ${because}.\nAusweg: Braucht es die Arbeit noch, gib das Ticket zurück oder starte es mit „los“.`,
			true
		);
	}
}

function assertResumable(db: DatabaseSync, t: Ticket, previousRunId: number) {
	const prev = run(db, previousRunId);
	if (prev.ticket_id === t.id && prev.state === 'paused') return;
	throw new DomainError(
		'invalid_resume',
		`Fortsetzen geht nur mit einem pausierten Run von ${t.ref}; Run ${prev.id} ist „${prev.state}“${prev.ticket_id === t.id ? '' : ' und gehört zu einem anderen Ticket'}.`,
		'Lege den Run ohne resumedFromRunId an oder nenne den pausierten Run dieses Tickets.'
	);
}

/** The form runs.not_before stores, so that claimRun can compare it as text. */
function canonicalTime(time: string) {
	const date = new Date(time);
	if (Number.isNaN(date.getTime()))
		throw new DomainError(
			'invalid_not_before',
			`„${time}“ ist kein Zeitpunkt.`,
			'Gib notBefore als ISO-8601-Zeitpunkt an, z. B. 2026-10-02T15:00:00Z.'
		);
	return date.toISOString();
}

/**
 * Fresh runs (resumed for context_budget or recovery) in the chain of resumes that ends with this run. The chain starts at the
 * nearest run without a resume reason, so a run the human starts or resumes begins a new one.
 */
export function freshRunsInChain(db: DatabaseSync, runId: number): number {
	const { fresh } = db
		.prepare(
			`WITH RECURSIVE chain (id, resumed_from, reason) AS (
				SELECT id, resumed_from_run_id, resume_reason FROM runs WHERE id = ?
				UNION ALL
				SELECT r.id, r.resumed_from_run_id, r.resume_reason FROM runs r JOIN chain c ON r.id = c.resumed_from WHERE c.reason IS NOT NULL)
			SELECT count(*) AS fresh FROM chain WHERE reason IN ('context_budget', 'recovery')`
		)
		.get(runId) as { fresh: number };
	return fresh;
}

// ponytail: derived once at creation; recompute at claim time if successors finishing first turns out to matter in practice.
function derivePriority(
	db: DatabaseSync,
	ticketId: number,
	columnId: number,
	trigger: 'manual' | 'on_enter' | 'resume'
): Priority {
	const hasWaitingSuccessor = db
		.prepare(
			`SELECT 1 FROM ticket_relations r JOIN tickets s ON s.id = r.to_ticket_id JOIN columns c ON c.id = s.column_id
			WHERE r.from_ticket_id = ? AND r.type = 'blocks' AND c.phase <> 'done'`
		)
		.get(ticketId);
	if (hasWaitingSuccessor) return 'blocker';
	const inCritique =
		db.prepare('SELECT step FROM columns WHERE id = ?').get(columnId)?.step === 'critique';
	if (inCritique && trigger !== 'manual') return 'review';
	return 'normal';
}

/** Moves a queued run ahead of all agent-triggered work in its pool. Only the human may: it outranks everything agents queue. */
export function prioritizeRun(db: DatabaseSync, actor: Actor, runId: number) {
	tx(db, (emit) => {
		if (actor.kind !== 'user')
			throw new DomainError(
				'requires_human',
				'Runs priorisiert nur der Mensch.',
				'Ist etwas dringend: frag den Menschen (requestHuman); das Ticket wartet dann auf ihn.'
			);
		const r = run(db, runId);
		if (r.state !== 'queued')
			throw new DomainError(
				'run_not_queued',
				`Run ${r.id} ist „${r.state}“ — priorisieren lässt sich nur ein wartender Run.`,
				'Ein gestarteter Run wird nicht verdrängt; priorisiere einen Run in der Queue.'
			);
		db.prepare("UPDATE runs SET priority = 'human' WHERE id = ?").run(r.id);
		emit({
			type: 'run.prioritized',
			projectId: r.project_id,
			ticketId: r.ticket_id,
			actor,
			runId: r.id
		});
	});
}

export type WaitReason = {
	pool: string;
	priority: Priority;
	activeInPool: number;
	poolLimit: number;
	active: number;
	globalLimit: number;
	/** Queued runs of the same pool that will be claimed first. */
	ahead: number;
	/** Why it waits, as codes with parameters for the UI to translate. */
	causes: WaitCause[];
	text: string;
};
type WaitRow = Omit<WaitReason, 'poolLimit' | 'globalLimit' | 'text' | 'causes'> & {
	halt: 'stop' | 'pause' | null;
};

const WAIT_ROWS = `SELECT r.id AS runId, r.priority, p.pool, (SELECT kind FROM runner_halt) AS halt,
		(SELECT count(*) FROM runs a WHERE a.state IN ('running', 'waiting_approval')) AS active,
		(SELECT count(*) FROM runs a JOIN agent_profiles ap ON ap.id = a.agent_profile_id
			WHERE a.state IN ('running', 'waiting_approval') AND ap.pool = p.pool) AS activeInPool,
		(SELECT count(*) FROM runs q JOIN agent_profiles qp ON qp.id = q.agent_profile_id
			WHERE q.state = 'queued' AND qp.pool = p.pool AND (${rank('q.priority')}, q.id) < (${rank('r.priority')}, r.id)) AS ahead
	FROM runs r JOIN agent_profiles p ON p.id = r.agent_profile_id WHERE r.state = 'queued'`;

/** Why each queued run does not run yet, in one query; `runId` narrows it to one run. */
export function waitReasons(
	db: DatabaseSync,
	limits: Limits,
	runId?: number
): Map<number, WaitReason> {
	const rows = db
		.prepare(`${WAIT_ROWS} AND (?1 IS NULL OR r.id = ?1)`)
		.all(runId ?? null) as (WaitRow & { runId: number })[];
	return new Map(
		rows.map(({ runId: id, halt, ...counts }) => {
			const reason = {
				...counts,
				poolLimit: limits.pools[counts.pool] ?? DEFAULT_POOL_SLOTS,
				globalLimit: limits.global
			};
			const causes: WaitCause[] = halt ? [{ code: `halt_${halt}` }] : waitCauses(reason);
			return [id, { ...reason, causes, text: causesText(causes) }];
		})
	);
}

/** Why a queued run does not run yet — the same answer for the run UI and the agent's context; undefined unless the run is queued. */
export const waitReason = (db: DatabaseSync, runId: number, limits: Limits) =>
	waitReasons(db, limits, runId).get(runId);

function waitCauses(r: Omit<WaitReason, 'text' | 'causes'>): WaitCause[] {
	const causes: WaitCause[] = [];
	if (r.activeInPool >= r.poolLimit)
		causes.push({ code: 'pool_full', pool: r.pool, active: r.activeInPool, limit: r.poolLimit });
	if (r.active >= r.globalLimit)
		causes.push({ code: 'global_full', active: r.active, limit: r.globalLimit });
	if (r.ahead > 0) causes.push({ code: 'ahead', count: r.ahead });
	return causes.length ? causes : [{ code: 'claim' }];
}

function causeText(c: WaitCause): string {
	switch (c.code) {
		case 'halt_stop':
			return 'Not-Aus aktiv — Fortsetzen mit :fortsetzen all';
		case 'halt_pause':
			return 'alle Runs angehalten — Fortsetzen mit :fortsetzen all';
		case 'claim':
			return 'auf den nächsten Claim des Runners';
		case 'pool_full':
			return `Pool „${c.pool}“ ist voll (${c.active} von ${c.limit} aktiv)`;
		case 'global_full':
			return `das globale Limit ist erreicht (${c.active} von ${c.limit} aktiv)`;
		case 'ahead':
			return `vor ihm in der Queue: ${c.count} ${c.count === 1 ? 'Run' : 'Runs'}`;
	}
}

/** The German sentence for the agent's context and the run panel; the board translates the codes instead. */
const causesText = (causes: WaitCause[]) =>
	causes[0].code === 'claim'
		? 'wartet auf den nächsten Claim des Runners.'
		: `wartet: ${causes.map(causeText).join(', ')}.`;

/**
 * queued → running. Creates the run token and returns it in plain text exactly once, here; only its hash is stored.
 * (Not in createRun already: queued runs outlive a restart, and the plain text would then be lost.)
 */
export function startRun(db: DatabaseSync, actor: Actor, runId: number): { token: string } {
	return tx(db, (emit) => start(db, emit, actor, runId));
}

function start(db: DatabaseSync, emit: Emit, actor: Actor, runId: number) {
	const token = randomBytes(32).toString('base64url');
	transition(
		db,
		emit,
		actor,
		runId,
		'running',
		'startRun',
		', started_at = CURRENT_TIMESTAMP, token_hash = ?',
		hash(token)
	);
	assignTicketToRun(db, emit, actor, run(db, runId));
	return { token };
}

/** The board shows who works a ticket from the moment its run starts, also for runs that only read or fail early. */
function assignTicketToRun(db: DatabaseSync, emit: Emit, actor: Actor, r: Run) {
	db.prepare('UPDATE tickets SET assignee = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
		actorLabel({ kind: 'agent', runId: r.id }),
		r.ticket_id
	);
	emit({
		type: 'ticket.updated',
		projectId: r.project_id,
		ticketId: r.ticket_id,
		actor,
		runId: r.id,
		fields: ['assignee']
	});
}

// An active run without a profile counts towards the global limit only.
export const CLAIM = `WITH active AS (
	SELECT p.pool FROM runs r LEFT JOIN agent_profiles p ON p.id = r.agent_profile_id WHERE r.state IN ('running', 'waiting_approval'))
SELECT r.id, r.ticket_id AS ticketId, t.project_id AS projectId, r.agent_profile_id AS profileId
FROM runs r JOIN agent_profiles p ON p.id = r.agent_profile_id JOIN tickets t ON t.id = r.ticket_id
WHERE r.state = 'queued'
	AND NOT EXISTS (SELECT 1 FROM runner_halt)
	AND (r.not_before IS NULL OR r.not_before <= ?3)
	AND (SELECT count(*) FROM active) < ?1
	AND (SELECT count(*) FROM active a WHERE a.pool = p.pool) < coalesce((SELECT value FROM json_each(?2) WHERE key = p.pool), ?4)
ORDER BY ${rank('r.priority')}, r.id LIMIT 1`;

/**
 * Starts the most urgent queued run (oldest among equal priorities) whose pool and the global limit have room and whose not_before
 * has passed, or returns undefined — always while the kill switch is set. Selection and start share one write transaction, so concurrent runners never claim the same run or exceed a limit.
 */
export function claimRun(db: DatabaseSync, actor: Actor, limits: Limits, now = new Date()) {
	return tx(db, (emit) => {
		const next = db
			.prepare(CLAIM)
			.get(limits.global, JSON.stringify(limits.pools), now.toISOString(), DEFAULT_POOL_SLOTS) as
			{ id: number; ticketId: number; projectId: number; profileId: number } | undefined;
		if (!next) return undefined;
		const { profileId, ...claimed } = next;
		return {
			...claimed,
			profile: getProfile(db, profileId),
			...start(db, emit, actor, claimed.id)
		};
	});
}

/** running ↔ waiting_approval (approval requested or decided). */
export function setRunState(
	db: DatabaseSync,
	actor: Actor,
	runId: number,
	to: 'running' | 'waiting_approval'
) {
	tx(db, (emit) => transition(db, emit, actor, runId, to, 'setRunState'));
}

/** The end of a run; `failed` requires an error text, in the type and at runtime. */
export type RunEnd = (
	{ state: 'failed'; error: string } | { state: Exclude<EndState, 'failed'>; error?: string }
) & { usage?: Usage };

/** Ends the run: revokes the token, adds the last usage and returns the totals. */
export function finishRun(db: DatabaseSync, actor: Actor, runId: number, end: RunEnd) {
	return tx(db, (emit) => {
		if (end.state === 'failed' && !end.error?.trim())
			throw new DomainError(
				'error_required',
				`Run ${runId} als „failed“ beenden geht nur mit Fehlertext.`,
				'Gib `error` an: in einem Satz, was schiefging — der Mensch sieht ihn am Run.'
			);
		// The error text comes from the agent or provider and may contain a secret, so it is masked before writing.
		return transition(
			db,
			emit,
			actor,
			runId,
			end.state,
			'finishRun',
			`, finished_at = CURRENT_TIMESTAMP, token_hash = NULL, error = ?, ${ADD_USAGE}`,
			end.error ? mask(end.error) : null,
			...usage(end.usage)
		);
	});
}

/**
 * Appends an event: `seq` has no gaps per run (MAX+1 in the same write transaction). Retry-safe through `key`:
 * the same request again returns the existing seq with `duplicate: true` — no second event, no bus event, no double usage.
 */
export function appendEvent(
	db: DatabaseSync,
	actor: Actor,
	runId: number,
	e: { type: RunEventType; payload?: unknown; key?: string; usage?: Usage }
): { seq: number; duplicate: boolean } {
	return tx(db, (emit) => {
		const r = run(db, runId);
		const payload = JSON.stringify(mask(e.payload ?? {}));
		const repeatedSeq =
			e.key === undefined ? undefined : repeatedEventSeq(db, r.id, e.key, e.type, payload);
		if (repeatedSeq !== undefined) return { seq: repeatedSeq, duplicate: true };
		assertAcceptsEvents(r);
		const { seq } = db
			.prepare(
				`INSERT INTO run_events (run_id, seq, type, payload, idempotency_key)
				SELECT ?1, coalesce(max(seq), 0) + 1, ?2, ?3, ?4 FROM run_events WHERE run_id = ?1 RETURNING seq`
			)
			.get(r.id, e.type, payload, e.key ?? null) as { seq: number };
		if (e.usage)
			db.prepare(`UPDATE runs SET ${ADD_USAGE} WHERE id = ?`).run(...usage(e.usage), r.id);
		emit({
			type: 'run.event',
			projectId: r.project_id,
			ticketId: r.ticket_id,
			actor,
			runId: r.id,
			seq,
			eventType: e.type,
			key: e.key,
			payload: JSON.parse(payload)
		});
		return { seq, duplicate: false };
	});
}

/** The seq of an identical event already stored under `key`; throws if the key holds a different event. */
function repeatedEventSeq(
	db: DatabaseSync,
	runId: number,
	key: string,
	type: RunEventType,
	payload: string
): number | undefined {
	const old = db
		.prepare('SELECT seq, type, payload FROM run_events WHERE run_id = ? AND idempotency_key = ?')
		.get(runId, key);
	if (!old) return undefined;
	if (old.type === type && old.payload === payload) return old.seq as number;
	throw new DomainError(
		'idempotency_conflict',
		`Run ${runId} hat unter dem Schlüssel „${key}“ schon ein anderes Event (seq ${old.seq}).`,
		'Eine Wiederholung sendet Typ und Payload unverändert; ein neues Event braucht einen neuen Schlüssel.'
	);
}

function assertAcceptsEvents(r: Run) {
	if (r.state === 'running' || r.state === 'waiting_approval') return;
	throw new DomainError(
		'run_not_active',
		`Run ${r.id} ist „${r.state}“ — Events nimmt nur ein laufender Run an.`,
		r.state === 'queued'
			? 'Starte den Run zuerst (startRun).'
			: 'Events vor finishRun schreiben; weitere Arbeit braucht einen neuen Run.'
	);
}

/** The running run of a run token (studio MCP); undefined if the token is unknown or the run has ended. */
export function runForToken(db: DatabaseSync, token: string) {
	return db
		.prepare(
			'SELECT r.id AS runId, r.ticket_id AS ticketId, t.project_id AS projectId FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE r.token_hash = ?'
		)
		.get(hash(token)) as { runId: number; ticketId: number; projectId: number } | undefined;
}

// ponytail: profile changes emit no bus event (StudioEvent requires a projectId); add one when the profile UI needs live updates.

/** Profiles decide the model, permissions and approvals of runs — an agent must not change them, or it could grant itself permissions. */
function requireNotAgent(actor: Actor) {
	if (actor.kind === 'agent')
		throw new DomainError(
			'requires_human',
			'Agent-Profile ändert nur der Mensch.',
			'Brauchst du ein anderes Profil oder mehr Rechte: frag den Menschen (requestHuman).'
		);
}

function profileFields(input: object): [string, SQLInputValue][] {
	return Object.entries(input)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => {
			if (!(PROFILE_FIELDS as readonly string[]).includes(k))
				throw new DomainError(
					'unknown_field',
					`Das Profilfeld „${k}“ gibt es nicht.`,
					`Felder: ${PROFILE_FIELDS.join(', ')}.`
				);
			return [k, JSON_FIELDS.includes(k) ? JSON.stringify(v) : v];
		});
}

/** Accepts only a reference to a key. The message never repeats the value — it could be a key pasted by mistake. */
export function checkKeyRef(ref: string) {
	if (!/^(secret:\S+|\$\{\w+\})$/.test(ref))
		throw new DomainError(
			'invalid_secret_ref',
			'api_key_ref ist kein Verweis. Erlaubt sind secret:<name> (verschlüsselt gespeichertes Secret) und ${NAME} (Umgebungsvariable); der Key selbst wird hier nie gespeichert.',
			'Speichere den Key als Secret und trage secret:<name> ein.'
		);
}

function checkProfile(db: DatabaseSync, p: Partial<Profile>, id: number | null) {
	if (p.api_key_ref != null) checkKeyRef(p.api_key_ref);
	const missing = (
		p.executor === 'acp' ? (['command'] as const) : (['provider', 'model'] as const)
	).filter((k) => !p[k]);
	if (missing.length)
		throw new DomainError(
			'missing_field',
			`Ein ${p.executor}-Profil braucht ${missing.join(' und ')}.`,
			`Setze ${missing.join(', ')}.`
		);
	if (
		db
			.prepare('SELECT 1 FROM agent_profiles WHERE name = ? AND id IS NOT ?')
			.get(p.name ?? null, id)
	)
		throw new DomainError(
			'name_taken',
			`Ein Profil „${p.name}“ gibt es schon.`,
			'Wähle einen anderen Namen oder bearbeite das vorhandene Profil (updateProfile).'
		);
}

function parseProfile(row: Record<string, unknown>) {
	for (const k of JSON_FIELDS) row[k] = JSON.parse(row[k] as string);
	return row as Profile & { id: number };
}

export function getProfile(db: DatabaseSync, id: number) {
	const row = db
		.prepare(`SELECT id, ${PROFILE_FIELDS.join(', ')} FROM agent_profiles WHERE id = ?`)
		.get(id);
	if (!row)
		throw new DomainError(
			'not_found',
			`Agent-Profil ${id} gibt es nicht.`,
			'listProfiles zeigt die vorhandenen Profile.'
		);
	return parseProfile(row);
}

export function listProfiles(db: DatabaseSync) {
	return db
		.prepare(`SELECT id, ${PROFILE_FIELDS.join(', ')} FROM agent_profiles ORDER BY name`)
		.all()
		.map(parseProfile);
}

export function createProfile(
	db: DatabaseSync,
	actor: Actor,
	p: Partial<Profile> & Pick<Profile, 'name' | 'executor'>
): { id: number } {
	return tx(db, () => {
		requireNotAgent(actor);
		const f = profileFields(p);
		checkProfile(db, p, null);
		return db
			.prepare(
				`INSERT INTO agent_profiles (${f.map(([k]) => k).join(', ')}) VALUES (${f.map(() => '?').join(', ')}) RETURNING id`
			)
			.get(...f.map(([, v]) => v)) as { id: number };
	});
}

export function updateProfile(db: DatabaseSync, actor: Actor, id: number, patch: Partial<Profile>) {
	tx(db, () => {
		requireNotAgent(actor);
		const f = profileFields(patch);
		checkProfile(db, { ...getProfile(db, id), ...patch }, id);
		if (f.length)
			db.prepare(
				`UPDATE agent_profiles SET ${f.map(([k]) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
			).run(...f.map(([, v]) => v), id);
	});
}

/**
 * Deletes a profile while no active run uses it and none is still paused and awaiting resume; ended runs keep
 * their history (agent_profile_id becomes NULL).
 */
export function deleteProfile(db: DatabaseSync, actor: Actor, id: number) {
	tx(db, () => {
		requireNotAgent(actor);
		const { name } = getProfile(db, id);
		const active = db
			.prepare(
				`SELECT id FROM runs WHERE agent_profile_id = ? AND state IN ('queued', 'running', 'waiting_approval') ORDER BY id`
			)
			.all(id);
		if (active.length)
			throw new DomainError(
				'profile_in_use',
				`Profil „${name}“ wird von aktiven Runs genutzt: ${active.map((r) => r.id).join(', ')}.`,
				'Warte, bis die Runs enden, oder brich sie ab, dann erneut löschen.'
			);
		const paused = db
			.prepare(
				`SELECT id FROM runs WHERE agent_profile_id = ? AND (${awaitsResume('runs')}) ORDER BY id`
			)
			.all(id) as { id: number }[];
		if (paused.length)
			throw new DomainError(
				'profile_in_use',
				`Profil „${name}“ wird von angehaltenen Runs genutzt, die noch auf Fortsetzen warten: ${paused.map((r) => r.id).join(', ')}.`,
				'Erst fortsetzen (:fortsetzen all oder :fortsetzen <N>), dann erneut löschen.'
			);
		db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
	});
}
