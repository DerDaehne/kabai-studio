import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from '../db';
import { subscribe, type StudioEvent } from '../events';
import * as board from './board';
import { DomainError, type Actor } from './core';
import * as questions from './questions';
import * as runs from './runs';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };

function setup(startColumn = 'Backlog') {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const columnId = (name: string) =>
		db.prepare('SELECT id FROM columns WHERE project_id = ? AND name = ?').get(projectId, name)!
			.id as number;
	const ticketId = board.createTicket(db, user, projectId, {
		title: 'T',
		column_id: columnId(startColumn)
	}).id;
	const profileId = runs.createProfile(db, user, {
		name: 'Test',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const agent: Actor = {
		kind: 'agent',
		runId: runs.createRun(db, user, { ticketId, profileId }).id
	};
	const column = () =>
		db
			.prepare('SELECT c.name FROM tickets t JOIN columns c ON c.id = t.column_id WHERE t.id = ?')
			.get(ticketId)?.name;
	const ask = (options?: questions.QuestionOption[]) =>
		questions.requestHuman(db, agent, ticketId, { question: 'A oder B?', options }).id;
	const comments = () =>
		db.prepare('SELECT author_kind, author, body FROM comments ORDER BY id').all();
	return { db, ticketId, profileId, agent, column, columnId, ask, comments };
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
		expect(
			db.prepare('SELECT author, body, run_id FROM comments WHERE ticket_id = ?').get(ticketId)
		).toEqual({
			author: 'agent (Run 1)',
			body: 'A oder B?\n1. A — schnell\n2. B',
			run_id: agent.runId
		});
		expect(
			db.prepare('SELECT run_id, options, answer FROM questions WHERE id = ?').get(id)
		).toEqual({
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
		expect(caught(() => questions.requestHuman(db, agent, ticketId, { question: ' ' })).code).toBe(
			'empty_question'
		);
		expect(column()).toBe('Backlog');
		expect(db.prepare('SELECT count(*) AS n FROM questions').get()?.n).toBe(0);
		expect(db.prepare('SELECT count(*) AS n FROM comments').get()?.n).toBe(0);
	});
});

describe('latestOpenQuestion', () => {
	it('is undefined without a question, and reports the newest one while it has no answer yet', () => {
		const { db, ticketId, ask } = setup();
		expect(questions.latestOpenQuestion(db, ticketId)).toBeUndefined();
		const id = ask([{ label: 'A' }, { label: 'B' }]);
		expect(questions.latestOpenQuestion(db, ticketId)).toEqual({
			id,
			question: 'A oder B?',
			options: [{ label: 'A' }, { label: 'B' }],
			answer: null
		});
	});

	it('stops reporting a question once the human answers it, without collecting or changing anything', () => {
		const { db, ticketId, ask } = setup();
		const id = ask();
		questions.answerQuestion(db, user, id, { text: 'Ja' });
		expect(questions.latestOpenQuestion(db, ticketId)).toBeUndefined();
		// a pure read: neither collected_at nor the answer itself moved
		expect(db.prepare('SELECT answer, collected_at FROM questions WHERE id = ?').get(id)).toEqual({
			answer: '{"text":"Ja"}',
			collected_at: null
		});
	});
});

describe('answers', () => {
	it('only the human answers, and only with an existing option or non-empty text', () => {
		const { db, agent, ask } = setup();
		const id = ask([{ label: 'A' }, { label: 'B' }]);
		expect(caught(() => questions.answerQuestion(db, agent, id, { option: 1 })).code).toBe(
			'requires_human'
		);
		expect(caught(() => questions.answerQuestion(db, user, id, { option: 3 })).message).toContain(
			'1–2'
		);
		expect(caught(() => questions.answerQuestion(db, user, id, { text: ' ' })).code).toBe(
			'invalid_answer'
		);
		questions.answerQuestion(db, user, id, { option: 2 });
		expect(db.prepare('SELECT answer FROM questions WHERE id = ?').get(id)?.answer).toBe(
			'{"option":2}'
		);
	});

	it('the human can retract or change an answer until the agent collects it; afterwards it is final', () => {
		const { db, ticketId, agent, ask } = setup();
		const id = ask([{ label: 'A' }, { label: 'B' }]);
		expect(questions.collectAnswer(db, agent, ticketId)?.answer).toBeNull();
		questions.answerQuestion(db, user, id, { option: 1 });
		questions.retractAnswer(db, user, id);
		expect(caught(() => questions.retractAnswer(db, user, id)).code).toBe('not_answered');
		questions.answerQuestion(db, user, id, { text: 'Weder noch, C.' });

		const collected = questions.collectAnswer(db, agent, ticketId);
		expect(collected).toEqual({
			id,
			question: 'A oder B?',
			options: [{ label: 'A' }, { label: 'B' }],
			answer: { text: 'Weder noch, C.' }
		});
		const late = caught(() => questions.retractAnswer(db, user, id));
		expect(late.code).toBe('answer_collected');
		expect(late.message).toContain('schon übernommen');
		expect(caught(() => questions.answerQuestion(db, user, id, { option: 1 })).code).toBe(
			'answer_collected'
		);
		expect(questions.collectAnswer(db, agent, ticketId)?.answer).toEqual({
			text: 'Weder noch, C.'
		});
	});

	it('reports only the newest question, so an old answer never stands for a newer open question', () => {
		const { db, ticketId, agent, ask } = setup();
		const first = ask([{ label: 'A' }, { label: 'B' }]);
		questions.answerQuestion(db, user, first, { option: 1 });
		expect(questions.collectAnswer(db, agent, ticketId)).toMatchObject({
			id: first,
			answer: { option: 1 }
		});

		const second = questions.requestHuman(db, agent, ticketId, { question: 'C oder D?' }).id;
		expect(questions.collectAnswer(db, agent, ticketId)).toEqual({
			id: second,
			question: 'C oder D?',
			options: [],
			answer: null
		});
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

describe('an answer continues the paused run', () => {
	const answeredAt = new Date('2026-10-03T12:00:00.000Z');
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(answeredAt);
	});
	afterEach(() => vi.useRealTimers());

	/** A run working in "In Arbeit" that asked the human and paused, as an executor ends after request_human. */
	function pausedAfterAsking() {
		const s = setup('In Arbeit');
		const pausedRun = s.agent.runId!;
		runs.startRun(s.db, system, pausedRun);
		const id = s.ask([{ label: 'A' }, { label: 'B' }]);
		runs.finishRun(s.db, system, pausedRun, { state: 'paused' });
		const followUps = () =>
			s.db
				.prepare(
					'SELECT id, state, trigger, priority, resumed_from_run_id, resume_reason, not_before, column_id FROM runs WHERE id <> ? ORDER BY id'
				)
				.all(pausedRun);
		const answer = () =>
			s.db.prepare('SELECT answer FROM questions WHERE id = ?').get(id)!.answer as string | null;
		return { ...s, id, pausedRun, followUps, answer };
	}

	it('returns the ticket to the column of the paused run and queues its follow-up with human priority behind a 10 s undo window', () => {
		const s = pausedAfterAsking();
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));

		questions.answerQuestion(s.db, user, s.id, { option: 2 });
		off();

		expect(s.column()).toBe('In Arbeit');
		expect(s.followUps()).toEqual([
			{
				id: expect.any(Number),
				state: 'queued',
				trigger: 'resume',
				priority: 'human',
				resumed_from_run_id: s.pausedRun,
				resume_reason: null,
				not_before: '2026-10-03T12:00:10.000Z',
				column_id: s.columnId('In Arbeit')
			}
		]);
		expect(runs.freshRunsInChain(s.db, s.followUps()[0].id as number)).toBe(0);
		expect(events.map((e) => e.type)).toEqual(
			expect.arrayContaining(['question.answered', 'ticket.moved', 'run.created'])
		);
	});

	it('clears a review approval on the way back, like every return from human intervention', () => {
		const s = pausedAfterAsking();
		board.approveReview(s.db, user, s.ticketId);
		questions.answerQuestion(s.db, user, s.id, { option: 1 });
		expect(
			s.db.prepare('SELECT review_approved_at FROM tickets WHERE id = ?').get(s.ticketId)
		).toEqual({ review_approved_at: null });
	});

	it('replaces the answer given before the follow-up run starts, restarts the undo window and queues no second run', () => {
		const s = pausedAfterAsking();
		questions.answerQuestion(s.db, user, s.id, { option: 1 });
		const [first] = s.followUps();
		vi.setSystemTime(new Date('2026-10-03T12:00:08.000Z'));

		questions.answerQuestion(s.db, user, s.id, { text: 'Weder noch, C.' });

		expect(s.answer()).toBe('{"text":"Weder noch, C."}');
		expect(s.followUps()).toEqual([{ ...first, not_before: '2026-10-03T12:00:18.000Z' }]);
		expect(s.column()).toBe('In Arbeit');
	});

	it('takes the answer back before the follow-up run starts: the run is cancelled, the ticket waits in human intervention again', () => {
		const s = pausedAfterAsking();
		questions.answerQuestion(s.db, user, s.id, { option: 1 });
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));

		questions.retractAnswer(s.db, user, s.id);
		off();

		expect(s.answer()).toBeNull();
		expect(s.followUps()).toMatchObject([{ state: 'cancelled' }]);
		expect(s.column()).toBe('Human Intervention');
		expect(events.map((e) => e.type)).toEqual(
			expect.arrayContaining(['run.state_changed', 'ticket.moved', 'question.retracted'])
		);

		questions.answerQuestion(s.db, user, s.id, { option: 2 });
		expect(s.followUps()).toMatchObject([{ state: 'cancelled' }, { state: 'queued' }]);
		expect(s.column()).toBe('In Arbeit');
	});

	it('refuses to take back or change an answer once the follow-up run has started, with a way out, and changes nothing', () => {
		const s = pausedAfterAsking();
		questions.answerQuestion(s.db, user, s.id, { option: 1 });
		const followUp = s.followUps()[0].id as number;
		runs.startRun(s.db, system, followUp);

		const retracted = caught(() => questions.retractAnswer(s.db, user, s.id));
		expect(retracted.code).toBe('answer_in_use');
		expect(retracted.message).toContain(`Run ${followUp}`);
		expect(retracted.hint).toContain('Kommentar');
		expect(retracted.hint).toContain(`Run ${followUp}`);
		expect(caught(() => questions.answerQuestion(s.db, user, s.id, { option: 2 })).code).toBe(
			'answer_in_use'
		);
		expect(s.answer()).toBe('{"option":1}');
		expect(s.followUps()).toMatchObject([{ id: followUp, state: 'running' }]);
		expect(s.column()).toBe('In Arbeit');
	});

	it('writes only the final answer to the history, as a comment of the human, when the agent collects it', () => {
		const s = pausedAfterAsking();
		const commentsBefore = s.comments();
		questions.answerQuestion(s.db, user, s.id, { option: 1 });
		questions.retractAnswer(s.db, user, s.id);
		questions.answerQuestion(s.db, user, s.id, { option: 2 });
		expect(s.comments()).toEqual(commentsBefore);

		const resumed: Actor = { kind: 'agent', runId: s.followUps()[1].id as number };
		questions.collectAnswer(s.db, resumed, s.ticketId);
		questions.collectAnswer(s.db, resumed, s.ticketId);

		expect(s.comments()).toEqual([
			...commentsBefore,
			{ author_kind: 'user', author: 'user', body: 'Antwort: 2. B' }
		]);
	});

	it('writes a free answer to the history as given', () => {
		const s = pausedAfterAsking();
		questions.answerQuestion(s.db, user, s.id, { text: 'Weder noch, C.' });
		questions.collectAnswer(s.db, { kind: 'agent', runId: s.pausedRun }, s.ticketId);
		expect(s.comments().at(-1)).toEqual({
			author_kind: 'user',
			author: 'user',
			body: 'Antwort: Weder noch, C.'
		});
	});

	it('leaves the ticket where the human moved it, and still continues the run', () => {
		const s = pausedAfterAsking();
		board.moveTicket(s.db, user, s.ticketId, s.columnId('Human Answered'));
		questions.answerQuestion(s.db, user, s.id, { option: 1 });
		expect(s.column()).toBe('Human Answered');
		expect(s.followUps()).toMatchObject([
			{ state: 'queued', column_id: s.columnId('Human Answered') }
		]);
	});

	it('sends the ticket to human answered when the column of the paused run no longer exists, and still continues the run', () => {
		const s = pausedAfterAsking();
		s.db.prepare('DELETE FROM columns WHERE id = ?').run(s.columnId('In Arbeit'));
		questions.answerQuestion(s.db, user, s.id, { option: 1 });
		expect(s.column()).toBe('Human Answered');
		expect(s.followUps()).toMatchObject([
			{ state: 'queued', column_id: s.columnId('Human Answered') }
		]);
	});

	it.each([
		{
			case: 'a question no run asked',
			ask: (s: ReturnType<typeof setup>) =>
				questions.requestHuman(s.db, user, s.ticketId, { question: 'A oder B?' }).id,
			reason: 'die Frage stammt aus keinem Run'
		},
		{
			case: 'a run that is not paused',
			ask: (s: ReturnType<typeof setup>) => s.ask(),
			reason: 'Run 1 ist „queued“, nicht pausiert'
		},
		{
			case: 'a paused run whose profile was deleted',
			ask: (s: ReturnType<typeof setup>) => {
				runs.startRun(s.db, system, s.agent.runId!);
				const id = s.ask();
				runs.finishRun(s.db, system, s.agent.runId!, { state: 'paused' });
				runs.deleteProfile(s.db, user, s.profileId);
				return id;
			},
			reason: 'das Agent-Profil von Run 1 ist gelöscht'
		}
	])(
		'keeps the answer to $case, moves the ticket to human answered and says how to go on',
		({ ask, reason }) => {
			const s = setup('In Arbeit');
			const id = ask(s);

			questions.answerQuestion(s.db, user, id, { text: 'Ja' });

			expect(s.db.prepare('SELECT answer FROM questions WHERE id = ?').get(id)).toEqual({
				answer: '{"text":"Ja"}'
			});
			expect(s.column()).toBe('Human Answered');
			expect(s.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
			expect(s.comments().at(-1)).toEqual({
				author_kind: 'system',
				author: 'system',
				body: `Die Antwort auf Frage ${id} setzt keinen Run fort: ${reason}.\nAusweg: Starte einen Run für das Ticket, er liest die Antwort.`
			});
		}
	);
});
