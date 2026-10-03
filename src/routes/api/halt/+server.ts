import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { Actor } from '$lib/server/domain/core';
import { releaseHalt } from '$lib/server/domain/halt';
import { runner } from '$lib/server/runner';
import type { RequestHandler } from './$types';

// The global guard in hooks.server.ts lets only the owner's session reach these, and refuses writes from other origins.
const OWNER: Actor = { kind: 'user' };

/** The kill switch: cancels every active run and keeps the queue waiting until DELETE. */
export const POST: RequestHandler = () => json({ cancelled: runner().halt(OWNER).length });

export const DELETE: RequestHandler = () => {
	releaseHalt(db(), OWNER);
	return new Response(null, { status: 204 });
};
