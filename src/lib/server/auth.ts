// Auth for the single owner. node: and type imports only: the reset-password CLI
// loads this file directly under Node, without Vite.
import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Cookies } from '@sveltejs/kit';

export type User = { id: number; name: string };

const sha256 = (s: string) => createHash('sha256').update(s).digest();
/** Constant-time string comparison, also for strings of different length. */
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

// --- Password: scrypt, parameters inside the hash string ---

// OWASP equivalent of N=2^17/p=1, but 32 MiB instead of 128 MiB per hash (less memory DoS with parallel logins).
const N = 2 ** 15,
	R = 8,
	P = 3;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 1024;

function derive(
	password: string,
	salt: Buffer,
	keylen: number,
	opts: ScryptOptions
): Promise<Buffer> {
	// maxmem: Node's default (32 MiB) equals 128·N·r exactly and is too small once OpenSSL adds its overhead.
	return new Promise((resolve, reject) =>
		scrypt(password, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) =>
			err ? reject(err) : resolve(key)
		)
	);
}

/** The error message for an unacceptable password, otherwise null. */
export function passwordProblem(password: string): string | null {
	if (password.length < PASSWORD_MIN)
		return `Das Passwort braucht mindestens ${PASSWORD_MIN} Zeichen.`;
	if (password.length > PASSWORD_MAX)
		return `Das Passwort darf höchstens ${PASSWORD_MAX} Zeichen haben.`;
	return null;
}

/** Format `scrypt$N$r$p$salt$hash` (base64url), so later parameter changes do not break old hashes. */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await derive(password, salt, 32, { N, r: R, p: P });
	return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [alg, n, r, p, salt, hash] = stored.split('$');
	const expected = Buffer.from(hash ?? '', 'base64url');
	if (alg !== 'scrypt' || expected.length === 0) return false;
	const key = await derive(password, Buffer.from(salt, 'base64url'), expected.length, {
		N: +n,
		r: +r,
		p: +p
	});
	return timingSafeEqual(key, expected);
}

// --- Owner ---

export const hasOwner = (db: DatabaseSync) => db.prepare('SELECT 1 FROM users').get() !== undefined;

/** Creates the owner, atomically and only while none exists. null = there already is one. */
export function createOwner(db: DatabaseSync, name: string, passwordHash: string): User | null {
	const row = db
		.prepare(
			'INSERT INTO users (name, password_hash) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id, name'
		)
		.get(name, passwordHash);
	return (row as User | undefined) ?? null;
}

/** Checks name and password against the owner. scrypt always runs, so a wrong name does not answer faster. */
export async function checkLogin(
	db: DatabaseSync,
	name: string,
	password: string
): Promise<User | null> {
	const owner = db
		.prepare('SELECT id, name, password_hash FROM users ORDER BY id LIMIT 1')
		.get() as (User & { password_hash: string }) | undefined;
	if (!owner) return null;
	const ok = await verifyPassword(password, owner.password_hash);
	return ok && safeEqual(name, owner.name) ? { id: owner.id, name: owner.name } : null;
}

/** Recovery (CLI): a new owner password, and all sessions end. false = no owner. */
export function resetPassword(db: DatabaseSync, passwordHash: string): boolean {
	db.exec('BEGIN IMMEDIATE'); // take the write lock at once: this runs next to the server process
	try {
		const { changes } = db.prepare('UPDATE users SET password_hash = ?').run(passwordHash); // exactly one owner
		db.exec('DELETE FROM sessions');
		db.exec('COMMIT');
		return Number(changes) > 0;
	} catch (err) {
		if (db.isTransaction) db.exec('ROLLBACK');
		throw err;
	}
}

// --- Setup token: one-time, in memory only, printed to the console when starting without an owner ---

let setupToken: string | null = null;

export const issueSetupToken = () => (setupToken = randomBytes(24).toString('base64url'));
export const checkSetupToken = (input: string) =>
	setupToken !== null && safeEqual(input, setupToken);
export const clearSetupToken = () => void (setupToken = null);

// --- Sessions: the token lives only in the cookie, the DB keeps its SHA-256 ---

export const SESSION_COOKIE = 'studio_session';
const SESSION_DAYS = 30;
const DAY = 86_400_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const tokenHash = (token: string) => sha256(token).toString('hex');

/** Creates a session and returns the plain token (for the cookie only). Removes expired sessions on the way. */
export function createSession(db: DatabaseSync, userId: number, now = Date.now()): string {
	const token = randomBytes(32).toString('base64url');
	db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(sqlTime(now));
	db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
		tokenHash(token),
		userId,
		sqlTime(now + SESSION_DAYS * DAY)
	);
	return token;
}

/**
 * Checks a session token. null = unknown or expired (an expired row is deleted).
 * Sliding expiry: extends to 30 days once less than 29 days remain (at most one write per day).
 * `renew: false` only checks — for places that cannot set the cookie again (an open SSE stream). Otherwise a heartbeat
 * would use up the renewal, the guard would never set the cookie again, and an open tab would keep the session forever.
 */
export function validateSession(
	db: DatabaseSync,
	token: string,
	now = Date.now(),
	{ renew = true } = {}
): { user: User; renewed: boolean } | null {
	const hash = tokenHash(token);
	const row = db
		.prepare(
			'SELECT s.expires_at, u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
		)
		.get(hash) as (User & { expires_at: string }) | undefined;
	if (!row) return null;
	if (row.expires_at <= sqlTime(now)) {
		deleteSession(db, token);
		return null;
	}
	const renewed = renew && row.expires_at < sqlTime(now + (SESSION_DAYS - 1) * DAY);
	if (renewed)
		db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(
			sqlTime(now + SESSION_DAYS * DAY),
			hash
		);
	return { user: { id: row.id, name: row.name }, renewed };
}

export function deleteSession(db: DatabaseSync, token: string) {
	db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

/** httpOnly, SameSite=Lax, Secure except on loopback (so elsewhere usable over HTTPS only). */
const cookieOptions = (url: URL) =>
	({ path: '/', httpOnly: true, sameSite: 'lax', secure: !LOOPBACK.has(url.hostname) }) as const;

export function setSessionCookie(cookies: Cookies, url: URL, token: string) {
	cookies.set(SESSION_COOKIE, token, { ...cookieOptions(url), maxAge: SESSION_DAYS * 86_400 });
}

export function clearSessionCookie(cookies: Cookies, url: URL) {
	cookies.delete(SESSION_COOKIE, cookieOptions(url));
}

/** A Set-Cookie value that deletes the session cookie, for responses that SvelteKit does not attach event.cookies to. */
export const expiredSessionCookie = (cookies: Cookies, url: URL) =>
	cookies.serialize(SESSION_COOKIE, '', { ...cookieOptions(url), maxAge: 0 });

// --- Rate limit ---

/**
 * In-memory limit per key (client IP) in a sliding window. An attempt counts BEFORE the check and is only taken back
 * on success, so parallel requests cannot get around the limit.
 */
export function rateLimiter(max = 5, windowMs = 60_000) {
	const hits = new Map<string, number[]>();
	const forgetExpired = (now: number) => {
		for (const [key, times] of hits) if (times.every((t) => t <= now - windowMs)) hits.delete(key);
	};
	return {
		/** false = limit reached, reject the attempt. */
		attempt(key: string, now = Date.now()): boolean {
			const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
			const allowed = recent.length < max;
			if (allowed) recent.push(now);
			hits.set(key, recent);
			// ponytail: full sweep above 10k keys; against real mass attacks Studio belongs behind a proxy
			if (hits.size > 10_000) forgetExpired(now);
			return allowed;
		},
		/** A successful attempt does not count as a failed one. */
		succeed(key: string) {
			hits.get(key)?.pop();
		}
	};
}

/** Shared limit for /login and /setup: 5 failed attempts per minute and IP. */
export const authLimiter = rateLimiter();
export const TOO_MANY =
	'Zu viele Fehlversuche von dieser Adresse. Bitte eine Minute warten und dann erneut versuchen.';
