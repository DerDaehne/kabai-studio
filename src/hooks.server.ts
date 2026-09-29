import { dev } from '$app/environment';
import { json, redirect, text, type Handle, type ServerInit } from '@sveltejs/kit';
import {
	SESSION_COOKIE,
	clearSessionCookie,
	expiredSessionCookie,
	hasOwner,
	issueSetupToken,
	setSessionCookie,
	validateSession
} from '$lib/server/auth';
import { db } from '$lib/server/db';
import { initSecrets, maskConsole } from '$lib/server/secrets';

// Sicherer Default: adapter-node bindet ohne HOST an 0.0.0.0, bei leerem HOST sogar an alle Interfaces (IPv4+IPv6) —
// sonst wäre /setup im LAN offen (bis #810 die CLI liefert). `||=`, damit auch HOST= (leer) den Default bekommt.
// Greift, weil build/index.js HOST erst liest, nachdem handler.js per `await server.init()` diese Datei geladen hat.
process.env.HOST ||= '127.0.0.1';

export const init: ServerInit = () => {
	maskConsole(); // ab hier läuft jede Log-Zeile durch die Secret-Maskierung
	// adapter-node nimmt ohne ORIGIN https an; Studio spricht selbst HTTP → SvelteKits CSRF-Check weist sonst jedes Formular ab.
	// ORIGIN liest adapter-node vor den Hooks, ein Default hier käme zu spät.
	const origin = process.env.ORIGIN;
	if (!dev && !origin)
		console.log(
			`Hinweis: ORIGIN ist nicht gesetzt — Setup und Anmeldung werden sonst abgewiesen. ` +
				`Neu starten mit ORIGIN=http://127.0.0.1:${process.env.PORT || 3000} und genau diese Adresse im Browser öffnen.`
		);
	// öffnet und migriert die DB, lädt bzw. erzeugt secret.key — einmal beim Start, Fehler brechen den Start ab
	initSecrets(db());
	if (!hasOwner(db())) {
		const token = issueSetupToken();
		console.log(`\nkabai studio: noch kein Owner eingerichtet.\n  Einrichtung: ${origin ?? ''}/setup?token=${token}\n  Setup-Token: ${token}\n`);
	}
};

// Öffentlich nur diese beiden. Statische Dateien liefert adapter-node vor den Hooks aus, /_app/* beantwortet SvelteKit
// selbst vor handle — bis auf Remote Functions (/_app/remote), die deshalb bewusst NICHT ausgenommen sind.
const PUBLIC = new Set(['/login', '/setup']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const handle: Handle = async ({ event, resolve }) => {
	// CSRF auch jenseits von SvelteKits Formular-Check (der nur Formular-Content-Types prüft, z. B. POST /logout ohne Body):
	// Browser senden bei jedem Nicht-GET eine Origin, eine fremde wird abgewiesen. Ohne Origin = kein Browser (CLI, Agent).
	const origin = event.request.headers.get('origin');
	if (!SAFE_METHODS.has(event.request.method) && origin !== null && origin !== event.url.origin)
		return text(`Anfrage von fremder Herkunft abgewiesen. Studio nur direkt über ${event.url.origin} aufrufen.`, { status: 403 });

	const token = event.cookies.get(SESSION_COOKIE);
	const session = token ? validateSession(db(), token) : null;
	if (token && !session) clearSessionCookie(event.cookies, event.url);
	if (session) {
		event.locals.user = session.user;
		if (session.renewed) setSessionCookie(event.cookies, event.url, token!);
	}

	const path = event.url.pathname;
	if (!session && !PUBLIC.has(path)) {
		if (path === '/api' || path.startsWith('/api/')) {
			const res = json({ error: 'unauthorized', hint: 'Keine gültige Session — im Browser unter /login anmelden.' }, { status: 401 });
			// direkt zurückgegebene Antworten bekommen event.cookies nicht angehängt → Löschung selbst setzen
			if (token) res.headers.append('set-cookie', expiredSessionCookie(event.cookies, event.url));
			return res;
		}
		redirect(303, hasOwner(db()) ? '/login' : '/setup');
	}
	return resolve(event);
};
