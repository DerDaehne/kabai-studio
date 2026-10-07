import { db } from '$lib/server/db';
import { recentFinishedRuns } from '$lib/server/live';
import { LIVE_DEPENDENCY } from '$lib/shell/live.svelte';
import type { PageServerLoad } from './$types';

// The last-finished list changes on the same events as the root layout's data.live, so it rides the same stream.
export const load: PageServerLoad = ({ locals, depends }) => {
	depends(LIVE_DEPENDENCY);
	return { user: locals.user!, finishedRuns: recentFinishedRuns(db()) }; // the guard in hooks.server.ts guarantees the session
};
