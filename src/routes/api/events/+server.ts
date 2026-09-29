import { error } from '@sveltejs/kit';
import { SESSION_COOKIE, validateSession } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { eventStream, SSE_HEADERS } from '$lib/server/sse';
import type { RequestHandler } from './$types';

// Session-Pflicht beim Aufbau erzwingt der globale Guard in hooks.server.ts (401 JSON für /api/* ohne Session, #766).
// Der Stream selbst prüft die Session vor jedem Event und Heartbeat erneut: Logout, reset-password und Ablauf beenden ihn.
export const GET: RequestHandler = ({ url, cookies }) => {
	const projectId = Number(url.searchParams.get('project'));
	if (!Number.isInteger(projectId) || projectId <= 0) error(400, 'project fehlt oder ist ungültig');

	const token = cookies.get(SESSION_COOKIE)!; // ohne gültiges Cookie käme der Request nicht am Guard vorbei
	const stream = eventStream((event) => event.projectId === projectId, { alive: () => validateSession(db(), token) !== null });
	return new Response(stream, { headers: SSE_HEADERS });
};
