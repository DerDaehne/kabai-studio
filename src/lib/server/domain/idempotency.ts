import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError, tx, type Actor } from './core';

type EarlierCall = { request_hash: string; result: string; fresh: 0 | 1 };

/**
 * Runs `work` at most once per run and key: it commits together with its remembered result, and a repeat of the same
 * request gets that result back. A key reused for another request, or used more than a day ago, is refused.
 * ponytail: rows stay until their run is deleted; prune old ones if the table ever grows noticeably.
 */
export function once<T>(db: DatabaseSync, actor: Actor, key: string, request: object, work: () => T): T {
	if (actor.runId === undefined)
		throw new DomainError('idempotency_needs_run', 'Ein idempotency_key gilt nur innerhalb eines Runs.', 'Lass idempotency_key weg.');
	const runId = actor.runId;
	const requestHash = createHash('sha256').update(canonicalJson(request)).digest('hex');
	return tx(db, () => {
		const earlier = db
			.prepare("SELECT request_hash, result, created_at > datetime('now', '-1 day') AS fresh FROM idempotent_calls WHERE run_id = ? AND key = ?")
			.get(runId, key) as EarlierCall | undefined;
		if (earlier) return earlierResult<T>(key, earlier, requestHash);
		const result = work();
		db.prepare('INSERT INTO idempotent_calls (run_id, key, request_hash, result) VALUES (?, ?, ?, ?)').run(runId, key, requestHash, JSON.stringify(result));
		return result;
	});
}

/** JSON with the keys of every object sorted, so the same arguments sent in another order hash alike. */
const canonicalJson = (value: unknown) =>
	JSON.stringify(value, (_key, nested: unknown) =>
		nested && typeof nested === 'object' && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : nested
	);

function earlierResult<T>(key: string, earlier: EarlierCall, requestHash: string): T {
	if (earlier.request_hash !== requestHash)
		throw new DomainError(
			'idempotency_key_reused',
			`Der idempotency_key „${key}“ gehört in diesem Run schon zu einem anderen Aufruf.`,
			'Nimm für jeden neuen Schreibaufruf einen neuen Schlüssel; denselben nur, um genau diesen Aufruf zu wiederholen.'
		);
	if (!earlier.fresh)
		throw new DomainError(
			'idempotency_key_expired',
			`Der idempotency_key „${key}“ wurde vor mehr als 24 Stunden benutzt; so alte Aufrufe wiederholt Studio nicht.`,
			'Prüfe im Ticket, ob der erste Aufruf gewirkt hat; einen neuen Aufruf schickst du mit einem neuen Schlüssel.'
		);
	return JSON.parse(earlier.result) as T;
}
