import { json } from '@sveltejs/kit';
import { db, latestMigration } from '$lib/server/db';
import type { RequestHandler } from './$types';

// Public (see hooks.server.ts): lets external monitoring and the container HEALTHCHECK probe liveness without a
// session. Reports only these three fields — no paths, hostnames or counters.
export const GET: RequestHandler = () => {
	const instance = db(); // throws if the data directory is locked by another process or has unknown migrations
	return json({ ok: true, version: __STUDIO_VERSION__, migration: latestMigration(instance) });
};
