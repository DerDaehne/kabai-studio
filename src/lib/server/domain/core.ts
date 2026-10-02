import type { DatabaseSync } from 'node:sqlite';
import { publish, type StudioEvent } from '../events';

export { DomainError } from './error';

/** Wer eine Mutation auslöst. Agents handeln immer in einem Run. */
export type Actor = { kind: 'user' | 'agent' | 'system'; runId?: number };

/** How an actor appears as comment author or assignee, e.g. "agent (Run 3)". */
export const actorLabel = (actor: Actor) => (actor.runId === undefined ? actor.kind : `${actor.kind} (Run ${actor.runId})`);

/** Events of the transaction currently open on a connection, so nested calls can join it. */
const openTransactions = new WeakMap<DatabaseSync, StudioEvent[]>();

/**
 * Runs `fn` in a transaction. Events reported through `emit` reach the bus only after COMMIT, so a rolled back
 * mutation reports nothing. Inside an open `tx` it joins that transaction: several mutations commit or roll back together.
 */
export function tx<T>(db: DatabaseSync, fn: (emit: (event: StudioEvent) => void) => T): T {
	const outer = openTransactions.get(db);
	if (outer) return fn((event) => outer.push(event));
	const events: StudioEvent[] = [];
	db.exec('BEGIN IMMEDIATE');
	openTransactions.set(db, events);
	let result: T;
	try {
		result = fn((event) => events.push(event));
		db.exec('COMMIT');
	} catch (err) {
		if (db.isTransaction) db.exec('ROLLBACK');
		throw err;
	} finally {
		openTransactions.delete(db);
	}
	events.forEach(publish);
	return result;
}
