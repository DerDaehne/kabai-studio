import type { DatabaseSync } from 'node:sqlite';
import { publish, type StudioEvent } from '../events';

export { DomainError } from './error';

/** Wer eine Mutation auslöst. Agents handeln immer in einem Run. */
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
