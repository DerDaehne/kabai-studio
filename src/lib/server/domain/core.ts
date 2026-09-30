import type { DatabaseSync } from 'node:sqlite';
import { publish, type StudioEvent } from '../events';

export { DomainError } from './error';

/** Wer eine Mutation auslöst. Agents handeln immer in einem Run. */
export type Actor = { kind: 'user' | 'agent' | 'system'; runId?: number };

/**
 * Führt `fn` in einer Transaktion aus. Events, die `fn` über `emit` meldet, gehen erst nach dem COMMIT
 * auf den Bus — eine zurückgerollte Mutation meldet nichts.
 */
export function tx<T>(db: DatabaseSync, fn: (emit: (event: StudioEvent) => void) => T): T {
	const events: StudioEvent[] = [];
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = fn((event) => events.push(event));
		db.exec('COMMIT');
		events.forEach(publish);
		return result;
	} catch (err) {
		if (db.isTransaction) db.exec('ROLLBACK');
		throw err;
	}
}
