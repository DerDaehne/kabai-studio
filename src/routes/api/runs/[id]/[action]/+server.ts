import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { attemptJson } from '$lib/server/domain-failure';
import type { Actor } from '$lib/server/domain/core';
import { resumeRun } from '$lib/server/domain/halt';
import { runner } from '$lib/server/runner';
import type { RequestHandler } from './$types';

// The global guard in hooks.server.ts lets only the owner's session reach this, and refuses writes from other origins.
const OWNER: Actor = { kind: 'user' };

const ACTIONS: Record<string, (runId: number) => object> = {
	pause: (runId) => {
		runner().pause(runId, OWNER);
		return { paused: 1 };
	},
	resume: (runId) => {
		resumeRun(db(), OWNER, runId);
		return { resumed: 1 };
	}
};

/** Pauses (`:anhalten` in the Run-Akte) or resumes (`:fortsetzen N`) one run; a refusal comes back with its way out. */
export const POST: RequestHandler = ({ params }) => {
	const action = ACTIONS[params.action];
	if (!action || !/^\d+$/.test(params.id)) error(404, 'Diese Aktion gibt es nicht.');
	return attemptJson(() => action(Number(params.id)));
};
