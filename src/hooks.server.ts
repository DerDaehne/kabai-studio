import { dev } from '$app/environment';
import { json, redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { SESSION_COOKIE, clearSessionCookie, hasOwner, issueSetupToken, setSessionCookie, validateSession } from '$lib/server/auth';
import { db } from '$lib/server/db';

// Sicherer Default: adapter-node bindet ohne HOST an 0.0.0.0 — sonst wäre /setup im LAN offen (bis #810 die CLI liefert).
// Greift, weil build/index.js HOST erst liest, nachdem handler.js per `await server.init()` diese Datei geladen hat.
process.env.HOST ??= '127.0.0.1';

export const init: ServerInit = () => {
	// adapter-node nimmt ohne ORIGIN https an; Studio spricht selbst HTTP → SvelteKits CSRF-Check weist sonst jedes Formular ab.
	// ORIGIN liest adapter-node vor den Hooks, ein Default hier käme zu spät.
	if (!dev && !process.env.ORIGIN) console.log('Hinweis: ORIGIN ist nicht gesetzt — für Anmeldung/Setup z. B. ORIGIN=http://localhost:3000 setzen.');
	// öffnet die DB und migriert — einmal beim Start, Fehler brechen den Start ab
	if (!hasOwner(db())) {
		const token = issueSetupToken();
		console.log(`\nkabai studio: noch kein Owner eingerichtet.\n  Setup-Token: ${token}\n  Einrichtung: /setup?token=${token}\n`);
	}
};

// Öffentlich nur diese beiden. Statische Dateien liefert adapter-node vor den Hooks aus, /_app/* beantwortet SvelteKit
// selbst vor handle — bis auf Remote Functions (/_app/remote), die deshalb bewusst NICHT ausgenommen sind.
const PUBLIC = new Set(['/login', '/setup']);

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE);
	if (token) {
		const session = validateSession(db(), token);
		if (!session) clearSessionCookie(event.cookies, event.url);
		else {
			event.locals.user = session.user;
			if (session.renewed) setSessionCookie(event.cookies, event.url, token);
		}
	}

	const path = event.url.pathname;
	if (!event.locals.user && !PUBLIC.has(path)) {
		if (path === '/api' || path.startsWith('/api/')) return json({ error: 'unauthorized' }, { status: 401 });
		redirect(303, hasOwner(db()) ? '/login' : '/setup');
	}
	return resolve(event);
};
