import type { DatabaseSync } from 'node:sqlite';
import { COLD_START_LIMITS, type ColdStartLimits } from '../agents/model-catalog';
import { addComment } from './domain/board';
import { DomainError, tx, type Actor } from './domain/core';
import { requestHuman } from './domain/questions';
import {
	appendEvent,
	claimRun,
	createRun,
	finishRun,
	freshRunsInChain,
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
export type ParkReason = { reason: ResumeReason; notBefore?: string };
/** Continues a paused run in a new run; `handoffSeq` is the event holding the handoff of the paused run. */
export type Resume = ParkReason & { handoffSeq: number };
export type ExecutorResult =
	| { state?: 'succeeded'; usage?: Usage }
	| { state: 'paused'; usage?: Usage; resume?: Resume }
	| void;
export type ExecutorIo = {
	/** Fires on cancel: the run is already `cancelled` by then and `emit` throws `run_not_active`. */
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
// ponytail: one fresh run per chain of resumes, then the human decides; configurable once practice asks for it.
export const FRESH_RUNS_PER_CHAIN = 1;

const SYSTEM: Actor = { kind: 'system' };
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
	if (resume.reason === 'quota' || freshRunsInChain(db, run.id) < FRESH_RUNS_PER_CHAIN) {
		createRun(db, actor, {
			ticketId: run.ticketId,
			profileId: run.profile.id,
			resumedFromRunId: run.id,
			resumeReason: resume.reason,
			notBefore: resume.notBefore
		});
		return;
	}
	askHumanAfterUsedUpChain(db, actor, run, resume.reason, resume.handoffSeq);
}

/** Stage 3 of the recovery; if the board cannot take the question, the failed run carries it and a way out for the human. */
function askHumanAfterUsedUpChain(
	db: DatabaseSync,
	actor: Actor,
	run: RunContext,
	reason: FreshRunReason,
	handoffSeq: number
) {
	const stuck = `Run ${run.id} kommt nicht weiter (${FRESH_RUN_REASON_TEXT[reason]}), und seine Kette hat ihren frischen Run schon verbraucht (höchstens ${FRESH_RUNS_PER_CHAIN} je Kette).`;
	const handoff = `Handoff von Run ${run.id} (Event ${handoffSeq})`;
	try {
		requestHuman(db, actor, run.ticketId, {
			question: `${stuck} Den Stand beschreibt der ${handoff}. Wie soll es weitergehen?`
		});
	} catch (err) {
		if (!(err instanceof DomainError) || err.code !== 'no_escalation_column') throw err;
		throw new DomainError(
			err.code,
			`${stuck} Die Frage an den Menschen ging nicht: ${err.message}`,
			`Lege im Board eine human_intervention-Spalte an und starte einen neuen Run für das Ticket; den Stand beschreibt der ${handoff}.`
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

/**
 * Fails runs left active by the previous server process, then claims queued runs whenever a run is created or ends,
 * and when the earliest held-back run (`not_before`) becomes claimable.
 * Start it once per data directory: it treats every active run as orphaned, which the single-instance lock guarantees.
 */
export function startRunner(
	db: DatabaseSync,
	executors: Partial<Record<Profile['executor'], Executor>>,
	limits = LIMITS,
	coldStart: ColdStartLimits = COLD_START_LIMITS
) {
	const active = new Map<number, RunControls>();
	let stopped = false;
	let wakeScheduled = false;
	let notBeforeTimer: NodeJS.Timeout | undefined;

	async function execute(run: RunContext) {
		const controls = { cancel: new AbortController(), park: new AbortController() };
		active.set(run.id, controls);
		const endColdStart = watchColdStart(db, run, controls.cancel, coldStart);
		try {
			const result =
				(await executorFor(executors, run.profile).execute(
					run,
					ioFor(db, run, controls, endColdStart)
				)) ?? {};
			if (!controls.cancel.signal.aborted) finishExecutedRun(db, run, result);
		} catch (err) {
			if (!controls.cancel.signal.aborted) failRun(db, run.id, run.ticketId, err); // after cancel() the run has already ended
		} finally {
			endColdStart();
			active.delete(run.id);
			wake(); // deleting the ticket removes the run without any event, so the executor's end has to free the slot
		}
	}

	function claimQueuedRuns() {
		try {
			const next = () => (stopped ? undefined : claimRun(db, SYSTEM, limits));
			for (let run = next(); run; run = next()) {
				const runId = run.id;
				execute(run).catch((err) =>
					console.error(`Runner: Run ${runId} nicht sauber beendet:`, err)
				);
			}
			wakeAtNextNotBefore();
		} catch (err) {
			console.error('Runner: Claim fehlgeschlagen:', err);
		} finally {
			wakeScheduled = false;
		}
	}

	// ponytail: no polling — run events, executor ends and the not_before timer wake the runner; a failed claim (e.g. database locked) waits for the next wake-up.
	function wake() {
		if (stopped || wakeScheduled) return;
		wakeScheduled = true;
		queueMicrotask(claimQueuedRuns); // not inside the stack of whoever just created or ended a run
	}

	/** Set again after every claim from the database, so a held-back run survives a restart. */
	function wakeAtNextNotBefore() {
		clearTimeout(notBeforeTimer);
		const next = stopped ? null : nextNotBefore(db, new Date());
		if (!next) return;
		notBeforeTimer = setTimeout(wake, Math.min(Date.parse(next) - Date.now(), MAX_TIMER_DELAY_MS));
		notBeforeTimer.unref(); // a held-back run must not keep a stopping server alive
	}

	failOrphanedRuns(db);
	const unsubscribe = subscribe((event) => {
		if (event.type === 'run.created' || event.type === 'run.state_changed') wake();
	});
	claimQueuedRuns();

	return {
		/** Cancels a queued, running or waiting run; throws `invalid_run_transition` once the run has ended. */
		cancel(runId: number, actor: Actor = { kind: 'user' }) {
			finishRun(db, actor, runId, { state: 'cancelled' }); // revokes the token before the executor sees the signal
			active.get(runId)?.cancel.abort();
		},
		/** Asks a running run to end cleanly after its current step; false when no executor of this runner works on it. */
		park(runId: number, reason: ResumeReason, notBefore?: string) {
			const park = active.get(runId)?.park;
			park?.abort({ reason, notBefore } satisfies ParkReason);
			return park !== undefined;
		},
		/** Stops claiming; executors already running finish on their own. */
		stop() {
			stopped = true;
			clearTimeout(notBeforeTimer);
			unsubscribe();
		}
	};
}
