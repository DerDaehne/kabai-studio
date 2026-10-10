import { LIVE_DEPENDENCY } from '$lib/live';
import { db } from '$lib/server/db';
import { liveState } from '$lib/server/live';
import type { LayoutServerLoad } from './$types';

// /login and /setup run without a session and without the shell, so they get no live state.
export const load: LayoutServerLoad = ({ locals, depends }) => {
	if (!locals.user) return {};
	depends(LIVE_DEPENDENCY);
	return { live: liveState(db()) };
};
