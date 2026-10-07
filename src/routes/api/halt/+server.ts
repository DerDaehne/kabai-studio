import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { Actor } from '$lib/server/domain/core';
import { DomainError } from '$lib/server/domain/error';
import { haltKind, resumeAll } from '$lib/server/domain/halt';
import { runner } from '$lib/server/runner';
import type { RequestHandler } from './$types';

// The global guard in hooks.server.ts lets only the owner's session reach these, and refuses writes from other origins.
const OWNER: Actor = { kind: 'user' };

/** `:stop`, the kill switch: cancels every active run and keeps the queue waiting until DELETE. */
export const POST: RequestHandler = () => json({ cancelled: runner().halt(OWNER).length });

/**
 * `:fortsetzen all`: resumes every run the human paused and lifts the halt, naming the kind it lifted and any run it
 * had to skip. A DomainError that is not per-run (e.g. a future caller without human rights) comes back as 400, so a
 * refusal is never indistinguishable from a server crash.
 */
export const DELETE: RequestHandler = () => {
	const released = haltKind(db());
	try {
		const { resumed, skipped } = resumeAll(db(), OWNER);
		return json({ resumed: resumed.length, released, skipped });
	} catch (err) {
		if (!(err instanceof DomainError)) throw err;
		return json({ code: err.code, message: err.message, hint: err.hint }, { status: 400 });
	}
};
