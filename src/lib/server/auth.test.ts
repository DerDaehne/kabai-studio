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

describe('Passwort (scrypt)', () => {
	it('speichert Parameter und Salt im Hash, jedes Mal ein anderes Salt', async () => {
		const [a, b] = [await hashPassword(PW), await hashPassword(PW)];
		expect(a).toMatch(/^scrypt\$32768\$8\$3\$[\w-]{22}\$[\w-]{43}$/);
		expect(a).not.toBe(b);
	});

	it('verifiziert mit timingSafeEqual', async () => {
		const stored = await hashPassword(PW);
		vi.mocked(timingSafeEqual).mockClear();
		expect(await verifyPassword(PW, stored)).toBe(true);
		expect(timingSafeEqual).toHaveBeenCalledOnce();
		expect(await verifyPassword(PW + 'x', stored)).toBe(false);
		expect(timingSafeEqual).toHaveBeenCalledTimes(2);
	});

	it('liest die Parameter aus dem Hash (ältere Parameter bleiben gültig)', async () => {
		const salt = Buffer.from('0123456789abcdef');
		const old = ['scrypt', 1024, 8, 1, salt.toString('base64url'), scryptSync(PW, salt, 32, { N: 1024, r: 8, p: 1 }).toString('base64url')].join('$');
		expect(await verifyPassword(PW, old)).toBe(true);
		expect(await verifyPassword('falsch', old)).toBe(false);
	});

	it('weist fremde oder kaputte Hashes ab', async () => {
		expect(await verifyPassword(PW, '')).toBe(false);
		expect(await verifyPassword(PW, '$2b$10$abcdefghijklmnopqrstuv')).toBe(false);
		expect(await verifyPassword(PW, 'scrypt$32768$8$3$c2FsdA$')).toBe(false);
	});

	it('verlangt 12 bis 1024 Zeichen', () => {
		expect(passwordProblem('a'.repeat(11))).toMatch(/mindestens 12/);
		expect(passwordProblem('a'.repeat(12))).toBeNull();
		expect(passwordProblem('a'.repeat(1025))).toMatch(/höchstens/);
	});
});

describe('Owner und Sessions', () => {
	const db = openDb(':memory:');
	migrate(db);
	const now = Date.parse('2026-01-01T00:00:00Z');
	const expiresAt = (token: string) =>
		db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(createHash('sha256').update(token).digest('hex'))?.expires_at;

	it('legt genau einen Owner an', async () => {
		expect(createOwner(db, 'owner', await hashPassword(PW))).toEqual({ id: 1, name: 'owner' });
		expect(createOwner(db, 'zweiter', await hashPassword(PW))).toBeNull();
	});

	it('prüft Name und Passwort', async () => {
		expect(await checkLogin(db, 'owner', PW)).toEqual({ id: 1, name: 'owner' });
		expect(await checkLogin(db, 'owner', 'falsches-passwort')).toBeNull();
		expect(await checkLogin(db, 'jemand', PW)).toBeNull();
	});

	it('speichert das Session-Token nur als SHA-256-Hash', () => {
		const token = createSession(db, 1, now);
		expect(token).toMatch(/^[\w-]{43}$/); // 32 Zufallsbytes
		const rows = db.prepare('SELECT * FROM sessions').all();
		expect(rows).toHaveLength(1);
		expect(rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
		expect(JSON.stringify(rows)).not.toContain(token);
		expect(() => db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, '2099-01-01 00:00:00')").run(token)).toThrow(/CHECK/);
	});

	it('akzeptiert gültige Sessions und verlängert gleitend, höchstens einmal pro Tag', () => {
		const token = createSession(db, 1, now);
		expect(validateSession(db, token, now + 3_600_000)).toEqual({ user: { id: 1, name: 'owner' }, renewed: false });
		expect(expiresAt(token)).toBe('2026-01-31 00:00:00');
		expect(validateSession(db, token, now + 2 * DAY)?.renewed).toBe(true);
		expect(expiresAt(token)).toBe('2026-02-02 00:00:00');
	});

	it('renew: false prüft nur und verlängert nie — die Verlängerung bleibt dem nächsten Request', () => {
		const token = createSession(db, 1, now);
		expect(validateSession(db, token, now + 2 * DAY, { renew: false })).toEqual({ user: { id: 1, name: 'owner' }, renewed: false });
		expect(expiresAt(token)).toBe('2026-01-31 00:00:00');
		expect(validateSession(db, token, now + 2 * DAY)?.renewed).toBe(true);
		expect(validateSession(db, token, now + 31 * DAY, { renew: false })).not.toBeNull(); // Ablauf gilt weiter
		expect(validateSession(db, token, now + 32 * DAY, { renew: false })).toBeNull();
	});

	it('weist abgelaufene Sessions ab und löscht sie', () => {
		const token = createSession(db, 1, now);
		expect(validateSession(db, token, now + 30 * DAY - 1000)).not.toBeNull(); // verlängert auf +60 Tage
		expect(validateSession(db, token, now + 59 * DAY)).not.toBeNull();
		const stale = createSession(db, 1, now);
		expect(validateSession(db, stale, now + 30 * DAY)).toBeNull();
		expect(expiresAt(stale)).toBeUndefined();
	});

	it('weist unbekannte und abgemeldete Tokens ab', () => {
		const token = createSession(db, 1, now);
		expect(validateSession(db, 'erfunden', now)).toBeNull();
		deleteSession(db, token);
		expect(validateSession(db, token, now)).toBeNull();
	});

	it('reset-password setzt das Passwort und beendet alle Sessions', async () => {
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

describe('Setup-Token', () => {
	it('gilt nur für den ausgegebenen Token und nur bis zur Owner-Anlage', () => {
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

describe('Rate-Limit', () => {
	it('sperrt nach 5 Fehlversuchen pro Minute und Schlüssel', () => {
		const limit = rateLimiter();
		const t = 1_000_000;
		for (let i = 0; i < 5; i++) expect(limit.attempt('1.2.3.4', t + i)).toBe(true);
		expect(limit.attempt('1.2.3.4', t + 10)).toBe(false);
		expect(limit.attempt('5.6.7.8', t + 10)).toBe(true); // andere IP unberührt
		expect(limit.attempt('1.2.3.4', t + 59_999)).toBe(false);
		expect(limit.attempt('1.2.3.4', t + 60_001)).toBe(true); // ältester Versuch aus dem Fenster
	});

	it('zählt erfolgreiche Versuche nicht mit', () => {
		const limit = rateLimiter();
		for (let i = 0; i < 10; i++) {
			expect(limit.attempt('ip', i)).toBe(true);
			limit.succeed('ip');
		}
	});
});
