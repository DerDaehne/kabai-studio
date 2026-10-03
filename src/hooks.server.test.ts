// Walks guard → setup → login → logout against a real DB file, calling the handlers directly.
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
process.env.STUDIO_DATA_DIR = tmp; // db() reads the directory on its first call
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

// Minimal RequestEvent: only the fields the guard and the handlers use.
type Init = { form?: Record<string, string>; ip?: string; origin?: string; request?: RequestInit };
const DATA_SUFFIX = '/__data.json';
const event = (path: string, cookies: Jar, init: Init = {}): any => {
	const url = new URL(path, init.origin ?? 'http://localhost:3000');
	// SvelteKit strips /__data.json from url.pathname before handle runs (respond.js) — mirrored here so that the
	// guard sees the same event as in production, where it never sees /__data.json itself.
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

/** Runs the handler and returns the redirect target, ActionFailure or Response. */
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

describe('auth flow', () => {
	let token = '';

	it('on first start sends pages to /setup, answers the API with 401 JSON and keeps /setup and /login public', async () => {
		expect(await guard('/')).toEqual({ redirect: '/setup', status: 303 });
		const api = (await guard('/api/tickets')) as Response;
		expect(api.status).toBe(401);
		expect(await api.json()).toMatchObject({
			error: 'unauthorized',
			hint: expect.stringContaining('/login')
		});
		expect(api.headers.get('set-cookie')).toBeNull(); // without a cookie there is nothing to delete
		expect(await guard('/setup')).toBeInstanceOf(Response);
		expect(await guard('/login')).toBeInstanceOf(Response);
		expect(await guard('/_app/remote/abc')).toEqual({ redirect: '/setup', status: 303 }); // remote functions are not public
		token = issueSetupToken(); // like the init hook on a start without owner
	});

	it('lets /mcp through without a session, but not sub-paths or foreign origins', async () => {
		expect(await guard('/mcp', jar(), { request: { method: 'POST' } })).toBeInstanceOf(Response);
		expect(await guard('/mcp/other')).toEqual({ redirect: '/setup', status: 303 });
		const foreign = (await guard('/mcp', jar(), {
			request: { method: 'POST', headers: { origin: 'http://evil.example' } }
		})) as Response;
		expect(foreign.status).toBe(403);
	});

	it('rejects a wrong setup token on /setup', async () => {
		const res = await setup({ token: 'falsch', name: 'owner', password: PW, confirm: PW });
		expect(isActionFailure(res) && res.status).toBe(403);
		expect(hasOwner(db())).toBe(false);
	});

	it('counts wrong setup tokens into the rate limit: after 5, /setup answers 429 even with the right token', async () => {
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

	it('checks password length and confirmation on /setup', async () => {
		for (const [password, confirm] of [
			['kurz', 'kurz'],
			[PW, PW + 'x']
		]) {
			const res = await setup({ token, name: 'owner', password, confirm });
			expect(isActionFailure(res) && res.status).toBe(400);
		}
		expect(hasOwner(db())).toBe(false);
	});

	it('creates the owner on /setup, logs in and locks /setup afterwards', async () => {
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
		expect(await guard('/settings')).toEqual({ redirect: '/login', status: 303 }); // the settings overview needs a session
		expect(await guard('/settings/secrets')).toEqual({ redirect: '/login', status: 303 }); // secrets need a session
		expect(await guard('/settings/secrets/__data.json')).toEqual({
			redirect: '/login',
			status: 303
		});
	});

	it('treats __data.json of public pages as public and keeps it protected for protected pages', async () => {
		expect(await guard('/login/__data.json')).toBeInstanceOf(Response); // no redirect: client-side navigation to /login loads its data
		expect(await guard('/setup/__data.json')).toBeInstanceOf(Response);
		expect(await guard('/settings/secrets/__data.json')).toEqual({
			redirect: '/login',
			status: 303
		}); // still protected
	});

	it('sets a cookie with Secure outside localhost on login, and the guard lets it through', async () => {
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

	it('answers 429 after 5 failed logins per minute, even with the right password', async () => {
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

	it('does not count successful logins against the rate limit: 6 logins per minute from one IP succeed', async () => {
		for (let i = 0; i < 6; i++)
			expect(await login({ name: 'owner', password: PW }, { ip: '10.0.0.7' })).toEqual({
				redirect: '/',
				status: 303
			});
	});

	it('answers the API with 401 JSON and deletes an invalid cookie', async () => {
		const api = (await guard(
			'/api/tickets',
			jar({ [SESSION_COOKIE]: 'abgelaufen-oder-erfunden' })
		)) as Response;
		expect(api.status).toBe(401);
		expect(api.headers.get('set-cookie')).toMatch(/^studio_session=; Max-Age=0; Path=\//);
	});

	it('rejects a cross-origin POST without a form content type (CSRF) and keeps the session', async () => {
		const sessionToken = createSession(db(), 1);
		const cookies = () => jar({ [SESSION_COOKIE]: sessionToken });
		const post = (origin?: string): Init => ({
			request: { method: 'POST', headers: origin ? { origin } : undefined }
		});

		const foreign = (await guard('/logout', cookies(), post('http://localhost:8080'))) as Response;
		expect(foreign.status).toBe(403);
		expect(await foreign.text()).toMatch(/fremder Herkunft/);
		expect(await guard('/', cookies())).toBeInstanceOf(Response); // session still valid
		expect(await guard('/logout', cookies(), post('http://localhost:3000'))).toBeInstanceOf(
			Response
		); // own origin → passes
		expect(await guard('/logout', cookies(), post())).toBeInstanceOf(Response); // no Origin = no browser
	});

	it('deletes session and cookie on logout, and the old token leads back to /login', async () => {
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

	it('ends an open event stream on logout: no more events, stream closed, listener removed', async () => {
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

	it('streams the events of every project without a project parameter and only its own with one, and logout ends both', async () => {
		const cookies = jar({ [SESSION_COOKIE]: createSession(db(), 1) });
		const open = async (path: string) => {
			const reader = ((await events(event(path, cookies))) as Response).body!.getReader();
			await reader.read(); // ': connected'
			return reader;
		};
		const nextProject = async (reader: ReadableStreamDefaultReader<Uint8Array>) =>
			JSON.parse(new TextDecoder().decode((await reader.read()).value).slice('data: '.length))
				.projectId;
		const all = await open('/api/events');
		const own = await open('/api/events?project=1');

		publish({ type: 'ticket.updated', projectId: 2, ticketId: 5, actor: { kind: 'user' } });
		publish({ type: 'ticket.updated', projectId: 1, ticketId: 1, actor: { kind: 'user' } });
		expect(await nextProject(all)).toBe(2);
		expect(await nextProject(all)).toBe(1);
		expect(await nextProject(own)).toBe(1);

		await run(() => logout(event('/logout', cookies, { form: {} })));
		publish({ type: 'ticket.updated', projectId: 2, ticketId: 5, actor: { kind: 'user' } });
		expect(await all.read()).toEqual({ done: true, value: undefined });
		publish({ type: 'ticket.updated', projectId: 1, ticketId: 1, actor: { kind: 'user' } });
		expect(await own.read()).toEqual({ done: true, value: undefined });
	});

	it('delivers an event that concerns every project, such as the kill switch, to streams with and without a project', async () => {
		const cookies = jar({ [SESSION_COOKIE]: createSession(db(), 1) });
		const readers = await Promise.all(
			['/api/events', '/api/events?project=1'].map(async (path) => {
				const reader = ((await events(event(path, cookies))) as Response).body!.getReader();
				await reader.read(); // ': connected'
				return reader;
			})
		);

		publish({ type: 'runner.halted', actor: { kind: 'user' } });

		for (const reader of readers) {
			const frame = new TextDecoder().decode((await reader.read()).value);
			expect(JSON.parse(frame.slice('data: '.length))).toEqual({
				type: 'runner.halted',
				actor: { kind: 'user' }
			});
			await reader.cancel();
		}
	});

	it('answers the event stream without a session with 401, with or without a project', async () => {
		for (const path of ['/api/events', '/api/events?project=1'])
			expect(((await guard(path)) as Response).status).toBe(401);
	});

	it('rejects a project parameter that is no positive integer with 400', () => {
		const cookies = jar({ [SESSION_COOKIE]: createSession(db(), 1) });
		for (const path of ['/api/events?project=', '/api/events?project=0', '/api/events?project=x'])
			expect(() => events(event(path, cookies))).toThrow(expect.objectContaining({ status: 400 }));
	});

	it('does not extend the session from the event stream (the guard does that with the cookie), and expiry ends the stream', async () => {
		const hash = (token: string) => createHash('sha256').update(token).digest('hex');
		const expiresAt = (token: string) =>
			(
				db().prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hash(token)) as {
					expires_at: string;
				}
			).expires_at;
		const sessionToken = createSession(db(), 1, Date.now() - 2 * 86_400_000); // logged in 2 days ago → due for renewal
		const cookies = jar({ [SESSION_COOKIE]: sessionToken });
		const before = expiresAt(sessionToken);

		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			const reader = (
				(await events(event('/api/events?project=1', cookies))) as Response
			).body!.getReader();
			await reader.read(); // ': connected'
			vi.advanceTimersByTime(25_000); // heartbeat → alive() checks the session
			expect(new TextDecoder().decode((await reader.read()).value)).toBe(': heartbeat\n\n');
			expect(expiresAt(sessionToken)).toBe(before);

			expect(await guard('/', cookies)).toBeInstanceOf(Response); // the next request extends it and sets the cookie again
			expect(cookies.options.get(SESSION_COOKIE)).toMatchObject({ maxAge: 30 * 86_400 });
			expect(expiresAt(sessionToken) > before).toBe(true);

			db()
				.prepare("UPDATE sessions SET expires_at = '2000-01-01 00:00:00' WHERE token_hash = ?")
				.run(hash(sessionToken)); // expired
			vi.advanceTimersByTime(25_000);
			expect(await reader.read()).toEqual({ done: true, value: undefined });
		} finally {
			vi.useRealTimers();
		}
	});

	it('sets the password with npm run reset-password while another connection is open', async () => {
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

	it('rejects a too short password in reset-password', () => {
		const cli = spawnSync(process.execPath, ['src/lib/server/reset-password.ts'], {
			input: 'kurz\n',
			env: { ...process.env, STUDIO_DATA_DIR: tmp },
			encoding: 'utf8'
		});
		expect(cli.status).toBe(1);
		expect(cli.stderr).toMatch(/mindestens 12/);
	});
});

describe('default bind address', () => {
	// The hook sets HOST when it loads; adapter-node reads it only afterwards. An empty HOST would mean "all interfaces".
	it.each([
		['unset', undefined, '127.0.0.1'],
		['empty', '', '127.0.0.1'],
		['explicit', '0.0.0.0', '0.0.0.0']
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
	it('wraps console in the secret masking, so the key created at startup appears in no log line', async () => {
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
