import { LIVE_DEPENDENCY } from '$lib/live';
import { rateLimiter } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { DomainError, type Actor } from '$lib/server/domain/core';
import { attempt } from '$lib/server/domain-failure';
import {
	ANSWER_HOLD_BEAT_MS,
	ANSWER_UNDO_WINDOW_MS,
	answerQuestion,
	holdAnswerWindow,
	retractAnswer,
	type Answer
} from '$lib/server/domain/questions';
import { taktView } from '$lib/server/takt-view';
import type { Actions, PageServerLoad } from './$types';

const HUMAN: Actor = { kind: 'user' };
const holdLimiter = rateLimiter(30, 60_000);

// The layout reloads LIVE_DEPENDENCY on every question event, so new questions arrive without a reload of their own.
export const load: PageServerLoad = ({ depends }) => {
	depends(LIVE_DEPENDENCY);
	return {
		...taktView(db()),
		undoWindowMs: ANSWER_UNDO_WINDOW_MS,
		holdBeatMs: ANSWER_HOLD_BEAT_MS
	};
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
	hold: async ({ request, locals }) => {
		const form = await request.formData();
		return attempt(() => {
			// nominally 12 beats a minute per open notice; the limit only stops a runaway client
			if (!holdLimiter.attempt(String(locals.user?.id)))
				throw new DomainError(
					'rate_limited',
					'Zu viele Halte-Schläge in kurzer Zeit.',
					'Lass das Rückgängig-Fenster auslaufen oder nimm die Antwort zurück; in einer Minute geht es wieder.'
				);
			return holdAnswerWindow(db(), HUMAN, Number(form.get('question')));
		});
	},
	retract: async ({ request }) => {
		const form = await request.formData();
		return attempt(() => retractAnswer(db(), HUMAN, Number(form.get('question'))));
	}
};
