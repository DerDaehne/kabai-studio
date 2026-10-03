import type { DatabaseSync } from 'node:sqlite';
import { addComment } from './board';
import { DomainError, tx, type Actor } from './core';
import { finishRun } from './runs';

type ActiveRun = { id: number; ticket_id: number };

/** Stopping every agent is the human's emergency brake, so no agent may pull or release it. */
function requireHuman(actor: Actor, verb: 'setzt' | 'löst') {
	if (actor.kind === 'user') return;
	throw new DomainError(
		'requires_human',
		`Den Not-Aus ${verb} nur der Mensch.`,
		'Läuft etwas aus dem Ruder: Frage als Kommentar, dann in die human_intervention-Spalte — der Mensch entscheidet über den Not-Aus.'
	);
}

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
 * The kill switch: cancels every active run and keeps queued runs waiting until {@link releaseHalt}. Returns the cancelled
 * runs, whose executors the runner still has to abort. Setting the switch and picking the active runs share one write
 * transaction with the claim's halt check, so a concurrent claim either started its run before (cancelled here) or starts none.
 */
export function haltRuns(db: DatabaseSync, actor: Actor): number[] {
	return retryOnLockContention(HALT_LOCK_ATTEMPTS, () => haltAndCancelActive(db, actor));
}

function haltAndCancelActive(db: DatabaseSync, actor: Actor): number[] {
	return tx(db, (emit) => {
		requireHuman(actor, 'setzt');
		db.prepare('INSERT OR IGNORE INTO runner_halt (id) VALUES (1)').run();
		emit({ type: 'runner.halted', actor });
		const active = db
			.prepare(
				"SELECT id, ticket_id FROM runs WHERE state IN ('running', 'waiting_approval') ORDER BY id"
			)
			.all() as ActiveRun[];
		for (const run of active) cancelForHalt(db, actor, run);
		return active.map((run) => run.id);
	});
}

function cancelForHalt(db: DatabaseSync, actor: Actor, run: ActiveRun) {
	finishRun(db, actor, run.id, { state: 'cancelled' });
	addComment(
		db,
		{ kind: 'system', runId: run.id },
		run.ticket_id,
		`Run ${run.id} wurde durch den Not-Aus gestoppt.\nAusweg: Nach dem Fortsetzen (:fortsetzen) einen neuen Run für das Ticket starten.`
	);
}

/** Lets the runner claim queued runs again; it wakes on the `runner.released` event. */
export function releaseHalt(db: DatabaseSync, actor: Actor) {
	tx(db, (emit) => {
		requireHuman(actor, 'löst');
		db.prepare('DELETE FROM runner_halt').run();
		emit({ type: 'runner.released', actor });
	});
}

/** When the kill switch was set, or null while runs may start. */
export function haltedSince(db: DatabaseSync): string | null {
	const row = db.prepare('SELECT halted_at FROM runner_halt').get() as
		{ halted_at: string } | undefined;
	return row?.halted_at ?? null;
}
