import type { DatabaseSync } from 'node:sqlite';
import { COLD_START_LIMITS, type ColdStartLimits } from '../agents/model-catalog';
import { isLocalProvider } from '../agents/profile-defaults';
import { RECOVERY } from './agents/loop-guard';
import { addComment } from './domain/board';
import { DomainError, tx, type Actor } from './domain/core';
import { haltRuns, pauseRun, pauseRuns } from './domain/halt';
import { requestHuman, type QuestionOption } from './domain/questions';
import {
	appendEvent,
	claimRun,
	createRun,
	finishRun,
	freshRunsInChain,
	type Intervention,
	type Limits,
	type Profile,
	type ResumeReason,
	type Usage
} from './domain/runs';
import { publish, subscribe } from './events';
import { mask } from './secrets';

export type RunContext = {
	id: number;
	ticketId: number;
	projectId: number;
	token: string;
	profile: Profile & { id: number };
};
type EmitRunEvent = (event: Parameters<typeof appendEvent>[3]) => {
	seq: number;
	duplicate: boolean;
};
/** Live progress of a run, published on the bus as `run.phase` and never stored. */
export type Phase = {
	name: 'thinking' | 'writing' | 'tool' | 'compacting' | 'model_loading' | 'model_downloading';
	elapsedMs: number;
	tokens?: number;
	tokensPerSecond?: number;
	/** The last complete line of output; the runner masks it and cuts it to 120 characters. */
	lastLine?: string;
};
/** `io.park.reason`: why the run should end cleanly and, as ISO 8601 time, when its follow-up run may start at the earliest. */
export type ParkReason = { reason: Exclude<ResumeReason, 'halt'>; notBefore?: string };
/** Continues a paused run in a new run; `handoffSeq` is the event holding the handoff of the paused run. */
export type Resume = ParkReason & { handoffSeq: number };
export type ExecutorResult =
	| { state?: 'succeeded'; usage?: Usage }
	| { state: 'paused'; usage?: Usage; resume?: Resume }
	| void;
export type ExecutorIo = {
	/** Fires when the run is cancelled or paused by the human: it has already ended by then and `emit` throws `run_not_active`. */
	signal: AbortSignal;
	/** Fires when the run should end after its current step: resolve `paused` with a `resume` built from `park.reason`. */
	park: AbortSignal;
	emit: EmitRunEvent;
	phase: (phase: Phase) => void;
};
export type Executor = {
	/**
	 * Resolving ends the run (default `succeeded`); `paused` with `resume` queues the run that continues it. Throwing fails the
	 * run, and a thrown DomainError supplies code and hint. Until the first event other than `log` or the first phase other than
	 * model loading the runner treats the model as loading and applies the cold start limits, so an executor's own inactivity
	 * timeout should only start after the model's first byte.
	 */
	execute(run: RunContext, io: ExecutorIo): Promise<ExecutorResult>;
};

// ponytail: fixed limits until there is a settings table and per-column overrides; 3 cloud runs plus 1 local GPU run.
export const LIMITS: Limits = { global: 4, pools: { cloud: 3, local: 1 } };

const SYSTEM: Actor = { kind: 'system' };
const WAKING_EVENTS = new Set(['run.created', 'run.state_changed', 'runner.released']);
const MODEL_LOADING_PHASES: Phase['name'][] = ['model_loading', 'model_downloading'];
const MAX_LAST_LINE = 120;
// setTimeout fires at once beyond this delay; waking early only sets the timer again
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const FRESH_RUN_REASON_TEXT = {
	context_budget: 'Kontext-Budget erreicht',
	recovery: 'Stillstand oder Längenlimit'
};
type FreshRunReason = keyof typeof FRESH_RUN_REASON_TEXT;

const duration = (ms: number) =>
	ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

type RunControls = { cancel: AbortController; park: AbortController };

function failRun(db: DatabaseSync, runId: number, ticketId: number, err: unknown) {
	const code = err instanceof DomainError ? err.code : 'executor_error';
	const hint =
		err instanceof DomainError
			? err.hint
			: 'Run-Log prüfen, Ursache beheben und einen neuen Run starten.';
	const error = `[${code}] ${err instanceof Error ? err.message : String(err)}`;
	finishRun(db, SYSTEM, runId, { state: 'failed', error });
	// ponytail: two transactions — a crash in between loses only the comment, the run is already failed.
	addComment(
		db,
		{ kind: 'system', runId },
		ticketId,
		mask(`Run ${runId} ist fehlgeschlagen: ${error}\nAusweg: ${hint}`)
	);
}

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

function ioFor(
	db: DatabaseSync,
	run: RunContext,
	controls: RunControls,
	endColdStart: () => void
): ExecutorIo {
	return {
		signal: controls.cancel.signal,
		park: controls.park.signal,
		emit: (event) => {
			if (event.type !== 'log') endColdStart();
			return appendEvent(db, { kind: 'agent', runId: run.id }, run.id, event);
		},
		phase: (phase) => {
			if (controls.cancel.signal.aborted) return; // the run has ended, a late phase must not show it working again
			if (!MODEL_LOADING_PHASES.includes(phase.name)) endColdStart();
			publishPhase(run, phase);
		}
	};
}

/** Queues the run that continues a paused one, or asks the human once its chain has used up its fresh runs. */
function continuePausedRun(db: DatabaseSync, run: RunContext, resume: Resume) {
	const actor: Actor = { kind: 'system', runId: run.id };
	if (resume.reason === 'quota' || freshRunsInChain(db, run.id) < RECOVERY.freshRunsPerChain) {
		createRun(db, actor, {
			ticketId: run.ticketId,
			profileId: run.profile.id,
			resumedFromRunId: run.id,
			resumeReason: resume.reason,
			notBefore: resume.notBefore
		});
		return;
	}
	askHumanAfterUsedUpChain(db, actor, run, resume.reason);
}

// Fixed wording, chosen by the human once for every escalation; option 3 ends the chain instead of starting a run.
const ESCALATION_OPTIONS: QuestionOption[] = [
	{ label: 'Neuer Versuch mit frischem Kontext und meinem Hinweis' },
	{ label: 'Aufgabe verkleinern: nur den nächsten prüfbaren Schritt' },
	{ label: 'Aufhören: Stand als Kommentar festhalten, Ticket bleibt beim Menschen', stopsRun: true }
];

function ticketPath(db: DatabaseSync, ticketId: number): string {
	const row = db
		.prepare(
			'SELECT p.key AS key, t.number AS number FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.id = ?'
		)
		.get(ticketId) as { key: string; number: number };
	return `/p/${row.key}/t/${row.number}`;
}

function lastIntervention(db: DatabaseSync, runId: number): Intervention | undefined {
	const row = db
		.prepare(
			"SELECT payload FROM run_events WHERE run_id = ? AND type = 'intervention' ORDER BY seq DESC LIMIT 1"
		)
		.get(runId) as { payload: string } | undefined;
	return row && (JSON.parse(row.payload) as Intervention);
}

/** Stage-1 hints share `max = RECOVERY.hintsPerRun`; the final stage-2 entry that ends the run has a different max. */
function hintsGiven(db: DatabaseSync, runId: number): number {
	const { n } = db
		.prepare(
			"SELECT count(*) AS n FROM run_events WHERE run_id = ? AND type = 'intervention' AND payload ->> '$.max' = ?"
		)
		.get(runId, RECOVERY.hintsPerRun) as { n: number };
	return n;
}

/** If the board cannot take the question, the failed run carries it and a way out for the human. */
function askHumanAfterUsedUpChain(
	db: DatabaseSync,
	actor: Actor,
	run: RunContext,
	reason: FreshRunReason
) {
	const hints = hintsGiven(db, run.id);
	const lastHint = lastIntervention(db, run.id)?.hint;
	const stuck =
		`Run ${run.id} kommt nicht weiter (${FRESH_RUN_REASON_TEXT[reason]}), und seine Kette hat ihren frischen Run schon verbraucht ` +
		`(höchstens ${RECOVERY.freshRunsPerChain} je Kette). ${hints} ${hints === 1 ? 'Hinweis' : 'Hinweise'} in diesem Run` +
		(lastHint ? `, zuletzt: „${lastHint}“` : '') +
		'.';
	const link = `${ticketPath(db, run.ticketId)}?run=${run.id}`;
	try {
		requestHuman(db, actor, run.ticketId, {
			question: `${stuck} Den Stand zeigt die Run-Akte: ${link}. Wie soll es weitergehen?`,
			options: ESCALATION_OPTIONS
		});
	} catch (err) {
		if (!(err instanceof DomainError) || err.code !== 'no_escalation_column') throw err;
		throw new DomainError(
			err.code,
			`${stuck} Die Frage an den Menschen ging nicht: ${err.message}`,
			`Lege im Board eine human_intervention-Spalte an und starte einen neuen Run für das Ticket; Run-Akte: ${link}.`
		);
	}
}

/** One transaction: a paused run never stays without its follow-up run or the question to the human. */
function finishExecutedRun(
	db: DatabaseSync,
	run: RunContext,
	result: Exclude<ExecutorResult, void>
) {
	tx(db, () => {
		finishRun(db, SYSTEM, run.id, { state: result.state ?? 'succeeded', usage: result.usage });
		if (result.state === 'paused' && result.resume) continuePausedRun(db, run, result.resume);
	});
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

/**
 * Fails runs left active by the previous server process, then claims queued runs whenever a run is created or ends,
 * when the earliest held-back run (`not_before`) becomes claimable and when the kill switch is released.
 * Start it once per data directory: it treats every active run as orphaned, which the single-instance lock guarantees.
 * The handle stays reachable through {@link runner}.
 */
export function startRunner(
	db: DatabaseSync,
	executors: Partial<Record<Profile['executor'], Executor>>,
	limits = LIMITS,
	coldStart: ColdStartLimits = COLD_START_LIMITS
) {
	const instance = new Runner(db, executors, limits, coldStart);
	failOrphanedRuns(db);
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
	private readonly limits: Limits;
	private readonly coldStart: ColdStartLimits;
	private readonly active = new Map<number, RunControls>();
	private stopped = false;
	private wakeScheduled = false;
	private notBeforeTimer: NodeJS.Timeout | undefined;
	private unsubscribe = () => {};

	constructor(
		db: DatabaseSync,
		executors: Partial<Record<Profile['executor'], Executor>>,
		limits: Limits,
		coldStart: ColdStartLimits
	) {
		this.db = db;
		this.executors = executors;
		this.limits = limits;
		this.coldStart = coldStart;
	}

	start() {
		this.unsubscribe = subscribe((event) => {
			if (WAKING_EVENTS.has(event.type)) this.wake();
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
			const io = ioFor(this.db, run, controls, endColdStart);
			const result = (await executorFor(this.executors, run.profile).execute(run, io)) ?? {};
			if (!controls.cancel.signal.aborted) finishExecutedRun(this.db, run, result);
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
			const next = () => (this.stopped ? undefined : claimRun(this.db, SYSTEM, this.limits));
			for (let run = next(); run; run = next()) {
				const runId = run.id;
				this.execute(run).catch((err) =>
					console.error(`Runner: Run ${runId} nicht sauber beendet:`, err)
				);
			}
			this.wakeAtNextNotBefore();
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
	private wakeAtNextNotBefore() {
		clearTimeout(this.notBeforeTimer);
		const next = this.stopped ? null : nextNotBefore(this.db, new Date());
		if (!next) return;
		const delay = Math.min(Date.parse(next) - Date.now(), MAX_TIMER_DELAY_MS);
		this.notBeforeTimer = setTimeout(() => this.wake(), delay);
		this.notBeforeTimer.unref(); // a held-back run must not keep a stopping server alive
	}
}
