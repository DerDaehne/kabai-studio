import type { DatabaseSync } from 'node:sqlite';
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
import { OPEN_QUESTION, projectRef } from '$lib/server/live';
import type { QueuedQuestion } from './queue';
import type { Actions, PageServerLoad } from './$types';

const HUMAN: Actor = { kind: 'user' };

type QuestionRow = {
	id: number;
	question: string;
	options: string;
	createdAt: string;
	number: number;
	title: string;
	projectId: number;
	key: string;
	name: string;
	profile: string | null;
	runId: number | null;
};

// The same open questions the head's Takt title counts, so the queue and the count never disagree.
const OPEN_QUESTIONS = `
	SELECT q.id, q.question, q.options, q.created_at AS createdAt, t.number, t.title,
		p.id AS projectId, p.key, p.name, ap.name AS profile, q.run_id AS runId
	FROM questions q
	JOIN tickets t ON t.id = q.ticket_id
	JOIN projects p ON p.id = t.project_id
	LEFT JOIN runs r ON r.id = q.run_id
	LEFT JOIN agent_profiles ap ON ap.id = r.agent_profile_id
	WHERE p.archived = 0 AND ${OPEN_QUESTION}
	ORDER BY q.id`;

function openQuestions(db: DatabaseSync): QueuedQuestion[] {
	return (db.prepare(OPEN_QUESTIONS).all() as QuestionRow[]).map((row) => ({
		id: row.id,
		ticket: { ref: `${row.key}-${row.number}`, number: row.number, title: row.title },
		project: projectRef({ id: row.projectId, key: row.key, name: row.name }),
		profile: row.profile,
		runId: row.runId,
		askedAt: new Date(`${row.createdAt.replace(' ', 'T')}Z`).toISOString(), // SQLite stores UTC without a zone
		question: row.question,
		options: JSON.parse(row.options)
	}));
}

// The layout reloads LIVE_DEPENDENCY on every question event, so new questions arrive without a reload of their own.
export const load: PageServerLoad = ({ depends }) => {
	depends(LIVE_DEPENDENCY);
	return { questions: openQuestions(db()), undoWindowMs: ANSWER_UNDO_WINDOW_MS };
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
