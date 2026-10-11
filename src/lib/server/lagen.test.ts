import { describe, expect, it } from 'vitest';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import { pauseRun } from './domain/halt';
import { answerQuestion, requestHuman } from './domain/questions';
import * as runs from './domain/runs';
import type { Variant } from './domain/variants';
import { migrate, openDb } from './db';
import { ticketLagen } from './lagen';

const user: Actor = { kind: 'user' };

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	const project = (key: string, variant?: Variant) =>
		board.createProject(db, user, { key, name: key }, variant).id;
	const columnId = (projectId: number, step: string) =>
		db.prepare('SELECT id FROM columns WHERE project_id = ? AND step = ?').get(projectId, step)!
			.id as number;
	const ticket = (projectId: number, step = 'implement') =>
		board.createTicket(db, user, projectId, { title: 'T', column_id: columnId(projectId, step) })
			.id;
	const profile = runs.createProfile(db, user, {
		name: 'p',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm',
		pool: 'local'
	}).id;
	const run = (ticketId: number) => runs.createRun(db, user, { ticketId, profileId: profile }).id;
	const lageOfTicket = (ticketId: number) =>
		ticketLagen(db).find((row) => row.ticketId === ticketId)!;
	return { db, project, columnId, ticket, run, lageOfTicket };
}

describe('ticketLagen', () => {
	it('puts a ticket without a run in a work step under „Offen“, ready to start', () => {
		const s = setup();
		const id = s.ticket(s.project('STU'));
		expect(s.lageOfTicket(id)).toMatchObject({ lage: 'open', reason: { kind: 'ready' } });
	});

	it('puts a backlog ticket under „Offen“, not prioritized', () => {
		const s = setup();
		const id = s.ticket(s.project('STU'), 'backlog');
		expect(s.lageOfTicket(id).reason).toEqual({ kind: 'not_prioritized' });
	});

	it('names the open predecessors of a ticket and drops them once the predecessor is done', () => {
		const s = setup();
		const stu = s.project('STU');
		const first = s.ticket(stu);
		const second = s.ticket(stu);
		board.linkRelation(s.db, user, first, second, 'blocks');
		expect(s.lageOfTicket(second).reason).toEqual({ kind: 'predecessors', refs: ['STU-1'] });
		board.moveTicket(s.db, user, first, s.columnId(stu, 'done'));
		expect(s.lageOfTicket(second).reason).toEqual({ kind: 'ready' });
	});

	it('gives a queued run the capacity causes of waitReason', () => {
		const s = setup();
		const id = s.ticket(s.project('STU'));
		const run = s.run(id);
		const expected = runs.waitReason(s.db, run, { global: 4, pools: { local: 1 } })!.causes;
		expect(s.lageOfTicket(id)).toMatchObject({
			lage: 'open',
			reason: { kind: 'capacity', causes: expected }
		});
	});

	it('gives every ticket with a queued run its own capacity causes', () => {
		const s = setup();
		const stu = s.project('STU');
		const [first, second] = [s.ticket(stu), s.ticket(stu)];
		const [firstRun, secondRun] = [s.run(first), s.run(second)];
		const limits = { global: 4, pools: { local: 1 } };
		const reasons = runs.waitReasons(s.db, limits);
		expect(reasons.get(firstRun)!.causes).not.toEqual(reasons.get(secondRun)!.causes);
		expect(s.lageOfTicket(first).reason).toEqual({
			kind: 'capacity',
			causes: reasons.get(firstRun)!.causes
		});
		expect(s.lageOfTicket(second).reason).toEqual({
			kind: 'capacity',
			causes: reasons.get(secondRun)!.causes
		});
	});

	it('puts a ticket with a running run under „In Arbeit“', () => {
		const s = setup();
		const id = s.ticket(s.project('STU'));
		runs.startRun(s.db, user, s.run(id));
		expect(s.lageOfTicket(id).lage).toBe('working');
	});

	it('puts a ticket with a run in waiting_approval under „Wartet auf dich“, approval', () => {
		const s = setup();
		const id = s.ticket(s.project('STU'));
		const run = s.run(id);
		runs.startRun(s.db, user, run);
		runs.setRunState(s.db, user, run, 'waiting_approval');
		expect(s.lageOfTicket(id)).toMatchObject({ lage: 'waiting', reason: { kind: 'approval' } });
	});

	it('puts a ticket whose newest run failed under „Wartet auf dich“, and a succeeded run counts as no run', () => {
		const s = setup();
		const id = s.ticket(s.project('STU'));
		const failed = s.run(id);
		runs.startRun(s.db, user, failed);
		runs.finishRun(s.db, user, failed, { state: 'failed', error: 'boom' });
		expect(s.lageOfTicket(id).reason).toEqual({ kind: 'failure' });
		const succeeded = s.run(id);
		runs.startRun(s.db, user, succeeded);
		runs.finishRun(s.db, user, succeeded, { state: 'succeeded' });
		expect(s.lageOfTicket(id).reason).toEqual({ kind: 'ready' });
	});

	it('shows a run that holds for the human before a newer queued run', () => {
		const s = setup();
		const id = s.ticket(s.project('STU'));
		const holding = s.run(id);
		runs.startRun(s.db, user, holding);
		runs.setRunState(s.db, user, holding, 'waiting_approval');
		s.run(id);
		expect(s.lageOfTicket(id)).toMatchObject({ lage: 'waiting', reason: { kind: 'approval' } });
	});

	it('shows a ticket as in progress while an older run works and a newer one queues', () => {
		const s = setup();
		const id = s.ticket(s.project('STU'));
		runs.startRun(s.db, user, s.run(id));
		s.run(id);
		expect(s.lageOfTicket(id).lage).toBe('working');
	});

	it('counts a failed run only while the ticket is still in the step it failed in', () => {
		const s = setup();
		const stu = s.project('STU');
		const id = s.ticket(stu);
		const failed = s.run(id);
		runs.startRun(s.db, user, failed);
		runs.finishRun(s.db, user, failed, { state: 'failed', error: 'boom' });
		const next = s.db
			.prepare(
				'SELECT id FROM columns WHERE project_id = ? AND position > (SELECT position FROM columns WHERE step = ? AND project_id = ?) ORDER BY position LIMIT 1'
			)
			.get(stu, 'implement', stu)!.id as number;
		board.moveTicket(s.db, user, id, next);
		expect(s.lageOfTicket(id).reason.kind).not.toBe('failure');
	});

	it('shows a ticket moved to done as done even though it had an open question', () => {
		const s = setup();
		const stu = s.project('STU');
		const id = s.ticket(stu);
		requestHuman(s.db, user, id, { question: 'Which one?' });
		board.moveTicket(s.db, user, id, s.columnId(stu, 'done'));
		expect(s.lageOfTicket(id).lage).toBe('done');
	});

	it('puts a ticket whose run the human halted under „Offen“, paused', () => {
		const s = setup();
		const id = s.ticket(s.project('STU'));
		const run = s.run(id);
		runs.startRun(s.db, user, run);
		pauseRun(s.db, user, run);
		expect(s.lageOfTicket(id).reason).toEqual({ kind: 'paused' });
	});

	it('puts a ticket with an open question under „Wartet auf dich“ in any phase but done, until it is answered', () => {
		const s = setup();
		const stu = s.project('STU');
		const id = s.ticket(stu, 'acceptance');
		const run = s.run(id);
		runs.startRun(s.db, user, run);
		const { id: questionId } = requestHuman(s.db, { kind: 'agent', runId: run }, id, {
			question: 'Which one?',
			options: [{ label: 'This one' }]
		});
		expect(s.lageOfTicket(id)).toMatchObject({ lage: 'waiting', reason: { kind: 'question' } });
		answerQuestion(s.db, user, questionId, { option: 1 });
		expect(s.lageOfTicket(id).lage).not.toBe('waiting');
	});

	it('puts acceptance and done tickets under „Zur Abnahme“ and „Fertig“', () => {
		const s = setup();
		const stu = s.project('STU');
		expect(s.lageOfTicket(s.ticket(stu, 'acceptance')).lage).toBe('acceptance');
		const finished = s.ticket(stu, 'backlog');
		board.moveTicket(s.db, user, finished, s.columnId(stu, 'done'));
		expect(s.lageOfTicket(finished).lage).toBe('done');
	});

	it('gives step, variant and progress for all three variants', () => {
		const s = setup();
		const software = s.ticket(s.project('SOF', 'software'), 'implement');
		const knowledge = s.ticket(s.project('KNO', 'knowledge'), 'draft');
		const direct = s.ticket(s.project('DIR', 'direct'), 'critique');
		expect(s.lageOfTicket(software)).toMatchObject({
			step: 'implement',
			variant: 'software',
			progress: { index: 3, total: 5 }
		});
		expect(s.lageOfTicket(knowledge)).toMatchObject({
			step: 'draft',
			variant: 'knowledge',
			progress: { index: 2, total: 4 }
		});
		expect(s.lageOfTicket(direct)).toMatchObject({
			step: 'critique',
			variant: 'direct',
			progress: { index: 2, total: 3 }
		});
	});

	it('limits the result to one project, and leaves archived projects out', () => {
		const s = setup();
		const one = s.project('ONE');
		const two = s.project('TWO');
		const old = s.project('OLD');
		const inOne = s.ticket(one);
		s.ticket(two);
		s.ticket(old);
		s.db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(old);
		expect(ticketLagen(s.db, { projectId: one }).map((row) => row.ticketId)).toEqual([inOne]);
		expect(ticketLagen(s.db)).toHaveLength(2);
	});
});

describe('ticketLagen at board size', () => {
	function crowdedBoard() {
		const s = setup();
		const stu = s.project('STU');
		const shop = s.project('SHO');
		const ids: number[] = [];
		for (let i = 0; i < 500; i++)
			ids.push(s.ticket(i % 2 ? stu : shop, i % 7 ? 'implement' : 'backlog'));
		ids.forEach((id, i) => {
			if (i % 5 === 0) runs.startRun(s.db, user, s.run(id));
			if (i % 5 === 1) s.run(id);
			if (i % 10 === 2) requestHuman(s.db, user, id, { question: 'Which one?' });
			if (i > 0 && i % 4 === 0) board.linkRelation(s.db, user, ids[i - 1], id, 'blocks');
		});
		return s;
	}

	it('reads 500 tickets with runs and questions in under 50 ms', () => {
		const s = crowdedBoard();
		ticketLagen(s.db);
		const start = performance.now();
		const result = ticketLagen(s.db);
		expect(performance.now() - start).toBeLessThan(50);
		expect(result).toHaveLength(500);
	});

	it('uses the same number of queries however many tickets there are', () => {
		const s = crowdedBoard();
		const count = (projectId?: number) => {
			let statements = 0;
			const prepare = s.db.prepare.bind(s.db);
			s.db.prepare = ((sql: string) => (statements++, prepare(sql))) as typeof s.db.prepare;
			ticketLagen(s.db, { projectId });
			s.db.prepare = prepare;
			return statements;
		};
		const many = count();
		const few = count(1);
		expect(many).toBe(few);
		expect(many).toBeLessThanOrEqual(2);
	});
});
