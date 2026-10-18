import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import { DomainError, type Actor } from './domain/core';
import {
	ANSWER_HOLD_CAP_MS,
	ANSWER_UNDO_WINDOW_MS,
	answerQuestion,
	collectAnswer,
	holdAnswerWindow,
	requestHuman,
	retractAnswer
} from './domain/questions';
import * as runs from './domain/runs';
import type { Executor, ExecutorFacts, RunContext } from './executors/contract';
import { startRunner } from './runner';

const user: Actor = { kind: 'user' };
const agent = (runId: number): Actor => ({ kind: 'agent', runId });
const answeredAt = new Date('2026-10-18T12:00:00.000Z');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const stops: (() => void)[] = [];

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
	});
	vi.setSystemTime(answeredAt);
});
afterEach(() => {
	stops.splice(0).forEach((stop) => stop());
	vi.useRealTimers();
});

/** The runner is real; its executor starts runs and lets the test end them. */
function studio() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const ticketId = board.createTicket(db, user, projectId, {
		title: 'T',
		column_id: board.columns(db, projectId).find((c) => c.step === 'implement')!.id
	}).id;
	const profileId = runs.createProfile(db, user, {
		name: 'Local',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const started: { run: RunContext; done: (facts?: ExecutorFacts) => void }[] = [];
	const executor: Executor = {
		execute: (run) =>
			new Promise((done) =>
				started.push({ run, done: (facts = { ending: 'end_turn' }) => done(facts) })
			)
	};
	const runner = startRunner(db, { builtin: executor });
	stops.push(runner.stop);
	const startedRunIds = () => started.map((s) => s.run.id);
	return { db, ticketId, profileId, started, startedRunIds };
}
type Studio = ReturnType<typeof studio>;

/** The run asks and pauses; the human answers at `answeredAt`. Returns the question and the queued follow-up. */
async function answered(s: Studio, options = [{ label: 'A' }, { label: 'Stop', stopsRun: true }]) {
	const first = runs.createRun(s.db, user, { ticketId: s.ticketId, profileId: s.profileId }).id;
	await flush();
	const questionId = requestHuman(s.db, agent(first), s.ticketId, { question: 'A?', options }).id;
	s.started[0].done();
	await flush();
	const answer = (option = 1) => answerQuestion(s.db, user, questionId, { option });
	answer();
	await flush();
	const followUps = () =>
		(
			s.db.prepare('SELECT id FROM runs WHERE resumed_from_run_id = ? ORDER BY id').all(first) as {
				id: number;
			}[]
		).map((r) => r.id);
	const notBefore = () =>
		s.db.prepare('SELECT not_before FROM runs WHERE id = ?').get(followUps()[0])!.not_before;
	return { questionId, first, answer, followUps, notBefore };
}

async function passSeconds(seconds: number) {
	vi.advanceTimersByTime(seconds * 1000);
	await flush();
}

const inSeconds = (seconds: number) =>
	new Date(answeredAt.getTime() + seconds * 1000).toISOString();

describe('holding the answer window', () => {
	it('moves the follow-up run to a full window after the beat, and the runner starts it then and not at the old time', async () => {
		const s = studio();
		const q = await answered(s);
		await passSeconds(9);

		const hold = holdAnswerWindow(s.db, user, q.questionId);

		expect(hold).toEqual({ held: true, closesInMs: ANSWER_UNDO_WINDOW_MS, capped: false });
		expect(q.notBefore()).toBe(inSeconds(19));
		await passSeconds(1);
		expect(s.startedRunIds()).toEqual([q.first]);
		await passSeconds(8.999);
		expect(s.startedRunIds()).toEqual([q.first]);
		await passSeconds(0.001);
		expect(s.startedRunIds()).toEqual([q.first, q.followUps()[0]]);
	});

	it('lets the window run out ten seconds after the last beat when no beat follows', async () => {
		const s = studio();
		const q = await answered(s);
		for (let beat = 0; beat < 4; beat++) {
			holdAnswerWindow(s.db, user, q.questionId);
			await passSeconds(5);
		}
		await passSeconds(4.999);
		expect(s.startedRunIds()).toEqual([q.first]);
		await passSeconds(0.001);
		expect(s.startedRunIds()).toEqual([q.first, q.followUps()[0]]);
	});

	it('never shortens the window, not even for a beat that carries an earlier time', async () => {
		const s = studio();
		const q = await answered(s);
		await passSeconds(9);
		holdAnswerWindow(s.db, user, q.questionId);

		const hold = holdAnswerWindow(s.db, user, q.questionId, new Date(answeredAt.getTime() + 2000));

		expect(q.notBefore()).toBe(inSeconds(19));
		expect(hold.closesInMs).toBe(17_000);
	});

	it('stops extending at the cap, reports it, and starts the run at most one window after the last accepted beat', async () => {
		const s = studio();
		const q = await answered(s);
		const results = [];
		for (let beat = 0; beat <= 24; beat++) {
			results.push(holdAnswerWindow(s.db, user, q.questionId));
			if (beat < 24) await passSeconds(5);
			else if (beat === 24) await passSeconds(4.999);
		}

		expect(results.filter((r) => r.held)).toHaveLength(ANSWER_HOLD_CAP_MS / 5000);
		expect(results.at(-1)).toMatchObject({ held: false, capped: true });
		expect(s.startedRunIds()).toEqual([q.first]);
		await passSeconds(0.001);
		expect(s.startedRunIds()).toEqual([q.first, q.followUps()[0]]);
	});

	it('reports the time that is left once capped and changes nothing', async () => {
		const s = studio();
		const q = await answered(s);
		vi.setSystemTime(new Date(answeredAt.getTime() + 119_999));
		holdAnswerWindow(s.db, user, q.questionId);
		const before = q.notBefore();
		expect(before).toBe(inSeconds(129.999));
		vi.setSystemTime(new Date(answeredAt.getTime() + 125_000));

		const hold = holdAnswerWindow(s.db, user, q.questionId);

		expect(hold).toEqual({ held: false, closesInMs: 4_999, capped: true });
		expect(q.notBefore()).toBe(before);
	});

	it('gives a changed answer its own window and its own cap', async () => {
		const s = studio();
		const q = await answered(s);
		vi.setSystemTime(new Date(answeredAt.getTime() + 118_000));
		holdAnswerWindow(s.db, user, q.questionId);
		q.answer(1);
		vi.setSystemTime(new Date(answeredAt.getTime() + 121_000));

		const hold = holdAnswerWindow(s.db, user, q.questionId);

		expect(hold).toMatchObject({ held: true, capped: false });
		expect(q.followUps()).toHaveLength(1);
	});

	it('holds nothing for an answer that starts no run', async () => {
		const s = studio();
		const q = await answered(s);
		q.answer(2);
		await flush();

		expect(holdAnswerWindow(s.db, user, q.questionId)).toEqual({
			held: false,
			closesInMs: 0,
			capped: false
		});
		expect(q.followUps()).toHaveLength(1);
	});

	it('refuses to hold once the follow-up run has started, and so does taking the answer back, each with a way out', async () => {
		const s = studio();
		const q = await answered(s);
		await passSeconds(10);
		expect(s.startedRunIds()).toHaveLength(2);

		const held = caught(() => holdAnswerWindow(s.db, user, q.questionId));
		const retracted = caught(() => retractAnswer(s.db, user, q.questionId));

		for (const error of [held, retracted]) {
			expect(error.code).toBe('answer_in_use');
			expect(error.hint).toContain('Kommentar');
		}
		expect(s.db.prepare('SELECT answer FROM questions WHERE id = ?').get(q.questionId)).toEqual({
			answer: '{"option":1}'
		});
	});

	it('takes the answer back during a hold after the first ten seconds and cancels the waiting run', async () => {
		const s = studio();
		const q = await answered(s);
		await passSeconds(9);
		holdAnswerWindow(s.db, user, q.questionId);
		await passSeconds(8);

		retractAnswer(s.db, user, q.questionId);
		await passSeconds(30);

		expect(s.startedRunIds()).toEqual([q.first]);
		expect(s.db.prepare('SELECT answer FROM questions WHERE id = ?').get(q.questionId)).toEqual({
			answer: null
		});
		expect(s.db.prepare('SELECT state FROM runs WHERE id = ?').get(q.followUps()[0])).toEqual({
			state: 'cancelled'
		});
	});

	it('refuses an agent, an unanswered question, a collected answer and an unknown question, and changes nothing', async () => {
		const s = studio();
		const q = await answered(s);
		const before = q.notBefore();
		const refused = (id: number, actor: Actor) =>
			caught(() => holdAnswerWindow(s.db, actor, id)).code;

		expect(refused(q.questionId, agent(q.first))).toBe('requires_human');
		expect(refused(9999, user)).toBe('not_found');
		collectAnswer(s.db, agent(q.first), s.ticketId);
		expect(refused(q.questionId, user)).toBe('answer_collected');
		const unanswered = requestHuman(s.db, agent(q.first), s.ticketId, { question: 'B?' }).id;
		expect(refused(unanswered, user)).toBe('not_answered');
		expect(q.notBefore()).toBe(before);
	});
});

function caught(fn: () => unknown): DomainError {
	try {
		fn();
	} catch (err) {
		if (err instanceof DomainError) return err;
		throw err;
	}
	throw new Error('expected a DomainError');
}
