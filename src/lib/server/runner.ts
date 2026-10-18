import type { DatabaseSync } from 'node:sqlite';
import { COLD_START_LIMITS, type ColdStartLimits } from '../agents/model-catalog';
import { isLocalProvider } from '../agents/profile-defaults';
import { DomainError, tx, type Actor } from './domain/core';
import { haltRuns, pauseRun, pauseRuns } from './domain/halt';
import { collectShownAnswer } from './domain/questions';
import { endExecutedRun, failRun } from './domain/run-end';
import { queueUnblockedSuccessors } from './domain/steps';
import {
	appendEvent,
	claimRun,
	finishRun,
	setRunState,
	type Limits,
	type ParkReason,
	type Profile,
	type ResumeReason
} from './domain/runs';
import { publish, subscribe } from './events';
import type {
	ApprovalDecision,
	ApprovalRequest,
	Executor,
	ExecutorIo,
	PhaseName,
	PhaseReport,
	RunContext
} from './executors/contract';
import { mask } from './secrets';

/**
 * The one source of the run limits. The claim and every wait reason call it again each time, so a change takes effect on the
 * next claim. A pool without an entry gets `DEFAULT_POOL_SLOTS`.
 */
// ponytail: fixed values until there is a settings table and per-column overrides; 3 cloud runs plus 1 local GPU run.
export function limits(): Limits {
	return { global: 4, pools: { cloud: 3, local: 1 } };
}

const SYSTEM: Actor = { kind: 'system' };
const PREDECESSOR_EVENTS = new Set(['ticket.moved', 'ticket.review_approved']);
const WAKING_EVENTS = new Set(['run.created', 'run.state_changed', 'runner.released']);
const MODEL_LOADING_PHASES: PhaseName[] = ['model_loading', 'model_downloading'];
const MAX_LAST_LINE = 120;
const PHASE_INTERVAL_MS = 1000;
// setTimeout fires at once beyond this delay; waking early only sets the timer again
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const duration = (ms: number) =>
	ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

type RunControls = { cancel: AbortController; park: AbortController };
/** A decision on an approval request and who made it; the run's trace shows both. */
export type Approval = { decision: Exclude<ApprovalDecision, 'cancelled'>; by: string };
/** Decides an approval request of a run. The runner records request and decision and stops waiting once the run ends. */
export type ApprovalPolicy = (run: RunContext, request: ApprovalRequest) => Promise<Approval>;
/** Until the human answers approval requests, every tool call that asks is refused. */
const rejectByDefault: ApprovalPolicy = async () => ({ decision: 'reject', by: 'policy_default' });
type RunnerOptions = { approve?: ApprovalPolicy };
/** Live progress of a run as the bus carries it in `run.phase`. */
type Phase = {
	name: PhaseName;
	elapsedMs: number;
	tokens?: number;
	tokensPerSecond?: number;
	lastLine?: string;
};
/** Tokens of one phase within a step, counted from its first report. */
type TokenMeter = { tokens: number; since: number };
type StepMeters = {
	number: number;
	startedAt: number;
	meters: Partial<Record<PhaseName, TokenMeter>>;
};

function failOrphanedRuns(db: DatabaseSync) {
	const orphaned = db
		.prepare(
			"SELECT id, ticket_id FROM runs WHERE state IN ('running', 'waiting_approval') ORDER BY id"
		)
		.all() as { id: number; ticket_id: number }[];
	for (const run of orphaned)
		failRun(
			db,
			run.id,
			run.ticket_id,
			new DomainError(
				'server_restart',
				'Server-Neustart — der Run lief noch, als Studio beendet wurde.',
				'Starte einen neuen Run für das Ticket.'
			)
		);
}

function executorFor(
	executors: Partial<Record<Profile['executor'], Executor>>,
	profile: Profile
): Executor {
	const executor = executors[profile.executor];
	if (executor) return executor;
	const installed = Object.keys(executors);
	throw new DomainError(
		'executor_unavailable',
		`Für „${profile.executor}“-Profile ist kein Executor installiert.`,
		installed.length
			? `Wähle ein Profil mit einem installierten Executor: ${installed.join(', ')}.`
			: 'In dieser Version ist noch kein Executor installiert — Runs lassen sich noch nicht ausführen.'
	);
}

/**
 * Until the model's first answer a silent run is loading or downloading its model, not hanging: after the soft threshold
 * it reports the loading phase, after the hard limit it fails. Returns the function that ends the watch.
 */
function watchColdStart(
	db: DatabaseSync,
	run: RunContext,
	controller: AbortController,
	coldStart: ColdStartLimits
) {
	const reportLoading = setTimeout(() => {
		const hint = `Das Modell hat nach ${duration(coldStart.hintAfterMs)} noch nicht geantwortet — es wird geladen oder heruntergeladen. Warten oder den Run abbrechen; nach ${duration(coldStart.failAfterMs)} schlägt der Run mit model_loading_timeout fehl.`;
		const payload = { phase: 'model_loading', text: 'Modell wird geladen …', hint };
		try {
			appendEvent(db, { kind: 'system', runId: run.id }, run.id, {
				type: 'log',
				payload,
				key: 'model_loading'
			});
		} catch (err) {
			console.error(`Runner: Ladephase von Run ${run.id} nicht gemeldet:`, err);
		}
	}, coldStart.hintAfterMs);
	const failLoading = setTimeout(() => {
		const model = run.profile.model ?? run.profile.name;
		const timeout = new DomainError(
			'model_loading_timeout',
			`Das Modell „${model}“ hat nach ${duration(coldStart.failAfterMs)} noch nicht geantwortet.`,
			'Im Log des Modell-Servers prüfen, ob er das Modell laden bzw. herunterladen kann, dann einen neuen Run starten.'
		);
		try {
			failRun(db, run.id, run.ticketId, timeout);
		} catch (err) {
			console.error(`Runner: Run ${run.id} nach Lade-Timeout nicht beendet:`, err);
		}
		controller.abort(); // after failRun, so the executor's late end is ignored like after a cancel
	}, coldStart.failAfterMs);
	// unref: a model that is still loading must not keep a stopping server alive
	[reportLoading, failLoading].forEach((timer) => timer.unref());
	const end = () => [reportLoading, failLoading].forEach(clearTimeout);
	controller.signal.addEventListener('abort', end); // a cancelled run is over even if its executor never settles
	return end;
}

function publishPhase(run: RunContext, phase: Phase) {
	const masked = mask(phase); // before cutting the line, so a secret cut in half is still recognised
	const lastLine = masked.lastLine?.slice(0, MAX_LAST_LINE);
	publish({
		...masked,
		lastLine,
		type: 'run.phase',
		projectId: run.projectId,
		ticketId: run.ticketId,
		actor: { kind: 'agent', runId: run.id },
		runId: run.id
	});
}

const tokensPerSecond = ({ tokens, since }: TokenMeter, now: number) =>
	tokens > 0 && now > since ? Math.round((tokens * 1000) / (now - since)) : undefined;

function lastCompleteLine(text: string) {
	const completeLines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
	return completeLines
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
}

/**
 * Counts the phase reports of a run per step and phase and publishes at most one a second, the first at once: an
 * executor may report every streamed chunk, about 30 a second.
 */
function phasePacer(run: RunContext) {
	let step: StepMeters | undefined;
	let publishedAt = -Infinity;
	return (report: PhaseReport) => {
		const now = Date.now();
		if (step?.number !== report.step) step = { number: report.step, startedAt: now, meters: {} };
		const meter = (step.meters[report.name] ??= { tokens: 0, since: now });
		meter.tokens += report.tokens ?? 1;
		if (now - publishedAt < PHASE_INTERVAL_MS) return;
		publishedAt = now;
		publishPhase(run, {
			name: report.name,
			elapsedMs: now - step.startedAt,
			tokens: meter.tokens || undefined,
			tokensPerSecond: tokensPerSecond(meter, now),
			lastLine: lastCompleteLine(report.text ?? '')
		});
	};
}

/** Settles with the promise, or with undefined once the signal fires: an ended run stops waiting even if it never settles. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	const aborted = Promise.withResolvers<undefined>();
	const onAbort = () => aborted.resolve(undefined);
	signal.addEventListener('abort', onAbort, { once: true });
	return Promise.race([promise, aborted.promise]).finally(() =>
		signal.removeEventListener('abort', onAbort)
	);
}

/**
 * Records each request and its decision as run events and holds the run in `waiting_approval` while any request is
 * open. Cancel and pause end the run themselves, so a request that waits then resolves `cancelled` and writes nothing.
 */
function approvalFor(
	db: DatabaseSync,
	run: RunContext,
	signal: AbortSignal,
	approve: ApprovalPolicy,
	showSignOfLife: () => void
): ExecutorIo['approval'] {
	const agent: Actor = { kind: 'agent', runId: run.id };
	const decider: Actor = { kind: 'system', runId: run.id };
	let open = 0;
	return async (request) => {
		if (signal.aborted) return 'cancelled';
		const { key, kind, title, input } = request;
		tx(db, () => {
			if (open === 0) setRunState(db, agent, run.id, 'waiting_approval');
			const payload = { kind, title, input };
			appendEvent(db, agent, run.id, {
				type: 'permission_request',
				key: `${key}:permission`,
				payload
			});
		});
		open += 1;
		showSignOfLife();
		const approval = await unlessAborted(approve(run, request), signal);
		if (!approval || signal.aborted) return 'cancelled';
		open -= 1;
		tx(db, () => {
			const decision = { type: 'permission_decision' as const, key: `${key}:decision` };
			appendEvent(db, decider, run.id, { ...decision, payload: approval });
			if (open === 0) setRunState(db, decider, run.id, 'running');
		});
		return approval.decision;
	};
}

function ioFor(
	db: DatabaseSync,
	run: RunContext,
	controls: RunControls,
	endColdStart: () => void,
	approve: ApprovalPolicy
): ExecutorIo {
	let answerCollected = false;
	const showSignOfLife = () => {
		endColdStart();
		if (answerCollected) return;
		answerCollected = true;
		collectShownAnswer(db, run.id);
	};
	const pacePhase = phasePacer(run);
	return {
		signal: controls.cancel.signal,
		park: controls.park.signal,
		emit: (event) => {
			if (event.type !== 'log') endColdStart();
			const appended = appendEvent(db, { kind: 'agent', runId: run.id }, run.id, event);
			if (event.type !== 'log') showSignOfLife();
			return appended;
		},
		phase: (report) => {
			if (controls.cancel.signal.aborted) return; // the run has ended, a late phase must not show it working again
			// before pacing: a report the pacer holds back is still the model's first answer
			if (!MODEL_LOADING_PHASES.includes(report.name)) showSignOfLife();
			pacePhase(report);
		},
		approval: approvalFor(db, run, controls.cancel.signal, approve, showSignOfLife)
	};
}

function nextNotBefore(db: DatabaseSync, now: Date) {
	const { next } = db
		.prepare("SELECT min(not_before) AS next FROM runs WHERE state = 'queued' AND not_before > ?")
		.get(now.toISOString()) as { next: string | null };
	return next;
}

export type RunnerHandle = ReturnType<typeof startRunner>;

let started: RunnerHandle | undefined;

/** The runner this server process started; routes cancel, park and halt runs through it. */
export function runner(): RunnerHandle {
	if (!started) throw new Error('The runner has not been started; the init hook starts it.');
	return started;
}

/** A failure of the follow-up must not reach whoever moved the ticket, nor stop the other tickets. */
function continueSuccessors(db: DatabaseSync, ticketId: number) {
	try {
		queueUnblockedSuccessors(db, ticketId);
	} catch (err) {
		console.error('continuing the successors of a ticket failed', err);
	}
}

/** The hook runs after the move committed; a process that died in between left its successors waiting. */
function continueInterruptedChains(db: DatabaseSync) {
	const predecessors = db
		.prepare("SELECT DISTINCT from_ticket_id AS id FROM ticket_relations WHERE type = 'blocks'")
		.all() as { id: number }[];
	for (const { id } of predecessors) continueSuccessors(db, id);
}

/**
 * Fails runs left active by the previous server process and continues chains that stopped at a predecessor, then claims
 * queued runs whenever a run is created or ends, when the earliest held-back run (`not_before`) becomes claimable and
 * when the kill switch is released.
 * Start it once per data directory: it treats every active run as orphaned, which the single-instance lock guarantees.
 * The handle stays reachable through {@link runner}.
 */
export function startRunner(
	db: DatabaseSync,
	executors: Partial<Record<Profile['executor'], Executor>>,
	readLimits: () => Limits = limits,
	coldStart: ColdStartLimits = COLD_START_LIMITS,
	{ approve = rejectByDefault }: RunnerOptions = {}
) {
	const instance = new Runner(db, executors, readLimits, coldStart, approve);
	failOrphanedRuns(db);
	continueInterruptedChains(db);
	instance.start();
	const handle = {
		/** Cancels a queued, running or waiting run; throws `invalid_run_transition` once the run has ended. */
		cancel: (runId: number, actor: Actor = { kind: 'user' }) => instance.cancel(runId, actor),
		/** Asks a running run to end cleanly after its current step; false when no executor of this runner works on it. */
		park: (runId: number, reason: ParkReason['reason'], notBefore?: string) =>
			instance.park(runId, reason, notBefore),
		/** The kill switch (`:stop`): cancels every active run and returns them; queued runs wait until `resumeAll`. Human only. */
		halt: (actor: Actor = { kind: 'user' }) => instance.abortAfter(haltRuns(db, actor)),
		/** Pauses one running run at once, to be resumed by the human; other runs go on. Human only. */
		pause: (runId: number, actor: Actor = { kind: 'user' }) => {
			pauseRun(db, actor, runId);
			instance.abortAfter([runId]);
		},
		/** Pauses every active run and returns them; queued runs wait until `resumeAll`. Human only. */
		pauseAll: (actor: Actor = { kind: 'user' }) => instance.abortAfter(pauseRuns(db, actor)),
		/** Re-checks queued runs now, e.g. after `not_before` changed outside the normal write path. */
		wake: () => instance.wake(),
		/** Stops claiming; executors already running finish on their own. */
		stop: () => instance.stop()
	};
	started = handle;
	return handle;
}

class Runner {
	private readonly db: DatabaseSync;
	private readonly executors: Partial<Record<Profile['executor'], Executor>>;
	private readonly readLimits: () => Limits;
	private readonly coldStart: ColdStartLimits;
	private readonly approve: ApprovalPolicy;
	private readonly active = new Map<number, RunControls>();
	private stopped = false;
	private wakeScheduled = false;
	private notBeforeTimer: NodeJS.Timeout | undefined;
	private unsubscribe = () => {};

	constructor(
		db: DatabaseSync,
		executors: Partial<Record<Profile['executor'], Executor>>,
		readLimits: () => Limits,
		coldStart: ColdStartLimits,
		approve: ApprovalPolicy
	) {
		this.db = db;
		this.executors = executors;
		this.readLimits = readLimits;
		this.coldStart = coldStart;
		this.approve = approve;
	}

	start() {
		this.unsubscribe = subscribe((event) => {
			if (WAKING_EVENTS.has(event.type)) this.wake();
			if (PREDECESSOR_EVENTS.has(event.type) && typeof event.ticketId === 'number')
				queueMicrotask(() => continueSuccessors(this.db, event.ticketId as number));
		});
		this.claimQueuedRuns();
	}

	cancel(runId: number, actor: Actor) {
		finishRun(this.db, actor, runId, { state: 'cancelled' }); // revokes the token before the executor sees the signal
		this.active.get(runId)?.cancel.abort();
	}

	/** Aborts the executors of runs that have already ended, so their tokens are revoked before they see the signal. */
	abortAfter(endedRuns: number[]) {
		for (const runId of endedRuns) this.active.get(runId)?.cancel.abort();
		return endedRuns;
	}

	park(runId: number, reason: ParkReason['reason'], notBefore?: string) {
		const park = this.active.get(runId)?.park;
		park?.abort({ reason, notBefore } satisfies ParkReason);
		return park !== undefined;
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.notBeforeTimer);
		this.unsubscribe();
	}

	private async execute(run: RunContext) {
		const controls = { cancel: new AbortController(), park: new AbortController() };
		this.active.set(run.id, controls);
		const endColdStart = isLocalProvider(run.profile.provider)
			? watchColdStart(this.db, run, controls.cancel, this.coldStart)
			: () => {}; // a cloud model has no "loading" phase; its own first-chunk timeout covers a silent provider
		try {
			const io = ioFor(this.db, run, controls, endColdStart, this.approve);
			const facts = await executorFor(this.executors, run.profile).execute(run, io);
			if (!controls.cancel.signal.aborted)
				endExecutedRun(this.db, run, facts, controls.park.signal.reason);
		} catch (err) {
			// after cancel() the run has already ended
			if (!controls.cancel.signal.aborted) failRun(this.db, run.id, run.ticketId, err);
		} finally {
			endColdStart();
			this.active.delete(run.id);
			this.wake(); // deleting the ticket removes the run without any event, so the executor's end has to free the slot
		}
	}

	private claimQueuedRuns() {
		try {
			const now = new Date(); // the claims and the timer share one instant, so a not_before between two clock reads cannot fall through both
			const next = () =>
				this.stopped ? undefined : claimRun(this.db, SYSTEM, this.readLimits(), now);
			for (let run = next(); run; run = next()) {
				const runId = run.id;
				this.execute(run).catch((err) =>
					console.error(`Runner: Run ${runId} nicht sauber beendet:`, err)
				);
			}
			this.wakeAtNextNotBefore(now);
		} catch (err) {
			console.error('Runner: Claim fehlgeschlagen:', err);
		} finally {
			this.wakeScheduled = false;
		}
	}

	// ponytail: no polling — run events, executor ends and the not_before timer wake the runner; a failed claim (e.g. database locked) waits for the next wake-up.
	wake() {
		if (this.stopped || this.wakeScheduled) return;
		this.wakeScheduled = true;
		queueMicrotask(() => this.claimQueuedRuns()); // not inside the stack of whoever just created or ended a run
	}

	/** Set again after every claim from the database, so a held-back run survives a restart. */
	private wakeAtNextNotBefore(now: Date) {
		clearTimeout(this.notBeforeTimer);
		const next = this.stopped ? null : nextNotBefore(this.db, now);
		if (!next) return;
		const delay = Math.min(Date.parse(next) - Date.now(), MAX_TIMER_DELAY_MS);
		this.notBeforeTimer = setTimeout(() => this.wake(), delay);
		this.notBeforeTimer.unref(); // a held-back run must not keep a stopping server alive
	}
}
