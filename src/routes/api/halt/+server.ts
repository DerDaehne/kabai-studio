import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { Actor } from '$lib/server/domain/core';
import { haltKind, resumeAll } from '$lib/server/domain/halt';
import { runner } from '$lib/server/runner';
import type { RequestHandler } from './$types';

// The global guard in hooks.server.ts lets only the owner's session reach these, and refuses writes from other origins.
const OWNER: Actor = { kind: 'user' };

/** `:stop`, the kill switch: cancels every active run and keeps the queue waiting until DELETE. */
export const POST: RequestHandler = () => json({ cancelled: runner().halt(OWNER).length });

/** `:fortsetzen all`: resumes every run the human paused and lifts the halt, naming the kind it lifted. */
export const DELETE: RequestHandler = () => {
	const released = haltKind(db());
	return json({ resumed: resumeAll(db(), OWNER).length, released });
};
