import { LIVE_DEPENDENCY } from '$lib/live';
import { db } from '$lib/server/db';
import type { Actor } from '$lib/server/domain/core';
import { attempt } from '$lib/server/domain-failure';
import {
	ANSWER_UNDO_WINDOW_MS,
	answerQuestion,
	retractAnswer,
	type Answer
} from '$lib/server/domain/questions';
import { taktView } from '$lib/server/takt-view';
import type { Actions, PageServerLoad } from './$types';

const HUMAN: Actor = { kind: 'user' };

// The layout reloads LIVE_DEPENDENCY on every question event, so new questions arrive without a reload of their own.
export const load: PageServerLoad = ({ depends }) => {
	depends(LIVE_DEPENDENCY);
	return { ...taktView(db()), undoWindowMs: ANSWER_UNDO_WINDOW_MS };
};

function answerFrom(form: FormData): Answer {
	const text = form.get('text');
	return text === null ? { option: Number(form.get('option')) } : { text: String(text) };
}

export const actions: Actions = {
	answer: async ({ request }) => {
		const form = await request.formData();
		return attempt(() =>
			answerQuestion(db(), HUMAN, Number(form.get('question')), answerFrom(form))
		);
	},
	retract: async ({ request }) => {
		const form = await request.formData();
		return attempt(() => retractAnswer(db(), HUMAN, Number(form.get('question'))));
	}
};
