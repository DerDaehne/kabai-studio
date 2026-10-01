import type { DatabaseSync } from 'node:sqlite';
import { COLD_START_LIMITS, type ColdStartLimits } from '../agents/model-catalog';
import { addComment } from './domain/board';
import { DomainError, type Actor } from './domain/core';
import { appendEvent, claimRun, finishRun, type Limits, type Profile, type Usage } from './domain/runs';
import { subscribe } from './events';
import { mask } from './secrets';

export type RunContext = { id: number; ticketId: number; token: string; profile: Profile };
type EmitRunEvent = (event: Parameters<typeof appendEvent>[3]) => { seq: number; duplicate: boolean };
type ExecutorResult = { state?: 'succeeded' | 'paused'; usage?: Usage } | void;
export type Executor = {
	/**
	 * Resolving ends the run (default `succeeded`); throwing fails it, and a thrown DomainError supplies code and hint.
	 * `signal` fires on cancel: the run is already `cancelled` by then and `emit` throws `run_not_active`.
	 * Until the first event other than `log` the runner treats the model as loading and applies the cold start limits,
	 * so an executor's own inactivity timeout should only start after the model's first byte.
	 */
	execute(run: RunContext, io: { signal: AbortSignal; emit: EmitRunEvent }): Promise<ExecutorResult>;
};

// ponytail: fixed limits until there is a settings table and per-column overrides; 3 cloud runs plus 1 local GPU run.
export const LIMITS: Limits = { global: 4, pools: { cloud: 3, local: 1 } };

const SYSTEM: Actor = { kind: 'system' };

const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/**
 * Fails runs left active by the previous server process, then claims queued runs whenever a run is created or ends.
 * Start it once per data directory: it treats every active run as orphaned, which the single-instance lock guarantees.
 */
export function startRunner(
	db: DatabaseSync,
	executors: Partial<Record<Profile['executor'], Executor>>,
	limits = LIMITS,
	coldStart: ColdStartLimits = COLD_START_LIMITS
) {
	const controllers = new Map<number, AbortController>();
	let stopped = false;
	let wakeScheduled = false;

	function failRun(runId: number, ticketId: number, err: unknown) {
		const code = err instanceof DomainError ? err.code : 'executor_error';
		const hint = err instanceof DomainError ? err.hint : 'Run-Log prüfen, Ursache beheben und einen neuen Run starten.';
		const error = `[${code}] ${err instanceof Error ? err.message : String(err)}`;
		finishRun(db, SYSTEM, runId, { state: 'failed', error });
		// ponytail: two transactions — a crash in between loses only the comment, the run is already failed.
		addComment(db, { kind: 'system', runId }, ticketId, mask(`Run ${runId} ist fehlgeschlagen: ${error}\nAusweg: ${hint}`));
	}

	function failOrphanedRuns() {
		const orphaned = db.prepare("SELECT id, ticket_id FROM runs WHERE state IN ('running', 'waiting_approval') ORDER BY id").all() as { id: number; ticket_id: number }[];
		for (const run of orphaned)
			failRun(run.id, run.ticket_id, new DomainError('server_restart', 'Server-Neustart — der Run lief noch, als Studio beendet wurde.', 'Starte einen neuen Run für das Ticket.'));
	}

	function executorFor(profile: Profile): Executor {
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
	function watchColdStart(run: RunContext, controller: AbortController) {
		const reportLoading = setTimeout(() => {
			const hint = `Das Modell hat nach ${duration(coldStart.hintAfterMs)} noch nicht geantwortet — es wird geladen oder heruntergeladen. Warten oder den Run abbrechen; nach ${duration(coldStart.failAfterMs)} schlägt der Run mit model_loading_timeout fehl.`;
			const payload = { phase: 'model_loading', text: 'Modell wird geladen …', hint };
			try {
				appendEvent(db, { kind: 'system', runId: run.id }, run.id, { type: 'log', payload, key: 'model_loading' });
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
				failRun(run.id, run.ticketId, timeout);
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

	async function execute(run: RunContext) {
		const controller = new AbortController();
		controllers.set(run.id, controller);
		const endColdStart = watchColdStart(run, controller);
		try {
			const emit: EmitRunEvent = (event) => {
				if (event.type !== 'log') endColdStart();
				return appendEvent(db, { kind: 'agent', runId: run.id }, run.id, event);
			};
			const result = (await executorFor(run.profile).execute(run, { signal: controller.signal, emit })) ?? {};
			if (!controller.signal.aborted) finishRun(db, SYSTEM, run.id, { state: result.state ?? 'succeeded', usage: result.usage });
		} catch (err) {
			if (!controller.signal.aborted) failRun(run.id, run.ticketId, err); // after cancel() the run has already ended
		} finally {
			endColdStart();
			controllers.delete(run.id);
			wake(); // deleting the ticket removes the run without any event, so the executor's end has to free the slot
		}
	}

	function claimQueuedRuns() {
		try {
			const next = () => (stopped ? undefined : claimRun(db, SYSTEM, limits));
			for (let run = next(); run; run = next()) {
				const runId = run.id;
				execute(run).catch((err) => console.error(`Runner: Run ${runId} nicht sauber beendet:`, err));
			}
		} catch (err) {
			console.error('Runner: Claim fehlgeschlagen:', err);
		} finally {
			wakeScheduled = false;
		}
	}

	// ponytail: no polling — run events and executor ends wake the runner; a failed claim (e.g. database locked) waits for the next wake-up.
	function wake() {
		if (stopped || wakeScheduled) return;
		wakeScheduled = true;
		queueMicrotask(claimQueuedRuns); // not inside the stack of whoever just created or ended a run
	}

	failOrphanedRuns();
	const unsubscribe = subscribe((event) => {
		if (event.type === 'run.created' || event.type === 'run.state_changed') wake();
	});
	claimQueuedRuns();

	return {
		/** Cancels a queued, running or waiting run; throws `invalid_run_transition` once the run has ended. */
		cancel(runId: number, actor: Actor = { kind: 'user' }) {
			finishRun(db, actor, runId, { state: 'cancelled' }); // revokes the token before the executor sees the signal
			controllers.get(runId)?.abort();
		},
		/** Stops claiming; executors already running finish on their own. */
		stop() {
			stopped = true;
			unsubscribe();
		}
	};
}
