import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import { subscribe, type StudioEvent } from '../events';
import * as board from './board';
import { DomainError, type Actor } from './core';
import * as questions from './questions';
import * as runs from './runs';

const user: Actor = { kind: 'user' };

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const ticketId = board.createTicket(db, user, projectId, { title: 'T' }).id;
	const profileId = runs.createProfile(db, user, { name: 'Test', executor: 'builtin', provider: 'openai-compatible', model: 'm' }).id;
	const agent: Actor = { kind: 'agent', runId: runs.createRun(db, user, { ticketId, profileId }).id };
	const column = () => db.prepare('SELECT c.name FROM tickets t JOIN columns c ON c.id = t.column_id WHERE t.id = ?').get(ticketId)?.name;
	const ask = (options?: questions.QuestionOption[]) => questions.requestHuman(db, agent, ticketId, { question: 'A oder B?', options }).id;
	return { db, ticketId, agent, column, ask };
}

function caught(fn: () => unknown): DomainError {
	try {
		fn();
	} catch (err) {
		if (err instanceof DomainError) return err;
		throw err;
	}
	throw new Error('expected a DomainError');
}

describe('requestHuman', () => {
	it('records the question as comment and question and moves the ticket to human intervention', () => {
		const { db, ticketId, agent, column, ask } = setup();
		const id = ask([{ label: 'A', effect: 'schnell' }, { label: 'B' }]);
		expect(column()).toBe('Human Intervention');
		expect(db.prepare('SELECT author, body, run_id FROM comments WHERE ticket_id = ?').get(ticketId)).toEqual({
			author: 'agent (Run 1)',
			body: 'A oder B?\n1. A — schnell\n2. B',
			run_id: agent.runId
		});
		expect(db.prepare('SELECT run_id, options, answer FROM questions WHERE id = ?').get(id)).toEqual({
			run_id: agent.runId,
			options: '[{"label":"A","effect":"schnell"},{"label":"B"}]',
			answer: null
		});
	});

	it('rejects more than three options, blank labels and a blank question without writing anything', () => {
		const { db, agent, ticketId, column, ask } = setup();
		const four = [{ label: '1' }, { label: '2' }, { label: '3' }, { label: '4' }];
		expect(caught(() => ask(four)).code).toBe('too_many_options');
		expect(caught(() => ask([{ label: '  ' }])).code).toBe('empty_option');
		expect(caught(() => questions.requestHuman(db, agent, ticketId, { question: ' ' })).code).toBe('empty_question');
		expect(column()).toBe('Backlog');
		expect(db.prepare('SELECT count(*) AS n FROM questions').get()?.n).toBe(0);
		expect(db.prepare('SELECT count(*) AS n FROM comments').get()?.n).toBe(0);
	});
});

describe('answers', () => {
	it('only the human answers, and only with an existing option or non-empty text', () => {
		const { db, agent, ask } = setup();
		const id = ask([{ label: 'A' }, { label: 'B' }]);
		expect(caught(() => questions.answerQuestion(db, agent, id, { option: 1 })).code).toBe('requires_human');
		expect(caught(() => questions.answerQuestion(db, user, id, { option: 3 })).message).toContain('1–2');
		expect(caught(() => questions.answerQuestion(db, user, id, { text: ' ' })).code).toBe('invalid_answer');
		questions.answerQuestion(db, user, id, { option: 2 });
		expect(db.prepare('SELECT answer FROM questions WHERE id = ?').get(id)?.answer).toBe('{"option":2}');
	});

	it('the human can retract or change an answer until the agent collects it; afterwards it is final', () => {
		const { db, ticketId, agent, ask } = setup();
		const id = ask([{ label: 'A' }, { label: 'B' }]);
		expect(questions.collectAnswer(db, agent, ticketId)).toBeUndefined();
		questions.answerQuestion(db, user, id, { option: 1 });
		questions.retractAnswer(db, user, id);
		expect(caught(() => questions.retractAnswer(db, user, id)).code).toBe('not_answered');
		questions.answerQuestion(db, user, id, { text: 'Weder noch, C.' });

		const collected = questions.collectAnswer(db, agent, ticketId);
		expect(collected).toEqual({ id, question: 'A oder B?', options: [{ label: 'A' }, { label: 'B' }], answer: { text: 'Weder noch, C.' } });
		const late = caught(() => questions.retractAnswer(db, user, id));
		expect(late.code).toBe('answer_collected');
		expect(late.message).toContain('schon übernommen');
		expect(caught(() => questions.answerQuestion(db, user, id, { option: 1 })).code).toBe('answer_collected');
		expect(questions.collectAnswer(db, agent, ticketId)?.answer).toEqual({ text: 'Weder noch, C.' });
	});

	it('announces asking, answering, retracting and collecting on the bus', () => {
		const { db, ticketId, agent, ask } = setup();
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));
		const id = ask();
		questions.answerQuestion(db, user, id, { text: 'Ja' });
		questions.retractAnswer(db, user, id);
		questions.answerQuestion(db, user, id, { text: 'Ja' });
		questions.collectAnswer(db, agent, ticketId);
		questions.collectAnswer(db, agent, ticketId);
		off();
		expect(events.filter((e) => e.type.startsWith('question.')).map((e) => e.type)).toEqual([
			'question.asked',
			'question.answered',
			'question.retracted',
			'question.answered',
			'question.collected'
		]);
	});
});
