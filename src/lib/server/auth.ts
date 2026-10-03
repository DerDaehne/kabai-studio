// Auth für den einen Owner (ADR studio-009). Nur node:-Importe und Typ-Importe: die CLI reset-password
// lädt diese Datei direkt mit Node, ohne Vite.
import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Cookies } from '@sveltejs/kit';

export type User = { id: number; name: string };

const sha256 = (s: string) => createHash('sha256').update(s).digest();
/** Zeitkonstanter Stringvergleich, auch bei unterschiedlicher Länge. */
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

// --- Passwort: scrypt, Parameter im Hash-String -------------------------------------------------

// OWASP-Äquivalent zu N=2^17/p=1, aber 32 MiB statt 128 MiB pro Hash (weniger Speicher-DoS bei parallelen Logins).
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
	// maxmem: Nodes Default (32 MiB) liegt genau auf 128·N·r und reicht mit OpenSSLs Zusatzbedarf nicht.
	return new Promise((resolve, reject) =>
		scrypt(password, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) =>
			err ? reject(err) : resolve(key)
		)
	);
}

/** Fehlermeldung für ein unzulässiges Passwort, sonst null. */
export function passwordProblem(password: string): string | null {
	if (password.length < PASSWORD_MIN)
		return `Das Passwort braucht mindestens ${PASSWORD_MIN} Zeichen.`;
	if (password.length > PASSWORD_MAX)
		return `Das Passwort darf höchstens ${PASSWORD_MAX} Zeichen haben.`;
	return null;
}

/** Format `scrypt$N$r$p$salt$hash` (base64url) — spätere Parameteränderungen brechen alte Hashes nicht. */
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

// --- Owner -------------------------------------------------------------------------------------

export const hasOwner = (db: DatabaseSync) => db.prepare('SELECT 1 FROM users').get() !== undefined;

/** Legt den Owner an, atomar nur solange keiner existiert. null = es gibt schon einen. */
export function createOwner(db: DatabaseSync, name: string, passwordHash: string): User | null {
	const row = db
		.prepare(
			'INSERT INTO users (name, password_hash) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id, name'
		)
		.get(name, passwordHash);
	return (row as User | undefined) ?? null;
}

/** Prüft Name + Passwort gegen den Owner. scrypt läuft immer, damit ein falscher Name nicht schneller antwortet. */
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

/** Recovery (CLI): neues Passwort für den Owner, alle Sessions beendet. false = kein Owner. */
export function resetPassword(db: DatabaseSync, passwordHash: string): boolean {
	db.exec('BEGIN IMMEDIATE'); // Schreibsperre sofort holen: läuft neben dem Server-Prozess
	try {
		const { changes } = db.prepare('UPDATE users SET password_hash = ?').run(passwordHash); // genau ein Owner
		db.exec('DELETE FROM sessions');
		db.exec('COMMIT');
		return Number(changes) > 0;
	} catch (err) {
		if (db.isTransaction) db.exec('ROLLBACK');
		throw err;
	}
}

// --- Setup-Token: einmalig, nur im Speicher, beim Start ohne Owner auf der Konsole ausgegeben -----

let setupToken: string | null = null;

export const issueSetupToken = () => (setupToken = randomBytes(24).toString('base64url'));
export const checkSetupToken = (input: string) =>
	setupToken !== null && safeEqual(input, setupToken);
export const clearSetupToken = () => void (setupToken = null);

// --- Sessions: Token nur im Cookie, in der DB nur SHA-256 --------------------------------------

export const SESSION_COOKIE = 'studio_session';
const SESSION_DAYS = 30;
const DAY = 86_400_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const tokenHash = (token: string) => sha256(token).toString('hex');

/** Neue Session, gibt das Klartext-Token (nur fürs Cookie) zurück. Räumt dabei abgelaufene Sessions ab. */
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
 * Prüft ein Session-Token. null = unbekannt oder abgelaufen (abgelaufene Zeile wird gelöscht).
 * Gleitender Ablauf: verlängert auf 30 Tage, sobald die Restlaufzeit unter 29 Tagen liegt (max. ein Schreibzugriff pro Tag).
 * `renew: false` prüft nur — für Stellen, die das Cookie nicht neu setzen können (offener SSE-Stream). Sonst verbrauchte
 * z. B. ein Heartbeat die Verlängerung, der Guard setzte das Cookie nie neu, und ein offener Tab hielte die Session ewig.
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

/** httpOnly, SameSite=Lax, Secure außer auf Loopback (außerhalb nur über HTTPS nutzbar). */
const cookieOptions = (url: URL) =>
	({ path: '/', httpOnly: true, sameSite: 'lax', secure: !LOOPBACK.has(url.hostname) }) as const;

export function setSessionCookie(cookies: Cookies, url: URL, token: string) {
	cookies.set(SESSION_COOKIE, token, { ...cookieOptions(url), maxAge: SESSION_DAYS * 86_400 });
}

export function clearSessionCookie(cookies: Cookies, url: URL) {
	cookies.delete(SESSION_COOKIE, cookieOptions(url));
}

/** Set-Cookie-Wert, der das Session-Cookie löscht — für Antworten, an die SvelteKit event.cookies nicht anhängt. */
export const expiredSessionCookie = (cookies: Cookies, url: URL) =>
	cookies.serialize(SESSION_COOKIE, '', { ...cookieOptions(url), maxAge: 0 });

// --- Rate-Limit ---------------------------------------------------------------------------------

/**
 * In-memory-Limit je Schlüssel (Client-IP) im gleitenden Fenster. Ein Versuch wird VOR der Prüfung gezählt und nur
 * bei Erfolg zurückgenommen — parallele Requests können das Limit so nicht umgehen.
 */
export function rateLimiter(max = 5, windowMs = 60_000) {
	const hits = new Map<string, number[]>();
	const forgetExpired = (now: number) => {
		for (const [key, times] of hits) if (times.every((t) => t <= now - windowMs)) hits.delete(key);
	};
	return {
		/** false = Limit erreicht, Versuch abweisen. */
		attempt(key: string, now = Date.now()): boolean {
			const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
			const allowed = recent.length < max;
			if (allowed) recent.push(now);
			hits.set(key, recent);
			// ponytail: full sweep above 10k keys; against real mass attacks Studio belongs behind a proxy
			if (hits.size > 10_000) forgetExpired(now);
			return allowed;
		},
		/** Erfolgreicher Versuch zählt nicht als Fehlversuch. */
		succeed(key: string) {
			hits.get(key)?.pop();
		}
	};
}

/** Gemeinsames Limit für /login und /setup: 5 Fehlversuche pro Minute und IP. */
export const authLimiter = rateLimiter();
export const TOO_MANY =
	'Zu viele Fehlversuche von dieser Adresse. Bitte eine Minute warten und dann erneut versuchen.';
