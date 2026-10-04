import { dev } from '$app/environment';
import {
	json,
	redirect,
	text,
	type Handle,
	type RequestEvent,
	type ServerInit
} from '@sveltejs/kit';
import {
	SESSION_COOKIE,
	clearSessionCookie,
	expiredSessionCookie,
	hasOwner,
	issueSetupToken,
	setSessionCookie,
	validateSession
} from '$lib/server/auth';
import { startBackups } from '$lib/server/backup';
import { backupDir, db } from '$lib/server/db';
import { DomainError, formatError } from '$lib/server/domain/error';
import { builtinExecutor } from '$lib/server/executors/builtin';
import { startRunner } from '$lib/server/runner';
import { initSecrets, maskConsole } from '$lib/server/secrets';

// Safe default: without HOST, adapter-node binds to 0.0.0.0, with an empty HOST even to all interfaces (IPv4+IPv6),
// which would open /setup to the LAN. `||=` so that an empty HOST= gets the default too.
// It takes effect because build/index.js reads HOST only after handler.js has loaded this file via `await server.init()`.
process.env.HOST ||= '127.0.0.1';

export const init: ServerInit = async () => {
	maskConsole(); // from here on every log line passes through the secret masking
	// Without ORIGIN adapter-node assumes https; Studio itself speaks HTTP, so SvelteKit's CSRF check would reject every form.
	// adapter-node reads ORIGIN before the hooks, so a default here would come too late.
	const origin = process.env.ORIGIN;
	if (!dev && !origin)
		console.log(
			`Hinweis: ORIGIN ist nicht gesetzt — Setup und Anmeldung werden sonst abgewiesen. ` +
				`Neu starten mit ORIGIN=http://127.0.0.1:${process.env.PORT || 3000} und genau diese Adresse im Browser öffnen.`
		);
	try {
		// locks the data directory (a second instance aborts here), opens, backs up and migrates the DB, loads or
		// creates secret.key — once at startup
		initSecrets(db());
		startBackups(db(), backupDir()); // backs up now if due, then checks hourly for "older than a day"
		// acp profiles fail with a clear reason until their executor is installed, instead of waiting forever
		startRunner(db(), { builtin: builtinExecutor(db()) });
		if (!hasOwner(db())) {
			const token = issueSetupToken();
			console.log(
				`\nkabai studio: noch kein Owner eingerichtet.\n  Einrichtung: ${origin ?? ''}/setup?token=${token}\n  Setup-Token: ${token}\n`
			);
		}
	} catch (err) {
		// A DomainError is a complete user-facing report; anything else is unexpected and needs its stack and cause.
		if (err instanceof DomainError) console.error(`kabai studio: ${formatError(err)}`);
		else console.error('kabai studio:', err);
		// stderr isn't always written synchronously (e.g. piped, common for a supervised process) — process.exit()
		// right after console.error can cut the line off before it reaches the OS. An empty write queued on the
		// same stream only completes once the error line ahead of it has actually been flushed.
		await new Promise<void>((resolve) => process.stderr.write('', () => resolve()));
		process.exit(1);
	}
};

// Only these two are public. adapter-node serves static files before the hooks, and SvelteKit answers /_app/* itself
// before handle — except remote functions (/_app/remote), which are therefore deliberately NOT exempt.
// SvelteKit strips /__data.json from event.url.pathname before handle runs (respond.js), so /login/__data.json
// already arrives here as /login.
const PUBLIC = new Set(['/login', '/setup']);
/** Agents have no session: the MCP endpoint checks the run's bearer token on every request itself. */
const RUN_TOKEN_PATH = '/mcp';
/** Liveness probe for external monitoring and the container HEALTHCHECK; reports no board data, so no session is required. */
const HEALTH_PATH = '/api/health';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const handle: Handle = async ({ event, resolve }) => {
	if (isCrossOriginWrite(event))
		return text(
			`Anfrage von fremder Herkunft abgewiesen. Studio nur direkt über ${event.url.origin} aufrufen.`,
			{ status: 403 }
		);

	const token = event.cookies.get(SESSION_COOKIE);
	const hasSession = !!token && restoreSession(event, token);
	const path = event.url.pathname;
	if (hasSession || PUBLIC.has(path) || path === RUN_TOKEN_PATH || path === HEALTH_PATH)
		return resolve(event);
	if (path === '/api' || path.startsWith('/api/')) return unauthorizedApiResponse(event, !!token);
	redirect(303, hasOwner(db()) ? '/login' : '/setup');
};

/**
 * CSRF protection beyond SvelteKit's form check, which only covers form content types (e.g. not a bodyless
 * POST /logout): browsers send an Origin with every non-GET request. No Origin means no browser (CLI, agent).
 */
function isCrossOriginWrite(event: RequestEvent): boolean {
	const origin = event.request.headers.get('origin');
	return !SAFE_METHODS.has(event.request.method) && origin !== null && origin !== event.url.origin;
}

/** Sets `locals.user` from a valid session token and renews its cookie; clears the cookie of an invalid one. */
function restoreSession(event: RequestEvent, token: string): boolean {
	const session = validateSession(db(), token);
	if (!session) {
		clearSessionCookie(event.cookies, event.url);
		return false;
	}
	event.locals.user = session.user;
	if (session.renewed) setSessionCookie(event.cookies, event.url, token);
	return true;
}

function unauthorizedApiResponse(event: RequestEvent, hadSessionCookie: boolean): Response {
	const res = json(
		{
			error: 'unauthorized',
			hint: 'Keine gültige Session — im Browser unter /login anmelden.'
		},
		{ status: 401 }
	);
	// Responses returned directly don't get event.cookies attached, so the cookie deletion is set by hand.
	if (hadSessionCookie)
		res.headers.append('set-cookie', expiredSessionCookie(event.cookies, event.url));
	return res;
}
