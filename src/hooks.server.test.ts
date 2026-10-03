// Durchlauf Guard → Setup → Login → Logout gegen echte DB-Datei, Handler direkt aufgerufen.
import { isActionFailure, isRedirect, type Cookies } from '@sveltejs/kit';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
	SESSION_COOKIE,
	checkLogin,
	createSession,
	hasOwner,
	issueSetupToken
} from '$lib/server/auth';
import { db } from '$lib/server/db';
import * as dbModule from '$lib/server/db';
import { DomainError } from '$lib/server/domain/error';
import { listenerCount, publish } from '$lib/server/events';
import { handle, init } from './hooks.server';
import { actions as loginActions } from './routes/login/+page.server';
import { GET as events } from './routes/api/events/+server';
import { POST as logout } from './routes/logout/+server';
import { actions as setupActions, load as setupLoad } from './routes/setup/+page.server';

const tmp = mkdtempSync(join(tmpdir(), 'studio-auth-'));
process.env.STUDIO_DATA_DIR = tmp; // db() liest das Verzeichnis beim ersten Aufruf
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type CookieOptions = Parameters<Cookies['set']>[2];

const PW = 'test-passwort-123';

function jar(cookies: Record<string, string> = {}) {
	const values = new Map(Object.entries(cookies));
	const options = new Map<string, CookieOptions & { deleted?: boolean }>();
	return {
		values,
		options,
		get: (name: string) => values.get(name),
		set(name: string, value: string, opts: CookieOptions) {
			values.set(name, value);
			options.set(name, opts);
		},
		delete(name: string, opts: CookieOptions) {
			values.delete(name);
			options.set(name, { ...opts, deleted: true });
		},
		serialize: (name: string, value: string, opts: CookieOptions) =>
			`${name}=${value}; Max-Age=${opts.maxAge}; Path=${opts.path}`
	};
}
type Jar = ReturnType<typeof jar>;

// Minimales RequestEvent: nur die Felder, die Guard und Handler nutzen.
type Init = { form?: Record<string, string>; ip?: string; origin?: string; request?: RequestInit };
const DATA_SUFFIX = '/__data.json';
const event = (path: string, cookies: Jar, init: Init = {}): any => {
	const url = new URL(path, init.origin ?? 'http://localhost:3000');
	// SvelteKit strippt /__data.json aus url.pathname, bevor handle läuft (respond.js) — hier nachgebildet, damit der
	// Guard dasselbe Event sieht wie in echt (#822-Review: der Guard hat /__data.json nie selbst gesehen).
	const isDataRequest = url.pathname.endsWith(DATA_SUFFIX);
	if (isDataRequest) url.pathname = url.pathname.slice(0, -DATA_SUFFIX.length) || '/';
	const body = new FormData();
	for (const [k, v] of Object.entries(init.form ?? {})) body.set(k, v);
	return {
		url,
		isDataRequest,
		cookies: cookies as unknown as Cookies,
		locals: {},
		getClientAddress: () => init.ip ?? '10.0.0.1',
		request: new Request(url, init.request ?? (init.form ? { method: 'POST', body } : {}))
	};
};

/** Führt den Handler aus und liefert Redirect-Ziel, ActionFailure oder Response. */
async function run(fn: () => unknown) {
	try {
		return await fn();
	} catch (e) {
		if (isRedirect(e)) return { redirect: e.location, status: e.status };
		throw e;
	}
}

const guard = (path: string, cookies = jar(), init: Init = {}) =>
	run(() => handle({ event: event(path, cookies, init), resolve: () => new Response('ok') }));
const setup = (form: Record<string, string>, ip = '10.0.0.1', cookies = jar()) =>
	run(() => setupActions.default(event('/setup', cookies, { form, ip })));
const login = (
	form: Record<string, string>,
	init: { ip?: string; origin?: string } = {},
	cookies = jar()
) => run(() => loginActions.default(event('/login', cookies, { form, ...init })));

describe('Auth-Durchlauf', () => {
	let token = '';

	it('Erststart: Seiten → /setup, API → 401 JSON, /setup und /login öffentlich', async () => {
		expect(await guard('/')).toEqual({ redirect: '/setup', status: 303 });
		const api = (await guard('/api/tickets')) as Response;
		expect(api.status).toBe(401);
		expect(await api.json()).toMatchObject({
			error: 'unauthorized',
			hint: expect.stringContaining('/login')
		});
		expect(api.headers.get('set-cookie')).toBeNull(); // ohne Cookie nichts zu löschen
		expect(await guard('/setup')).toBeInstanceOf(Response);
		expect(await guard('/login')).toBeInstanceOf(Response);
		expect(await guard('/_app/remote/abc')).toEqual({ redirect: '/setup', status: 303 }); // Remote Functions nicht öffentlich
		token = issueSetupToken(); // wie der init-Hook beim Start ohne Owner
	});

	it('lets /mcp through without a session, but not sub-paths or foreign origins', async () => {
		expect(await guard('/mcp', jar(), { request: { method: 'POST' } })).toBeInstanceOf(Response);
		expect(await guard('/mcp/other')).toEqual({ redirect: '/setup', status: 303 });
		const foreign = (await guard('/mcp', jar(), {
			request: { method: 'POST', headers: { origin: 'http://evil.example' } }
		})) as Response;
		expect(foreign.status).toBe(403);
	});

	it('/setup weist einen falschen Setup-Token ab', async () => {
		const res = await setup({ token: 'falsch', name: 'owner', password: PW, confirm: PW });
		expect(isActionFailure(res) && res.status).toBe(403);
		expect(hasOwner(db())).toBe(false);
	});

	it('/setup zählt falsche Setup-Tokens ins Rate-Limit: nach 5 greift 429, auch mit richtigem Token', async () => {
		for (let i = 0; i < 5; i++) {
			const res = await setup(
				{ token: 'falsch', name: 'owner', password: PW, confirm: PW },
				'10.0.1.1'
			);
			expect(isActionFailure(res) && res.status).toBe(403);
		}
		const blocked = await setup({ token, name: 'owner', password: PW, confirm: PW }, '10.0.1.1');
		expect(isActionFailure(blocked) && blocked.status).toBe(429);
		expect(hasOwner(db())).toBe(false);
	});

	it('/setup prüft Passwortlänge und Wiederholung', async () => {
		for (const [password, confirm] of [
			['kurz', 'kurz'],
			[PW, PW + 'x']
		]) {
			const res = await setup({ token, name: 'owner', password, confirm });
			expect(isActionFailure(res) && res.status).toBe(400);
		}
		expect(hasOwner(db())).toBe(false);
	});

	it('/setup legt den Owner an, meldet an und ist danach gesperrt', async () => {
		const cookies = jar();
		expect(
			await setup({ token, name: 'owner', password: PW, confirm: PW }, '10.0.0.2', cookies)
		).toEqual({ redirect: '/', status: 303 });
		expect(hasOwner(db())).toBe(true);
		expect(cookies.options.get(SESSION_COOKIE)).toMatchObject({
			httpOnly: true,
			sameSite: 'lax',
			secure: false,
			path: '/'
		});

		const again = await setup({ token, name: 'zweiter', password: PW, confirm: PW }, '10.0.0.3');
		expect(isActionFailure(again) && again.status).toBe(403);
		expect(await run(() => setupLoad(event('/setup', jar())))).toEqual({
			redirect: '/login',
			status: 303
		});
		expect(await guard('/')).toEqual({ redirect: '/login', status: 303 });
		expect(await guard('/settings')).toEqual({ redirect: '/login', status: 303 }); // #820: Übersicht nur mit Session
		expect(await guard('/settings/secrets')).toEqual({ redirect: '/login', status: 303 }); // Secrets nur mit Session
		expect(await guard('/settings/secrets/__data.json')).toEqual({
			redirect: '/login',
			status: 303
		});
	});

	it('#822: __data.json öffentlicher Seiten ist mit-öffentlich (SvelteKit strippt das Suffix vor handle), geschützte bleiben es', async () => {
		expect(await guard('/login/__data.json')).toBeInstanceOf(Response); // kein Redirect: Client-Navigation zu /login lädt Daten nach
		expect(await guard('/setup/__data.json')).toBeInstanceOf(Response);
		expect(await guard('/settings/secrets/__data.json')).toEqual({
			redirect: '/login',
			status: 303
		}); // weiterhin geschützt
	});

	it('Login setzt ein Cookie mit Secure außerhalb von localhost, der Guard lässt es durch', async () => {
		const cookies = jar();
		expect(
			await login(
				{ name: 'owner', password: PW },
				{ origin: 'https://studio.example', ip: '10.0.0.4' },
				cookies
			)
		).toEqual({
			redirect: '/',
			status: 303
		});
		expect(cookies.options.get(SESSION_COOKIE)).toMatchObject({
			httpOnly: true,
			sameSite: 'lax',
			secure: true,
			maxAge: 30 * 86_400
		});
		const ev = event('/', cookies);
		expect(await handle({ event: ev, resolve: () => new Response('ok') })).toBeInstanceOf(Response);
		expect(ev.locals.user).toEqual({ id: 1, name: 'owner' });
	});

	it('Rate-Limit: nach 5 Fehlversuchen pro Minute greift 429, auch mit richtigem Passwort', async () => {
		for (let i = 0; i < 5; i++) {
			const res = await login({ name: 'owner', password: 'falsches-passwort' }, { ip: '10.0.0.5' });
			expect(isActionFailure(res) && res.status).toBe(400);
		}
		const blocked = await login({ name: 'owner', password: PW }, { ip: '10.0.0.5' });
		expect(isActionFailure(blocked) && blocked.status).toBe(429);
		expect(await login({ name: 'owner', password: PW }, { ip: '10.0.0.6' })).toEqual({
			redirect: '/',
			status: 303
		});
	});

	it('Rate-Limit zählt erfolgreiche Logins nicht: 6 Anmeldungen pro Minute von einer IP klappen', async () => {
		for (let i = 0; i < 6; i++)
			expect(await login({ name: 'owner', password: PW }, { ip: '10.0.0.7' })).toEqual({
				redirect: '/',
				status: 303
			});
	});

	it('API mit ungültigem Cookie: 401 JSON und das Cookie wird gelöscht', async () => {
		const api = (await guard(
			'/api/tickets',
			jar({ [SESSION_COOKIE]: 'abgelaufen-oder-erfunden' })
		)) as Response;
		expect(api.status).toBe(401);
		expect(api.headers.get('set-cookie')).toMatch(/^studio_session=; Max-Age=0; Path=\//);
	});

	it('CSRF: POST ohne Formular-Content-Type von fremder Origin wird abgewiesen, die Session bleibt', async () => {
		const sessionToken = createSession(db(), 1);
		const cookies = () => jar({ [SESSION_COOKIE]: sessionToken });
		const post = (origin?: string): Init => ({
			request: { method: 'POST', headers: origin ? { origin } : undefined }
		});

		const foreign = (await guard('/logout', cookies(), post('http://localhost:8080'))) as Response;
		expect(foreign.status).toBe(403);
		expect(await foreign.text()).toMatch(/fremder Herkunft/);
		expect(await guard('/', cookies())).toBeInstanceOf(Response); // Session noch gültig
		expect(await guard('/logout', cookies(), post('http://localhost:3000'))).toBeInstanceOf(
			Response
		); // eigene Origin → weiter
		expect(await guard('/logout', cookies(), post())).toBeInstanceOf(Response); // ohne Origin = kein Browser
	});

	it('Logout löscht Session und Cookie; das alte Token führt wieder auf /login', async () => {
		const sessionToken = createSession(db(), 1);
		const cookies = jar({ [SESSION_COOKIE]: sessionToken });
		expect(await run(() => logout(event('/logout', cookies, { form: {} })))).toEqual({
			redirect: '/login',
			status: 303
		});
		expect(cookies.options.get(SESSION_COOKIE)).toMatchObject({
			deleted: true,
			path: '/',
			httpOnly: true,
			secure: false
		});

		const stale = jar({ [SESSION_COOKIE]: sessionToken });
		expect(await guard('/', stale)).toEqual({ redirect: '/login', status: 303 });
		expect(stale.options.get(SESSION_COOKIE)?.deleted).toBe(true);
	});

	it('Logout beendet einen offenen Event-Stream: kein Event mehr, Stream zu, Listener abgemeldet', async () => {
		const sessionToken = createSession(db(), 1);
		const cookies = jar({ [SESSION_COOKIE]: sessionToken });
		const before = listenerCount();
		const reader = (
			(await events(event('/api/events?project=1', cookies))) as Response
		).body!.getReader();
		await reader.read(); // ': connected'
		expect(listenerCount()).toBe(before + 1);

		await run(() => logout(event('/logout', cookies, { form: {} })));
		publish({ type: 'ticket.updated', projectId: 1, ticketId: 1, actor: { kind: 'user' } });
		expect(await reader.read()).toEqual({ done: true, value: undefined });
		expect(listenerCount()).toBe(before);
	});

	it('Event-Stream verlängert die Session nicht (das bleibt dem Guard samt Cookie); Ablauf beendet den Stream', async () => {
		const hash = (token: string) => createHash('sha256').update(token).digest('hex');
		const expiresAt = (token: string) =>
			(
				db().prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hash(token)) as {
					expires_at: string;
				}
			).expires_at;
		const sessionToken = createSession(db(), 1, Date.now() - 2 * 86_400_000); // vor 2 Tagen angemeldet → fällig zur Verlängerung
		const cookies = jar({ [SESSION_COOKIE]: sessionToken });
		const before = expiresAt(sessionToken);

		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			const reader = (
				(await events(event('/api/events?project=1', cookies))) as Response
			).body!.getReader();
			await reader.read(); // ': connected'
			vi.advanceTimersByTime(25_000); // Heartbeat → alive() prüft die Session
			expect(new TextDecoder().decode((await reader.read()).value)).toBe(': heartbeat\n\n');
			expect(expiresAt(sessionToken)).toBe(before);

			expect(await guard('/', cookies)).toBeInstanceOf(Response); // der nächste Request verlängert und setzt das Cookie neu
			expect(cookies.options.get(SESSION_COOKIE)).toMatchObject({ maxAge: 30 * 86_400 });
			expect(expiresAt(sessionToken) > before).toBe(true);

			db()
				.prepare("UPDATE sessions SET expires_at = '2000-01-01 00:00:00' WHERE token_hash = ?")
				.run(hash(sessionToken)); // abgelaufen
			vi.advanceTimersByTime(25_000);
			expect(await reader.read()).toEqual({ done: true, value: undefined });
		} finally {
			vi.useRealTimers();
		}
	});

	it('npm run reset-password setzt das Passwort, während eine andere Verbindung offen ist', async () => {
		const sessionToken = createSession(db(), 1);
		const cli = spawnSync(process.execPath, ['src/lib/server/reset-password.ts'], {
			input: 'neues-test-passwort\n',
			env: { ...process.env, STUDIO_DATA_DIR: tmp },
			encoding: 'utf8'
		});
		expect(cli.stderr).toBe('');
		expect(cli.stdout).toContain('Passwort gesetzt');
		expect(cli.status).toBe(0);
		expect(await checkLogin(db(), 'owner', 'neues-test-passwort')).not.toBeNull();
		expect(await checkLogin(db(), 'owner', PW)).toBeNull();
		expect(await guard('/', jar({ [SESSION_COOKIE]: sessionToken }))).toEqual({
			redirect: '/login',
			status: 303
		});
	});

	it('reset-password weist ein zu kurzes Passwort ab', () => {
		const cli = spawnSync(process.execPath, ['src/lib/server/reset-password.ts'], {
			input: 'kurz\n',
			env: { ...process.env, STUDIO_DATA_DIR: tmp },
			encoding: 'utf8'
		});
		expect(cli.status).toBe(1);
		expect(cli.stderr).toMatch(/mindestens 12/);
	});
});

describe('Default-Bind', () => {
	// Der Hook setzt HOST beim Laden; adapter-node liest es erst danach. Leeres HOST hieße „alle Interfaces".
	it.each([
		['ungesetzt', undefined, '127.0.0.1'],
		['leer', '', '127.0.0.1'],
		['explizit', '0.0.0.0', '0.0.0.0']
	])('HOST %s → %s', async (_, value, expected) => {
		const before = process.env.HOST;
		try {
			if (value === undefined) delete process.env.HOST;
			else process.env.HOST = value;
			vi.resetModules();
			await import('./hooks.server');
			expect(process.env.HOST).toBe(expected);
		} finally {
			if (before === undefined) delete process.env.HOST;
			else process.env.HOST = before;
		}
	});
});

describe('init', () => {
	it('legt die Secret-Maskierung um console — der beim Start erzeugte Schlüssel erscheint in keiner Log-Zeile', async () => {
		const out: string[] = [];
		const log = vi
			.spyOn(console, 'log')
			.mockImplementation((...args) => void out.push(args.join(' ')));
		try {
			await init();
			const key = readFileSync(join(tmp, 'secret.key'), 'utf8').trim();
			console.log('key=%s', key);
			expect(out.at(-1)).toBe('%s key=[secret-key]');
		} finally {
			log.mockRestore();
		}
	});

	it('a startup failure with a stable error prints one clean line and exits instead of an uncaught stack trace', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		const dbSpy = vi.spyOn(dbModule, 'db').mockImplementation(() => {
			throw new DomainError(
				'db_newer_than_code',
				'Datenbank enthält unbekannte Migrationen, die dieser Code nicht kennt: 007_future.sql.',
				'Eine neuere Studio-Version installieren oder eine ältere Sicherung wiederherstellen.'
			);
		});
		try {
			await init();
			expect(error).toHaveBeenCalledWith(
				'%s',
				'kabai studio: [db_newer_than_code] Datenbank enthält unbekannte Migrationen, die dieser Code nicht kennt: 007_future.sql. Eine neuere Studio-Version installieren oder eine ältere Sicherung wiederherstellen.'
			);
			expect(exit).toHaveBeenCalledWith(1);
		} finally {
			dbSpy.mockRestore();
			exit.mockRestore();
			error.mockRestore();
		}
	});

	it('a startup failure without a stable code keeps its cause visible', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		const dbSpy = vi.spyOn(dbModule, 'db').mockImplementation(() => {
			throw new Error('Migration 006_runs.sql fehlgeschlagen', {
				cause: new Error('table runs already exists')
			});
		});
		try {
			await init();
			const printed = error.mock.calls.map((args) => format(...args)).join('\n');
			expect(printed).toContain('Migration 006_runs.sql fehlgeschlagen');
			expect(printed).toContain('table runs already exists');
			expect(exit).toHaveBeenCalledWith(1);
		} finally {
			dbSpy.mockRestore();
			exit.mockRestore();
			error.mockRestore();
		}
	});

	it('exits only after stderr has flushed the error line', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		let flushed: (() => void) | undefined;
		const write = vi.spyOn(process.stderr, 'write').mockImplementation(((
			_chunk: unknown,
			callback?: () => void
		) => {
			flushed = callback;
			return false;
		}) as typeof process.stderr.write);
		const dbSpy = vi.spyOn(dbModule, 'db').mockImplementation(() => {
			throw new DomainError(
				'db_newer_than_code',
				'Datenbank neuer als Code.',
				'Neuere Version installieren.'
			);
		});
		try {
			const started = init();
			await vi.waitFor(() => expect(flushed).toBeTypeOf('function'));
			expect(exit).not.toHaveBeenCalled();
			flushed!();
			await started;
			expect(exit).toHaveBeenCalledWith(1);
		} finally {
			dbSpy.mockRestore();
			write.mockRestore();
			exit.mockRestore();
			error.mockRestore();
		}
	});
});
