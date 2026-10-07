import { attemptJson } from '$lib/server/domain-failure';
import type { Actor } from '$lib/server/domain/core';
import { runner } from '$lib/server/runner';
import type { RequestHandler } from './$types';

// The global guard in hooks.server.ts lets only the owner's session reach this, and refuses writes from other origins.
const OWNER: Actor = { kind: 'user' };

/**
 * `:anhalten` outside a Run-Akte: pauses every active run and keeps the queue waiting until `DELETE /api/halt`.
 * A DomainError (e.g. a future caller without human rights) comes back as 400, not a 500.
 */
export const POST: RequestHandler = () =>
	attemptJson(() => ({ paused: runner().pauseAll(OWNER).length }));
