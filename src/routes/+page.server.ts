import { LIVE_DEPENDENCY } from '$lib/live';
import { db } from '$lib/server/db';
import { attempt } from '$lib/server/domain-failure';
import { ANSWER_HOLD_BEAT_MS, ANSWER_UNDO_WINDOW_MS } from '$lib/server/domain/questions';
import { openQuestions } from '$lib/server/live';
import { runner } from '$lib/server/runner';
import { startView } from '$lib/server/start-view';
import type { Actions, PageServerLoad } from './$types';

// Questions, queue and finished runs change on the same events as the root layout's data.live, so they ride the
// same stream; answers go to the Takt's own actions, so both places take them back the same way.
export const load: PageServerLoad = ({ depends }) => {
	depends(LIVE_DEPENDENCY);
	return {
		questions: openQuestions(db()),
		undoWindowMs: ANSWER_UNDO_WINDOW_MS,
		holdBeatMs: ANSWER_HOLD_BEAT_MS,
		...startView(db())
	};
};

export const actions: Actions = {
	stop: async ({ request }) => {
		const runId = Number((await request.formData()).get('runId'));
		return attempt(() => runner().cancel(runId, { kind: 'user' }));
	}
};
