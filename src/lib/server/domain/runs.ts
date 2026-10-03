import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { StudioEvent } from '../events';
import { mask } from '../secrets';
import { ticket } from './board';
import { actorLabel, DomainError, tx, type Actor } from './core';

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
/** Why a paused run continues in a new run; `quota` is a clean stop before a usage limit, the others are fresh runs after getting stuck. */
export type ResumeReason = 'context_budget' | 'recovery' | 'quota';
/** Verbrauch ist additiv: pro Schritt mit dem Event melden (live sichtbar, übersteht Abstürze) oder gesammelt bei finishRun. Kosten in USD. */
export type Usage = { tokensIn?: number; tokensOut?: number; cost?: number };

export type Profile = {
	name: string;
	executor: 'builtin' | 'acp';
	provider: string | null;
	base_url: string | null;
	model: string | null;
	command: string | null;
	args: string[];
	/** Verweis `secret:<name>` oder `${ENV_NAME}` — nie der Key selbst. */
	api_key_ref: string | null;
	params: Record<string, unknown>;
	extra_prompt: string;
	permission_policy: Record<string, unknown>;
	max_steps: number | null;
	max_tokens: number | null;
	/** Parallelism pool, e.g. local or cloud; the runner limits active runs per pool. */
	pool: string;
};
/** Maximum active (running or waiting_approval) runs, overall and per pool; a pool without an entry gets 1 because a local GPU is scarce. */
export type Limits = { global: number; pools: Record<string, number> };

/** Claim order of queued runs, most urgent first; equal priorities are claimed oldest first. Running runs are never preempted. */
export const PRIORITIES = ['human', 'blocker', 'review', 'normal'] as const;
export type Priority = (typeof PRIORITIES)[number];
const rank = (column: string) =>
	`CASE ${column} ${PRIORITIES.map((p, i) => `WHEN '${p}' THEN ${i}`).join(' ')} END`;

type Emit = (event: StudioEvent) => void;
type Run = { id: number; ticket_id: number; project_id: number; state: RunState };

/** Zustandsmaschine laut Run-Lebenszyklus. paused beendet den Run; fortgesetzt wird mit einem neuen Run (resumedFromRunId). */
const NEXT: Record<RunState, RunState[]> = {
	queued: ['running', 'cancelled'],
	running: ['waiting_approval', 'paused', 'succeeded', 'failed', 'cancelled'],
	waiting_approval: ['running', 'failed', 'cancelled'],
	paused: [],
	succeeded: [],
	failed: [],
	cancelled: []
};
/** Welche Funktion einen Übergang ausführt: startRun erzeugt dabei das Token, finishRun entwertet es. */
const via = (from: RunState, to: RunState) =>
	NEXT[to].length === 0 ? 'finishRun' : from === 'queued' ? 'startRun' : 'setRunState';

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

/** Prüft den Übergang gegen NEXT und die zuständige Funktion und schreibt ihn; `set` ergänzt weitere Spalten. */
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

/** Legt einen Run `queued` an; die Spalte des Tickets wird als Rolle festgehalten. Mit `resumedFromRunId` setzt er einen pausierten Run fort. */
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
		getProfile(db, r.profileId);
		if (r.resumedFromRunId !== undefined) {
			const prev = run(db, r.resumedFromRunId);
			if (prev.ticket_id !== t.id || prev.state !== 'paused')
				throw new DomainError(
					'invalid_resume',
					`Fortsetzen geht nur mit einem pausierten Run von ${t.ref}; Run ${prev.id} ist „${prev.state}“${prev.ticket_id === t.id ? '' : ' und gehört zu einem anderen Ticket'}.`,
					'Lege den Run ohne resumedFromRunId an oder nenne den pausierten Run dieses Tickets.'
				);
		}
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
			WHERE r.from_ticket_id = ? AND r.type = 'blocks' AND c.kind <> 'done'`
		)
		.get(ticketId);
	if (hasWaitingSuccessor) return 'blocker';
	const inReviewColumn =
		db.prepare('SELECT review FROM columns WHERE id = ?').get(columnId)?.review === 1;
	if (inReviewColumn && trigger !== 'manual') return 'review';
	return 'normal';
}

/** Moves a queued run ahead of all agent-triggered work in its pool. Only the human may: it outranks everything agents queue. */
export function prioritizeRun(db: DatabaseSync, actor: Actor, runId: number) {
	tx(db, (emit) => {
		if (actor.kind !== 'user')
			throw new DomainError(
				'requires_human',
				'Runs priorisiert nur der Mensch.',
				'Ist etwas dringend: Frage als Kommentar, dann in die human_intervention-Spalte.'
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
	text: string;
};

/** Why a queued run does not run yet — the same answer for the run UI and the agent's context; undefined unless the run is queued. */
export function waitReason(
	db: DatabaseSync,
	runId: number,
	limits: Limits
): WaitReason | undefined {
	const row = db
		.prepare(
			`SELECT r.priority, p.pool,
				(SELECT count(*) FROM runs a WHERE a.state IN ('running', 'waiting_approval')) AS active,
				(SELECT count(*) FROM runs a JOIN agent_profiles ap ON ap.id = a.agent_profile_id
					WHERE a.state IN ('running', 'waiting_approval') AND ap.pool = p.pool) AS activeInPool,
				(SELECT count(*) FROM runs q JOIN agent_profiles qp ON qp.id = q.agent_profile_id
					WHERE q.state = 'queued' AND qp.pool = p.pool AND (${rank('q.priority')}, q.id) < (${rank('r.priority')}, r.id)) AS ahead
			FROM runs r JOIN agent_profiles p ON p.id = r.agent_profile_id WHERE r.id = ? AND r.state = 'queued'`
		)
		.get(runId) as Omit<WaitReason, 'poolLimit' | 'globalLimit' | 'text'> | undefined;
	if (!row) return undefined;
	const reason = { ...row, poolLimit: limits.pools[row.pool] ?? 1, globalLimit: limits.global };
	return { ...reason, text: waitText(reason) };
}

function waitText(r: Omit<WaitReason, 'text'>) {
	const causes = [
		r.activeInPool >= r.poolLimit &&
			`Pool „${r.pool}“ ist voll (${r.activeInPool} von ${r.poolLimit} aktiv)`,
		r.active >= r.globalLimit &&
			`das globale Limit ist erreicht (${r.active} von ${r.globalLimit} aktiv)`,
		r.ahead > 0 && `vor ihm in der Queue: ${r.ahead} ${r.ahead === 1 ? 'Run' : 'Runs'}`
	].filter(Boolean);
	return causes.length
		? `wartet: ${causes.join(', ')}.`
		: 'wartet auf den nächsten Claim des Runners.';
}

/**
 * queued → running. Erzeugt das Run-Token und gibt es genau hier einmal im Klartext zurück; gespeichert wird nur der Hash.
 * (Nicht schon bei createRun: queued-Runs überdauern einen Neustart, der Klartext wäre dann verloren.)
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
const CLAIM = `WITH active AS (
	SELECT p.pool FROM runs r LEFT JOIN agent_profiles p ON p.id = r.agent_profile_id WHERE r.state IN ('running', 'waiting_approval'))
SELECT r.id, r.ticket_id AS ticketId, t.project_id AS projectId, r.agent_profile_id AS profileId
FROM runs r JOIN agent_profiles p ON p.id = r.agent_profile_id JOIN tickets t ON t.id = r.ticket_id
WHERE r.state = 'queued'
	AND (r.not_before IS NULL OR r.not_before <= ?3)
	AND (SELECT count(*) FROM active) < ?1
	AND (SELECT count(*) FROM active a WHERE a.pool = p.pool) < coalesce((SELECT value FROM json_each(?2) WHERE key = p.pool), 1)
ORDER BY ${rank('r.priority')}, r.id LIMIT 1`;

/**
 * Starts the most urgent queued run (oldest among equal priorities) whose pool and the global limit have room and whose not_before
 * has passed, or returns undefined. Selection and start share one write transaction, so concurrent runners never claim the same run or exceed a limit.
 */
export function claimRun(db: DatabaseSync, actor: Actor, limits: Limits, now = new Date()) {
	return tx(db, (emit) => {
		const next = db
			.prepare(CLAIM)
			.get(limits.global, JSON.stringify(limits.pools), now.toISOString()) as
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

/** running ↔ waiting_approval (Freigabe angefragt bzw. entschieden). */
export function setRunState(
	db: DatabaseSync,
	actor: Actor,
	runId: number,
	to: 'running' | 'waiting_approval'
) {
	tx(db, (emit) => transition(db, emit, actor, runId, to, 'setRunState'));
}

/** Ende eines Runs; `failed` verlangt einen Fehlertext — im Typ und zur Laufzeit. */
export type RunEnd = (
	{ state: 'failed'; error: string } | { state: Exclude<EndState, 'failed'>; error?: string }
) & { usage?: Usage };

/** Beendet den Run: entwertet das Token, addiert den letzten Verbrauch und liefert die Summen. */
export function finishRun(db: DatabaseSync, actor: Actor, runId: number, end: RunEnd) {
	return tx(db, (emit) => {
		if (end.state === 'failed' && !end.error?.trim())
			throw new DomainError(
				'error_required',
				`Run ${runId} als „failed“ beenden geht nur mit Fehlertext.`,
				'Gib `error` an: in einem Satz, was schiefging — der Mensch sieht ihn am Run.'
			);
		// Fehlertext kommt von Agent/Provider und kann ein Secret enthalten (ADR studio-011) — vor dem Schreiben maskieren (#824), wie appendEvent es für Event-Payloads schon tut (#819).
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
 * Hängt ein Event an: `seq` lückenlos pro Run (MAX+1 in derselben Schreibtransaktion). Retry-sicher über `key`:
 * dieselbe Anfrage noch einmal liefert die vorhandene seq mit `duplicate: true` — kein zweites Event, kein Bus-Event, kein doppelter Verbrauch.
 */
export function appendEvent(
	db: DatabaseSync,
	actor: Actor,
	runId: number,
	e: { type: RunEventType; payload?: unknown; key?: string; usage?: Usage }
): { seq: number; duplicate: boolean } {
	return tx(db, (emit) => {
		const r = run(db, runId);
		// Secret-Werte maskiert der Secrets-Store (ADR studio-011) hier, bevor der Payload gespeichert und publiziert wird (#819).
		const payload = JSON.stringify(mask(e.payload ?? {}));
		if (e.key !== undefined) {
			const old = db
				.prepare(
					'SELECT seq, type, payload FROM run_events WHERE run_id = ? AND idempotency_key = ?'
				)
				.get(r.id, e.key);
			if (old && old.type === e.type && old.payload === payload)
				return { seq: old.seq as number, duplicate: true };
			if (old)
				throw new DomainError(
					'idempotency_conflict',
					`Run ${r.id} hat unter dem Schlüssel „${e.key}“ schon ein anderes Event (seq ${old.seq}).`,
					'Eine Wiederholung sendet Typ und Payload unverändert; ein neues Event braucht einen neuen Schlüssel.'
				);
		}
		if (r.state !== 'running' && r.state !== 'waiting_approval')
			throw new DomainError(
				'run_not_active',
				`Run ${r.id} ist „${r.state}“ — Events nimmt nur ein laufender Run an.`,
				r.state === 'queued'
					? 'Starte den Run zuerst (startRun).'
					: 'Events vor finishRun schreiben; weitere Arbeit braucht einen neuen Run.'
			);
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
			payload: JSON.parse(payload)
		});
		return { seq, duplicate: false };
	});
}

/** Der laufende Run zu einem Run-Token (Studio-MCP); undefined, wenn unbekannt oder der Run beendet ist. */
export function runForToken(db: DatabaseSync, token: string) {
	return db
		.prepare(
			'SELECT r.id AS runId, r.ticket_id AS ticketId, t.project_id AS projectId FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE r.token_hash = ?'
		)
		.get(hash(token)) as { runId: number; ticketId: number; projectId: number } | undefined;
}

// ponytail: Profil-Änderungen melden kein Bus-Event (StudioEvent verlangt projectId); nachrüsten, wenn die Profil-UI Live-Updates braucht.

/** Profile bestimmen Modell, Rechte und Freigaben der Runs — ein Agent darf sie nicht ändern (sonst könnte er sich selbst Rechte geben). */
function requireNotAgent(actor: Actor) {
	if (actor.kind === 'agent')
		throw new DomainError(
			'requires_human',
			'Agent-Profile ändert nur der Mensch.',
			'Brauchst du ein anderes Profil oder mehr Rechte: Frage als Kommentar, dann in die human_intervention-Spalte.'
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

/** Prüft ein vollständiges Profil. Meldungen wiederholen nie den Wert von api_key_ref — es könnte ein versehentlich eingefügter Key sein. */
function checkProfile(db: DatabaseSync, p: Partial<Profile>, id: number | null) {
	if (p.api_key_ref != null && !/^(secret:\S+|\$\{\w+\})$/.test(p.api_key_ref))
		throw new DomainError(
			'invalid_secret_ref',
			'api_key_ref ist kein Verweis. Erlaubt sind secret:<name> (verschlüsselt gespeichertes Secret) und ${NAME} (Umgebungsvariable); der Key selbst wird hier nie gespeichert.',
			'Speichere den Key als Secret und trage secret:<name> ein.'
		);
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

/** Löscht ein Profil, solange kein aktiver Run es nutzt; beendete Runs behalten ihren Verlauf (agent_profile_id wird NULL). */
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
				'Warte, bis die Runs enden, oder brich sie ab (finishRun mit cancelled).'
			);
		db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
	});
}
