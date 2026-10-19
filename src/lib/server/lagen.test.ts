import { describe, expect, it } from 'vitest';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import { pauseRun } from './domain/halt';
import { answerQuestion, requestHuman } from './domain/questions';
import * as runs from './domain/runs';
import { finishStep } from './domain/steps';
import type { Variant } from './domain/variants';
import { migrate, openDb } from './db';
import { ONE_TICKET, ticketLage, ticketLagen } from './lagen';

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
	// createRun refuses tickets outside a work step; a ticket that moved on keeps its older run.
	const run = (ticketId: number) => {
		const t = db
			.prepare(
				'SELECT c.phase, c.id AS column_id FROM tickets t JOIN columns c ON c.id = t.column_id WHERE t.id = ?'
			)
			.get(ticketId) as { phase: string; column_id: number };
		if (t.phase === 'work') return runs.createRun(db, user, { ticketId, profileId: profile }).id;
		return (
			db
				.prepare(
					"INSERT INTO runs (ticket_id, column_id, agent_profile_id, trigger, priority) VALUES (?, ?, ?, 'manual', 'normal') RETURNING id"
				)
				.get(ticketId, t.column_id, profile) as { id: number }
		).id;
	};
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

	it('puts a ticket whose newest run failed under „Wartet auf dich“, and a run that finished its step counts as no run', () => {
		const s = setup();
		const id = s.ticket(s.project('STU'));
		const failed = s.run(id);
		runs.startRun(s.db, user, failed);
		runs.finishRun(s.db, user, failed, { state: 'failed', error: 'boom' });
		expect(s.lageOfTicket(id).reason).toEqual({ kind: 'failure' });
		const succeeded = s.run(id);
		runs.startRun(s.db, user, succeeded);
		finishStep(s.db, { kind: 'agent', runId: succeeded }, id, { result: 'done', summary: 'S' });
		runs.finishRun(s.db, user, succeeded, { state: 'succeeded' });
		expect(s.lageOfTicket(id)).toMatchObject({ step: 'critique', reason: { kind: 'ready' } });
	});

	it('puts a ticket under „Wartet auf dich“ when its run succeeded without finishing its step, until the human acts', () => {
		const s = setup();
		const stu = s.project('STU');
		const id = s.ticket(stu);
		const silent = s.run(id);
		runs.startRun(s.db, user, silent);
		runs.finishRun(s.db, user, silent, { state: 'succeeded' });
		expect(s.lageOfTicket(id)).toMatchObject({ lage: 'waiting', reason: { kind: 'stalled' } });

		s.run(id);
		expect(s.lageOfTicket(id).reason.kind).toBe('capacity');
	});

	it('clears the stall once the human moves the ticket on', () => {
		const s = setup();
		const stu = s.project('STU');
		const id = s.ticket(stu);
		const silent = s.run(id);
		runs.startRun(s.db, user, silent);
		runs.finishRun(s.db, user, silent, { state: 'succeeded' });
		board.moveTicket(s.db, user, id, s.columnId(stu, 'critique'));
		expect(s.lageOfTicket(id)).toMatchObject({ lage: 'open', reason: { kind: 'ready' } });
	});

	it('keeps a failure under „Wartet auf dich“ after the run moved the ticket on with finish_step, until the human moves it', () => {
		const s = setup();
		const stu = s.project('STU');
		const id = s.ticket(stu, 'plan');
		const failed = s.run(id);
		runs.startRun(s.db, user, failed);
		finishStep(s.db, { kind: 'agent', runId: failed }, id, { result: 'done', summary: 'Plan' });
		runs.finishRun(s.db, user, failed, { state: 'failed', error: 'model gone' });
		expect(s.lageOfTicket(id)).toMatchObject({
			step: 'implement',
			lage: 'waiting',
			reason: { kind: 'failure' }
		});

		board.moveTicket(s.db, user, id, s.columnId(stu, 'critique'));
		expect(s.lageOfTicket(id).reason.kind).not.toBe('failure');
	});

	it('shows a run that holds for the human', () => {
		const s = setup();
		const id = s.ticket(s.project('STU'));
		const holding = s.run(id);
		runs.startRun(s.db, user, holding);
		runs.setRunState(s.db, user, holding, 'waiting_approval');
		expect(s.lageOfTicket(id)).toMatchObject({ lage: 'waiting', reason: { kind: 'approval' } });
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

	it('shows a ticket as in progress when a run works and an older one failed in an earlier step', () => {
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
		runs.startRun(s.db, user, s.run(id));
		expect(s.lageOfTicket(id).lage).toBe('working');
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
	return { ...s, ids };
}

describe('ticketLagen at board size', () => {
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

describe('ticketLage', () => {
	it('reads the same Lage for one ticket as the board reads for all', () => {
		const s = setup();
		const project = s.project('STU');
		const open = s.ticket(project);
		const asking = s.ticket(project);
		requestHuman(s.db, user, asking, { question: 'Which one?' });
		for (const id of [open, asking]) expect(ticketLage(s.db, id)).toEqual(s.lageOfTicket(id));
		expect(ticketLage(s.db, asking)).toMatchObject({
			lage: 'waiting',
			reason: { kind: 'question' }
		});
	});

	it('finds nothing for a ticket that does not exist', () => {
		expect(ticketLage(setup().db, 999)).toBeUndefined();
	});

	it('uses the same few queries in a crowded board as in an empty one', () => {
		const crowded = crowdedBoard();
		const statementsFor = (s: ReturnType<typeof setup>, ticketId: number) => {
			let statements = 0;
			const prepare = s.db.prepare.bind(s.db);
			s.db.prepare = ((sql: string) => (statements++, prepare(sql))) as typeof s.db.prepare;
			ticketLage(s.db, ticketId);
			s.db.prepare = prepare;
			return statements;
		};
		const alone = setup();
		const aloneId = alone.ticket(alone.project('STU'));
		alone.run(aloneId);
		const queuedInCrowd = crowded.ids.find(
			(id) => ticketLage(crowded.db, id)?.reason.kind === 'capacity'
		)!;
		expect(statementsFor(crowded, queuedInCrowd)).toBe(statementsFor(alone, aloneId));
		expect(statementsFor(crowded, queuedInCrowd)).toBeLessThanOrEqual(2);
	});
});

describe('reading the Lage of one ticket', () => {
	it('searches the ticket by its primary key instead of scanning every ticket', () => {
		const { db } = setup();
		const plan = (
			db.prepare(`EXPLAIN QUERY PLAN ${ONE_TICKET}`).all(1) as { detail: string }[]
		).map((row) => row.detail);
		expect(plan).toContain('SEARCH t USING INTEGER PRIMARY KEY (rowid=?)');
	});
});
