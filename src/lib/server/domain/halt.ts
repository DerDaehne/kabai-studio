import type { DatabaseSync } from 'node:sqlite';
import { addComment } from './board';
import { DomainError, tx, type Actor } from './core';
import { awaitsResume, createRun, finishRun, prioritizeRun, type RunState } from './runs';

// Re-exported so existing importers (live.ts, ticket-view.ts) keep working unchanged: the condition itself moved to
// runs.ts, since deleteProfile needs it there without an import cycle back to this module.
export { awaitsResume };

/** `stop` cancelled the active runs, `pause` paused them so they can be resumed; both hold the queue. */
export type HaltKind = 'stop' | 'pause';

type ActiveRun = { id: number; ticket_id: number };
type HaltedRun = {
	id: number;
	ticket_id: number;
	state: RunState;
	halted: 0 | 1;
	agent_profile_id: number | null;
	continuedBy: number | null;
};

const NOT_AUS_REFUSED_HINT =
	'Läuft etwas aus dem Ruder: Frage als Kommentar, dann in die human_intervention-Spalte — der Mensch entscheidet über den Not-Aus.';
const PAUSE_REFUSED_HINT =
	'Läuft etwas aus dem Ruder: Frage als Kommentar, dann in die human_intervention-Spalte — der Mensch entscheidet, ob Runs anhalten.';
const RESUME_WAY_OUT = ':fortsetzen zeigt die angehaltenen Runs; :fortsetzen all setzt alle fort.';

/** Stopping, pausing and resuming agents is the human's control over them, so no agent may do it. */
function requireHuman(actor: Actor, message: string, hint: string) {
	if (actor.kind === 'user') return;
	throw new DomainError('requires_human', message, hint);
}

const requireHumanToPause = (actor: Actor) =>
	requireHuman(actor, 'Runs hält nur der Mensch an.', PAUSE_REFUSED_HINT);
const requireHumanToResume = (actor: Actor) =>
	requireHuman(actor, 'Angehaltene Runs setzt nur der Mensch fort.', PAUSE_REFUSED_HINT);

const AWAITING_RESUME = `SELECT id FROM runs r WHERE ${awaitsResume('r')} ORDER BY id`;

const HALT_LOCK_ATTEMPTS = 3;

/**
 * Retries `fn` while it throws SQLITE_BUSY (errcode 5): a concurrent writer can keep re-grabbing the write lock
 * faster than one BEGIN IMMEDIATE's busy_timeout waits it out. A few bounded retries ride out that unlucky timing
 * instead of failing for a contention window that is routinely gone a moment later.
 */
function retryOnLockContention<T>(attempts: number, fn: () => T): T {
	try {
		return fn();
	} catch (err) {
		const lockContention = (err as { errcode?: number }).errcode === 5;
		if (!lockContention || attempts <= 1) throw err;
		return retryOnLockContention(attempts - 1, fn);
	}
}

/**
 * The kill switch (`:stop`): cancels every active run and keeps queued runs waiting until {@link resumeAll}. Returns the
 * cancelled runs, whose executors the runner still has to abort. Setting the switch and picking the active runs share one
 * write transaction with the claim's halt check, so a concurrent claim either started its run before (cancelled here) or starts none.
 */
export function haltRuns(db: DatabaseSync, actor: Actor): number[] {
	return retryOnLockContention(HALT_LOCK_ATTEMPTS, () => haltActive(db, actor, 'stop'));
}

/** `:anhalten` outside a Run-Akte: like {@link haltRuns}, but the active runs end paused and can be resumed. */
export function pauseRuns(db: DatabaseSync, actor: Actor): number[] {
	return retryOnLockContention(HALT_LOCK_ATTEMPTS, () => haltActive(db, actor, 'pause'));
}

// A stop turns a pause into a stop, a pause leaves a stop as it is; either keeps the moment of the first halt.
const SET_HALT: Record<HaltKind, string> = {
	stop: "INSERT INTO runner_halt (id, kind) VALUES (1, 'stop') ON CONFLICT (id) DO UPDATE SET kind = 'stop'",
	pause: "INSERT OR IGNORE INTO runner_halt (id, kind) VALUES (1, 'pause')"
};
const REQUIRE_HUMAN_TO: Record<HaltKind, (actor: Actor) => void> = {
	stop: (actor) => requireHuman(actor, 'Den Not-Aus setzt nur der Mensch.', NOT_AUS_REFUSED_HINT),
	pause: requireHumanToPause
};
const END_ACTIVE_RUN: Record<HaltKind, (db: DatabaseSync, actor: Actor, run: ActiveRun) => void> = {
	stop: cancelForHalt,
	pause: (db, actor, run) => pauseForHuman(db, actor, run.id)
};

function haltActive(db: DatabaseSync, actor: Actor, kind: HaltKind): number[] {
	return tx(db, (emit) => {
		REQUIRE_HUMAN_TO[kind](actor);
		db.prepare(SET_HALT[kind]).run();
		emit({ type: 'runner.halted', actor });
		const active = db
			.prepare(
				"SELECT id, ticket_id FROM runs WHERE state IN ('running', 'waiting_approval') ORDER BY id"
			)
			.all() as ActiveRun[];
		for (const run of active) END_ACTIVE_RUN[kind](db, actor, run);
		return active.map((run) => run.id);
	});
}

function cancelForHalt(db: DatabaseSync, actor: Actor, run: ActiveRun) {
	finishRun(db, actor, run.id, { state: 'cancelled' });
	addComment(
		db,
		{ kind: 'system', runId: run.id },
		run.ticket_id,
		`Run ${run.id} wurde durch den Not-Aus (:stop) abgebrochen.\nAusweg: Nach dem Fortsetzen (:fortsetzen all) einen neuen Run für das Ticket starten (:run).`
	);
}

/** Ends the run at once (its half-done step is dropped); it waits for the human to resume it. */
function pauseForHuman(db: DatabaseSync, actor: Actor, runId: number) {
	finishRun(db, actor, runId, { state: 'paused' });
	db.prepare('UPDATE runs SET halted = 1 WHERE id = ?').run(runId);
}

/** `:anhalten` in a Run-Akte: pauses this one run; other runs and the queue go on. The runner still has to abort its executor. */
export function pauseRun(db: DatabaseSync, actor: Actor, runId: number) {
	tx(db, () => {
		requireHumanToPause(actor);
		const run = db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as
			{ state: RunState } | undefined;
		if (!run)
			throw new DomainError(
				'not_found',
				`Run ${runId} gibt es nicht.`,
				'Die Nummer steht im Run-Reiter der Run-Akte.'
			);
		if (run.state !== 'running' && run.state !== 'waiting_approval')
			throw new DomainError(
				'run_not_active',
				`Run ${runId} ist „${run.state}“ — anhalten lässt sich nur ein laufender Run.`,
				run.state === 'queued'
					? 'Er hat noch nichts getan: brich ihn ab (x), wenn er nicht starten soll.'
					: 'Er hat schon geendet; einen neuen Run startet :run in der Run-Akte.'
			);
		pauseForHuman(db, actor, runId);
	});
}

/**
 * Continues a run the human paused in a new run (resume reason `halt`) that goes ahead of background work, like any run
 * the human starts. Does not lift a halt: only {@link resumeAll} does.
 */
export function resumeRun(db: DatabaseSync, actor: Actor, runId: number): { id: number } {
	return tx(db, () => {
		requireHumanToResume(actor);
		const run = haltedRun(db, runId);
		if (run.agent_profile_id === null)
			throw new DomainError(
				'profile_deleted',
				`Das Agent-Profil von Run ${runId} gibt es nicht mehr.`,
				'Starte in der Run-Akte einen neuen Run mit einem anderen Profil (:run).'
			);
		const { id } = createRun(db, actor, {
			ticketId: run.ticket_id,
			profileId: run.agent_profile_id,
			resumedFromRunId: run.id,
			resumeReason: 'halt'
		});
		prioritizeRun(db, actor, id);
		return { id };
	});
}

function haltedRun(db: DatabaseSync, runId: number): HaltedRun {
	const run = db
		.prepare(
			`SELECT id, ticket_id, state, halted, agent_profile_id,
				(SELECT min(c.id) FROM runs c WHERE c.resumed_from_run_id = r.id) AS continuedBy
			FROM runs r WHERE id = ?`
		)
		.get(runId) as HaltedRun | undefined;
	if (!run) throw new DomainError('not_found', `Run ${runId} gibt es nicht.`, RESUME_WAY_OUT);
	if (run.state !== 'paused' || run.halted !== 1)
		throw new DomainError(
			'run_not_halted',
			`Run ${runId} ist nicht angehalten („${run.state}“) — fortsetzen lässt sich nur ein Run, den :anhalten pausiert hat.`,
			run.state === 'cancelled'
				? 'Ein abgebrochener Run lässt sich nicht fortsetzen; einen neuen startet :run in der Run-Akte.'
				: RESUME_WAY_OUT
		);
	if (run.continuedBy !== null)
		throw new DomainError(
			'already_resumed',
			`Run ${runId} setzt schon in Run ${run.continuedBy} fort.`,
			RESUME_WAY_OUT
		);
	return run;
}

/** A halted run `resumeAll` could not resume, with the reason a client can show next to the ones that did. */
export type SkippedResume = { runId: number; code: string; message: string; hint: string };

/**
 * `:fortsetzen all`: resumes every run the human paused and lifts the halt, whether a stop or a pause. A run that
 * cannot resume (e.g. its profile is gone) is reported instead of blocking the others, so the halt always lifts.
 */
export function resumeAll(
	db: DatabaseSync,
	actor: Actor
): { resumed: number[]; skipped: SkippedResume[] } {
	return tx(db, () => {
		requireHumanToResume(actor);
		const halted = db.prepare(AWAITING_RESUME).all() as { id: number }[];
		const resumed: number[] = [];
		const skipped: SkippedResume[] = [];
		for (const run of halted) {
			try {
				resumed.push(resumeRun(db, actor, run.id).id);
			} catch (err) {
				if (!(err instanceof DomainError)) throw err;
				skipped.push({ runId: run.id, code: err.code, message: err.message, hint: err.hint });
			}
		}
		releaseHalt(db, actor);
		return { resumed, skipped };
	});
}

/** Lets the runner claim queued runs again; it wakes on the `runner.released` event. */
export function releaseHalt(db: DatabaseSync, actor: Actor) {
	tx(db, (emit) => {
		requireHuman(actor, 'Den Not-Aus löst nur der Mensch.', NOT_AUS_REFUSED_HINT);
		db.prepare('DELETE FROM runner_halt').run();
		emit({ type: 'runner.released', actor });
	});
}

/** When the halt was set, or null while runs may start. */
export function haltedSince(db: DatabaseSync): string | null {
	const row = db.prepare('SELECT halted_at FROM runner_halt').get() as
		{ halted_at: string } | undefined;
	return row?.halted_at ?? null;
}

/** Whether the halt stopped or paused the runs, or null while runs may start. */
export function haltKind(db: DatabaseSync): HaltKind | null {
	const row = db.prepare('SELECT kind FROM runner_halt').get() as { kind: HaltKind } | undefined;
	return row?.kind ?? null;
}
