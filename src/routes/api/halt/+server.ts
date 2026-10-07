import { db } from '$lib/server/db';
import { attemptJson } from '$lib/server/domain-failure';
import type { Actor } from '$lib/server/domain/core';
import { haltKind, resumeAll } from '$lib/server/domain/halt';
import { runner } from '$lib/server/runner';
import type { RequestHandler } from './$types';

// The global guard in hooks.server.ts lets only the owner's session reach these, and refuses writes from other origins.
const OWNER: Actor = { kind: 'user' };

/** `:stop`, the kill switch: cancels every active run and keeps the queue waiting until DELETE. */
export const POST: RequestHandler = () =>
	attemptJson(() => ({ cancelled: runner().halt(OWNER).length }));

/**
 * `:fortsetzen all`: resumes every run the human paused and lifts the halt, naming the kind it lifted and any run it
 * had to skip. A DomainError that is not per-run (e.g. a future caller without human rights) comes back as 400, so a
 * refusal is never indistinguishable from a server crash.
 */
export const DELETE: RequestHandler = () => {
	const released = haltKind(db());
	return attemptJson(() => {
		const { resumed, skipped } = resumeAll(db(), OWNER);
		return { resumed: resumed.length, released, skipped };
	});
};
