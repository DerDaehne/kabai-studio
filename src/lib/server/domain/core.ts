import type { DatabaseSync } from 'node:sqlite';
import { publish, type StudioEvent } from '../events';

export { DomainError } from './error';

/** Who triggers a mutation. Agents always act within a run. */
export type Actor = { kind: 'user' | 'agent' | 'system'; runId?: number };

/** How an actor appears as comment author or assignee, e.g. "agent (Run 3)". */
export const actorLabel = (actor: Actor) =>
	actor.runId === undefined ? actor.kind : `${actor.kind} (Run ${actor.runId})`;

/** Events collected by the innermost open `tx` of a connection. */
const openTransactions = new WeakMap<DatabaseSync, StudioEvent[]>();

const TOP_LEVEL = { begin: 'BEGIN IMMEDIATE', commit: 'COMMIT', rollback: 'ROLLBACK' };
// SQLite resolves a repeated savepoint name to the most recent one, so one name serves every nesting level.
const NESTED = {
	begin: 'SAVEPOINT nested',
	commit: 'RELEASE nested',
	rollback: 'ROLLBACK TO nested; RELEASE nested'
};

/**
 * Runs `fn` in a transaction. Events reported through `emit` reach the bus only after the outermost COMMIT, so a rolled
 * back mutation reports nothing. Inside an open `tx` it runs in a savepoint of that transaction: if it fails, its own
 * writes and events are undone even when the caller catches the error; otherwise they commit with the caller's.
 */
export function tx<T>(db: DatabaseSync, fn: (emit: (event: StudioEvent) => void) => T): T {
	const outer = openTransactions.get(db);
	const statements = outer ? NESTED : TOP_LEVEL;
	const events: StudioEvent[] = [];
	db.exec(statements.begin);
	openTransactions.set(db, events);
	let result: T;
	try {
		result = fn((event) => events.push(event));
		db.exec(statements.commit);
	} catch (err) {
		if (db.isTransaction) db.exec(statements.rollback);
		throw err;
	} finally {
		if (outer) openTransactions.set(db, outer);
		else openTransactions.delete(db);
	}
	if (outer) outer.push(...events);
	else events.forEach(publish);
	return result;
}

// Only the newest question of a ticket can still be answered meaningfully; collectAnswer reads no other.
export const OPEN_QUESTION = `q.answer IS NULL AND q.id = (SELECT max(id) FROM questions WHERE ticket_id = q.ticket_id)`;

/** The first run of the chain of resumes that ends with this run; a run that continues none is its own. */
export function chainRootOf(db: DatabaseSync, runId: number): number {
	const { id } = db
		.prepare(
			`WITH RECURSIVE chain (id, previous) AS (
				SELECT id, resumed_from_run_id FROM runs WHERE id = ?
				UNION ALL
				SELECT r.id, r.resumed_from_run_id FROM runs r JOIN chain c ON r.id = c.previous)
			SELECT id FROM chain WHERE previous IS NULL`
		)
		.get(runId) as { id: number };
	return id;
}
