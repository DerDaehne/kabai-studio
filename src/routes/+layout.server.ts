import { LIVE_DEPENDENCY } from '$lib/live';
import { db } from '$lib/server/db';
import { liveState } from '$lib/server/live';
import type { LayoutServerLoad } from './$types';

// /login and /setup run without a session and without the shell, so they get no live state.
export const load: LayoutServerLoad = ({ locals, depends }) => {
	if (!locals.user) return { locale: locals.locale };
	depends(LIVE_DEPENDENCY);
	return { locale: locals.locale, live: liveState(db()) };
};
