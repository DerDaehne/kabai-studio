// Durchlauf Guard → Setup → Login → Logout gegen echte DB-Datei, Handler direkt aufgerufen.
import { isActionFailure, isRedirect, type Cookies } from '@sveltejs/kit';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, checkLogin, createSession, hasOwner, issueSetupToken } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { handle } from './hooks.server';
import { actions as loginActions } from './routes/login/+page.server';
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
		}
	};
}
type Jar = ReturnType<typeof jar>;

// Minimales RequestEvent: nur die Felder, die Guard und Handler nutzen.
const event = (path: string, cookies: Jar, init: { form?: Record<string, string>; ip?: string; origin?: string } = {}): any => {
	const url = new URL(path, init.origin ?? 'http://localhost:3000');
	const body = new FormData();
	for (const [k, v] of Object.entries(init.form ?? {})) body.set(k, v);
	return {
		url,
		cookies: cookies as unknown as Cookies,
		locals: {},
		getClientAddress: () => init.ip ?? '10.0.0.1',
		request: new Request(url, init.form ? { method: 'POST', body } : {})
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

const guard = (path: string, cookies = jar()) =>
	run(() => handle({ event: event(path, cookies), resolve: () => new Response('ok') }));
const setup = (form: Record<string, string>, ip = '10.0.0.1', cookies = jar()) => run(() => setupActions.default(event('/setup', cookies, { form, ip })));
const login = (form: Record<string, string>, init: { ip?: string; origin?: string } = {}, cookies = jar()) =>
	run(() => loginActions.default(event('/login', cookies, { form, ...init })));

describe('Auth-Durchlauf', () => {
	let token = '';

	it('Erststart: Seiten → /setup, API → 401 JSON, /setup und /login öffentlich', async () => {
		expect(await guard('/')).toEqual({ redirect: '/setup', status: 303 });
		const api = (await guard('/api/tickets')) as Response;
		expect(api.status).toBe(401);
		expect(await api.json()).toEqual({ error: 'unauthorized' });
		expect(await guard('/setup')).toBeInstanceOf(Response);
		expect(await guard('/login')).toBeInstanceOf(Response);
		expect(await guard('/_app/remote/abc')).toEqual({ redirect: '/setup', status: 303 }); // Remote Functions nicht öffentlich
		token = issueSetupToken(); // wie der init-Hook beim Start ohne Owner
	});

	it('/setup weist einen falschen Setup-Token ab', async () => {
		const res = await setup({ token: 'falsch', name: 'owner', password: PW, confirm: PW });
		expect(isActionFailure(res) && res.status).toBe(403);
		expect(hasOwner(db())).toBe(false);
	});

	it('/setup prüft Passwortlänge und Wiederholung', async () => {
		for (const [password, confirm] of [['kurz', 'kurz'], [PW, PW + 'x']]) {
			const res = await setup({ token, name: 'owner', password, confirm });
			expect(isActionFailure(res) && res.status).toBe(400);
		}
		expect(hasOwner(db())).toBe(false);
	});

	it('/setup legt den Owner an, meldet an und ist danach gesperrt', async () => {
		const cookies = jar();
		expect(await setup({ token, name: 'owner', password: PW, confirm: PW }, '10.0.0.2', cookies)).toEqual({ redirect: '/', status: 303 });
		expect(hasOwner(db())).toBe(true);
		expect(cookies.options.get(SESSION_COOKIE)).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: false, path: '/' });

		const again = await setup({ token, name: 'zweiter', password: PW, confirm: PW }, '10.0.0.3');
		expect(isActionFailure(again) && again.status).toBe(403);
		expect(await run(() => setupLoad(event('/setup', jar())))).toEqual({ redirect: '/login', status: 303 });
		expect(await guard('/')).toEqual({ redirect: '/login', status: 303 });
	});

	it('Login setzt ein Cookie mit Secure außerhalb von localhost, der Guard lässt es durch', async () => {
		const cookies = jar();
		expect(await login({ name: 'owner', password: PW }, { origin: 'https://studio.example', ip: '10.0.0.4' }, cookies)).toEqual({
			redirect: '/',
			status: 303
		});
		expect(cookies.options.get(SESSION_COOKIE)).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, maxAge: 30 * 86_400 });
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
		expect(await login({ name: 'owner', password: PW }, { ip: '10.0.0.6' })).toEqual({ redirect: '/', status: 303 });
	});

	it('Logout löscht Session und Cookie; das alte Token führt wieder auf /login', async () => {
		const sessionToken = createSession(db(), 1);
		const cookies = jar({ [SESSION_COOKIE]: sessionToken });
		expect(await run(() => logout(event('/logout', cookies, { form: {} })))).toEqual({ redirect: '/login', status: 303 });
		expect(cookies.options.get(SESSION_COOKIE)).toMatchObject({ deleted: true, path: '/', httpOnly: true, secure: false });

		const stale = jar({ [SESSION_COOKIE]: sessionToken });
		expect(await guard('/', stale)).toEqual({ redirect: '/login', status: 303 });
		expect(stale.options.get(SESSION_COOKIE)?.deleted).toBe(true);
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
		expect(await guard('/', jar({ [SESSION_COOKIE]: sessionToken }))).toEqual({ redirect: '/login', status: 303 });
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
