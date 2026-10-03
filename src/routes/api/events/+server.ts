import { error } from '@sveltejs/kit';
import { SESSION_COOKIE, validateSession } from '$lib/server/auth';
import { db } from '$lib/server/db';
import type { StudioEvent } from '$lib/server/events';
import { eventStream, SSE_HEADERS } from '$lib/server/sse';
import type { RequestHandler } from './$types';

// The global guard in hooks.server.ts requires a session to open the stream (401 JSON for /api/* without one).
// The stream itself checks the session again before every event and heartbeat: logout, reset-password and expiry end it.
export const GET: RequestHandler = ({ url, cookies }) => {
	const token = cookies.get(SESSION_COOKIE)!; // without a valid cookie the request would not pass the guard
	const stream = eventStream(projectFilter(url), {
		alive: () => validateSession(db(), token, Date.now(), { renew: false }) !== null // check only: the cookie cannot be set here any more
	});
	return new Response(stream, { headers: SSE_HEADERS });
};

/** Without `project` the single owner gets the events of every project; events without a project reach every stream. */
function projectFilter(url: URL): (event: StudioEvent) => boolean {
	if (!url.searchParams.has('project')) return () => true;
	const projectId = Number(url.searchParams.get('project'));
	if (!Number.isInteger(projectId) || projectId <= 0) error(400, 'project ist ungültig');
	return (event) => event.projectId === undefined || event.projectId === projectId;
}
