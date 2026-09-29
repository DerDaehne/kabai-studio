import { error } from '@sveltejs/kit';
import { eventStream, SSE_HEADERS } from '$lib/server/sse';
import type { RequestHandler } from './$types';

// Session-Pflicht erzwingt bereits der globale Guard in hooks.server.ts (401 JSON für /api/* ohne Session, #766,
// geprüft in hooks.server.test.ts) — dieser Handler läuft nur mit gültiger event.locals.user.
export const GET: RequestHandler = ({ url }) => {
	const projectId = Number(url.searchParams.get('project'));
	if (!Number.isInteger(projectId) || projectId <= 0) error(400, 'project fehlt oder ist ungültig');

	return new Response(eventStream((event) => event.projectId === projectId), { headers: SSE_HEADERS });
};
