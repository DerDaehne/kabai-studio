import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { safeEqual, tokenHash } from '../auth';
import { DomainError } from './core';

export type Runner = { id: number; name: string; created_at: string; last_seen_at: string | null };
export type PairingCode = { code: string; expiresAt: number };
export type PairedRunner = { id: number; name: string; credential: string };

export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const RUNNER_NAME_MAX = 64;
// 32 symbols without I, O, 0 and 1, so a code read aloud or typed off a phone cannot be misread.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

// One pending code at a time, in memory only like the setup token: a restart or a new code invalidates it.
let pending: PairingCode | null = null;

/** A fresh one-time code, valid for ten minutes; it replaces any code issued before. */
export function issuePairingCode(now = Date.now()): PairingCode {
	// 256 is a multiple of 32, so masking a random byte picks every symbol equally often.
	const code = Array.from(randomBytes(CODE_LENGTH), (byte) => CODE_ALPHABET[byte & 31]).join('');
	pending = { code, expiresAt: now + PAIRING_CODE_TTL_MS };
	return pending;
}

const normalizedCode = (input: string) => input.replace(/[\s-]/g, '').toUpperCase();

const invalidCode = () =>
	new DomainError(
		'pairing_code_invalid',
		'Der Kopplungs-Code ist abgelaufen, schon benutzt oder unbekannt.',
		'In Studio unter Einstellungen → Rechner → „Rechner verbinden“ einen neuen Code erzeugen.'
	);

/** Uses up the pending code. Expired, used and unknown codes get the same refusal, so a guess learns nothing. */
function consumePairingCode(input: string, now: number): void {
	const current = pending;
	if (current === null || !safeEqual(normalizedCode(input), current.code)) throw invalidCode();
	if (now >= current.expiresAt) {
		pending = null;
		throw invalidCode();
	}
	pending = null;
}

function validRunnerName(raw: string): string {
	const name = raw.trim();
	if (name.length > 0 && name.length <= RUNNER_NAME_MAX && !/\p{Cc}/u.test(name)) return name;
	throw new DomainError(
		'invalid_runner_name',
		`Der Rechnername muss 1 bis ${RUNNER_NAME_MAX} druckbare Zeichen haben.`,
		'Einen anderen Namen mit --name <name> übergeben.'
	);
}

/** `base`, or `base-2`, `base-3`, … whichever is still free. */
function freeName(db: DatabaseSync, base: string): string {
	const taken = db.prepare('SELECT 1 FROM runners WHERE name = ?');
	let candidate = base;
	for (let n = 2; taken.get(candidate); n++) candidate = `${base}-${n}`;
	return candidate;
}

/**
 * Exchanges the pending one-time code for a new runner and its credential. The credential is returned exactly once;
 * the DB keeps only its SHA-256.
 */
export function pairRunner(
	db: DatabaseSync,
	request: { code: string; name: string },
	now = Date.now()
): PairedRunner {
	const name = validRunnerName(request.name);
	consumePairingCode(request.code, now);
	const credential = randomBytes(32).toString('base64url');
	const runner = db
		.prepare('INSERT INTO runners (name, credential_hash) VALUES (?, ?) RETURNING id, name')
		.get(freeName(db, name), tokenHash(credential)) as { id: number; name: string };
	return { ...runner, credential };
}

export const listRunners = (db: DatabaseSync) =>
	db
		.prepare('SELECT id, name, created_at, last_seen_at FROM runners ORDER BY name')
		.all() as Runner[];

/** The runner a credential belongs to; null once it was disconnected. */
export function runnerByCredential(
	db: DatabaseSync,
	credential: string
): { id: number; name: string } | null {
	const row = db
		.prepare('SELECT id, name FROM runners WHERE credential_hash = ?')
		.get(tokenHash(credential)) as { id: number; name: string } | undefined;
	return row ?? null;
}

/** Deletes the runner and with it the hash of its credential, which stops working at once. */
export function disconnectRunner(db: DatabaseSync, id: number): void {
	const { changes } = db.prepare('DELETE FROM runners WHERE id = ?').run(id);
	if (Number(changes) === 0)
		throw new DomainError(
			'not_found',
			`Rechner ${id} gibt es nicht (mehr).`,
			'Die Seite neu laden; vielleicht wurde er schon getrennt.'
		);
}
