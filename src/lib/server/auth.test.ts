import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
	checkLogin,
	checkSetupToken,
	clearSetupToken,
	createOwner,
	createSession,
	deleteSession,
	hashPassword,
	issueSetupToken,
	passwordProblem,
	rateLimiter,
	resetPassword,
	validateSession,
	verifyPassword
} from './auth';
import { migrate, openDb } from './db';

vi.mock('node:crypto', async (importOriginal) => {
	const crypto = await importOriginal<typeof import('node:crypto')>();
	return { ...crypto, timingSafeEqual: vi.fn(crypto.timingSafeEqual) };
});

const DAY = 86_400_000;
const PW = 'test-passwort-123';

describe('password (scrypt)', () => {
	it('stores parameters and salt in the hash, with a new salt every time', async () => {
		const [a, b] = [await hashPassword(PW), await hashPassword(PW)];
		expect(a).toMatch(/^scrypt\$32768\$8\$3\$[\w-]{22}\$[\w-]{43}$/);
		expect(a).not.toBe(b);
	});

	it('verifies with timingSafeEqual', async () => {
		const stored = await hashPassword(PW);
		vi.mocked(timingSafeEqual).mockClear();
		expect(await verifyPassword(PW, stored)).toBe(true);
		expect(timingSafeEqual).toHaveBeenCalledOnce();
		expect(await verifyPassword(PW + 'x', stored)).toBe(false);
		expect(timingSafeEqual).toHaveBeenCalledTimes(2);
	});

	it('reads the parameters from the hash, so older parameters stay valid', async () => {
		const salt = Buffer.from('0123456789abcdef');
		const old = [
			'scrypt',
			1024,
			8,
			1,
			salt.toString('base64url'),
			scryptSync(PW, salt, 32, { N: 1024, r: 8, p: 1 }).toString('base64url')
		].join('$');
		expect(await verifyPassword(PW, old)).toBe(true);
		expect(await verifyPassword('falsch', old)).toBe(false);
	});

	it('rejects foreign or broken hashes', async () => {
		expect(await verifyPassword(PW, '')).toBe(false);
		expect(await verifyPassword(PW, '$2b$10$abcdefghijklmnopqrstuv')).toBe(false);
		expect(await verifyPassword(PW, 'scrypt$32768$8$3$c2FsdA$')).toBe(false);
	});

	it('requires 12 to 1024 characters', () => {
		expect(passwordProblem('a'.repeat(11))).toMatch(/mindestens 12/);
		expect(passwordProblem('a'.repeat(12))).toBeNull();
		expect(passwordProblem('a'.repeat(1025))).toMatch(/höchstens/);
	});
});

describe('owner and sessions', () => {
	const db = openDb(':memory:');
	migrate(db);
	const now = Date.parse('2026-01-01T00:00:00Z');
	const expiresAt = (token: string) =>
		db
			.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
			.get(createHash('sha256').update(token).digest('hex'))?.expires_at;

	it('creates exactly one owner', async () => {
		expect(createOwner(db, 'owner', await hashPassword(PW))).toEqual({ id: 1, name: 'owner' });
		expect(createOwner(db, 'zweiter', await hashPassword(PW))).toBeNull();
	});

	it('checks name and password', async () => {
		expect(await checkLogin(db, 'owner', PW)).toEqual({ id: 1, name: 'owner' });
		expect(await checkLogin(db, 'owner', 'falsches-passwort')).toBeNull();
		expect(await checkLogin(db, 'jemand', PW)).toBeNull();
	});

	it('stores the session token only as a SHA-256 hash', () => {
		const token = createSession(db, 1, now);
		expect(token).toMatch(/^[\w-]{43}$/); // 32 random bytes
		const rows = db.prepare('SELECT * FROM sessions').all();
		expect(rows).toHaveLength(1);
		expect(rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
		expect(JSON.stringify(rows)).not.toContain(token);
		expect(() =>
			db
				.prepare(
					"INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, '2099-01-01 00:00:00')"
				)
				.run(token)
		).toThrow(/CHECK/);
	});

	it('accepts valid sessions and extends them sliding, at most once per day', () => {
		const token = createSession(db, 1, now);
		expect(validateSession(db, token, now + 3_600_000)).toEqual({
			user: { id: 1, name: 'owner' },
			renewed: false
		});
		expect(expiresAt(token)).toBe('2026-01-31 00:00:00');
		expect(validateSession(db, token, now + 2 * DAY)?.renewed).toBe(true);
		expect(expiresAt(token)).toBe('2026-02-02 00:00:00');
	});

	it('only checks with renew: false and never extends, leaving the renewal to the next request', () => {
		const token = createSession(db, 1, now);
		expect(validateSession(db, token, now + 2 * DAY, { renew: false })).toEqual({
			user: { id: 1, name: 'owner' },
			renewed: false
		});
		expect(expiresAt(token)).toBe('2026-01-31 00:00:00');
		expect(validateSession(db, token, now + 2 * DAY)?.renewed).toBe(true);
		expect(validateSession(db, token, now + 31 * DAY, { renew: false })).not.toBeNull(); // the expiry still applies
		expect(validateSession(db, token, now + 32 * DAY, { renew: false })).toBeNull();
	});

	it('rejects expired sessions and deletes them', () => {
		const token = createSession(db, 1, now);
		expect(validateSession(db, token, now + 30 * DAY - 1000)).not.toBeNull(); // extended to +60 days
		expect(validateSession(db, token, now + 59 * DAY)).not.toBeNull();
		const stale = createSession(db, 1, now);
		expect(validateSession(db, stale, now + 30 * DAY)).toBeNull();
		expect(expiresAt(stale)).toBeUndefined();
	});

	it('rejects unknown and logged-out tokens', () => {
		const token = createSession(db, 1, now);
		expect(validateSession(db, 'erfunden', now)).toBeNull();
		deleteSession(db, token);
		expect(validateSession(db, token, now)).toBeNull();
	});

	it('sets the password and ends all sessions on reset-password', async () => {
		const token = createSession(db, 1, now);
		expect(resetPassword(db, await hashPassword('neues-passwort-1'))).toBe(true);
		expect(validateSession(db, token, now)).toBeNull();
		expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
		expect(await checkLogin(db, 'owner', PW)).toBeNull();
		expect(await checkLogin(db, 'owner', 'neues-passwort-1')).not.toBeNull();

		const empty = openDb(':memory:');
		migrate(empty);
		expect(resetPassword(empty, await hashPassword(PW))).toBe(false);
	});
});

describe('setup token', () => {
	it('accepts only the issued token and only until the owner exists', () => {
		clearSetupToken();
		expect(checkSetupToken('')).toBe(false);
		const token = issueSetupToken();
		expect(token).toMatch(/^[\w-]{32}$/);
		expect(checkSetupToken(token)).toBe(true);
		expect(checkSetupToken(token + 'x')).toBe(false);
		expect(checkSetupToken('')).toBe(false);
		clearSetupToken();
		expect(checkSetupToken(token)).toBe(false);
	});
});

describe('rate limit', () => {
	it('blocks after 5 failed attempts per minute and key', () => {
		const limit = rateLimiter();
		const t = 1_000_000;
		for (let i = 0; i < 5; i++) expect(limit.attempt('1.2.3.4', t + i)).toBe(true);
		expect(limit.attempt('1.2.3.4', t + 10)).toBe(false);
		expect(limit.attempt('5.6.7.8', t + 10)).toBe(true); // another IP is unaffected
		expect(limit.attempt('1.2.3.4', t + 59_999)).toBe(false);
		expect(limit.attempt('1.2.3.4', t + 60_001)).toBe(true); // the oldest attempt left the window
	});

	it('does not count successful attempts', () => {
		const limit = rateLimiter();
		for (let i = 0; i < 10; i++) {
			expect(limit.attempt('ip', i)).toBe(true);
			limit.succeed('ip');
		}
	});
});
