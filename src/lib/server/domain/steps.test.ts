import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import * as board from './board';
import type { Actor } from './core';
import { answerQuestion, latestOpenQuestion, requestHuman } from './questions';
import * as runs from './runs';
import { finishStep, queueNextStep, type StepResult } from './steps';
import type { Step, Variant } from './variants';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };

/**
 * A ticket that passes every exit condition, placed in `start`, with a run the human started there. `work` lets the
 * current run finish its step and end the way the runner ends it, then follows the chain to the next run.
 */
function chain(variant: Variant = 'software', start: Step = 'implement') {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'CHN', name: 'Kette' }, variant).id;
	const columnOf = (step: Step) => board.columns(db, projectId).find((c) => c.step === step)!.id;
	const ticketId = board.createTicket(db, user, projectId, {
		title: 'Export',
		description: 'CSV export',
		size: 'S',
		column_id: columnOf(start)
	}).id;
	board.completeTasks(db, user, ticketId, board.addTasks(db, user, ticketId, ['Kriterium']).ids);
	const profileId = runs.createProfile(db, user, {
		name: 'Lokal',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	let runId = runs.createRun(db, user, { ticketId, profileId }).id;
	const stateOf = (id: number) => db.prepare('SELECT state FROM runs WHERE id = ?').get(id)?.state;
	const work = (result: StepResult, summary = `Handoff (${result})`) => {
		const finished = runId;
		if (stateOf(finished) === 'queued') runs.startRun(db, system, finished);
		const outcome = finishStep(db, { kind: 'agent', runId: finished }, ticketId, {
			result,
			summary
		});
		runs.finishRun(db, system, finished, {
			state: outcome.then === 'human' ? 'paused' : 'succeeded'
		});
		const next = queueNextStep(db, finished);
		if (next) runId = next.id;
		return { outcome, next, finished };
	};
	const run = (id: number) =>
		db
			.prepare(
				'SELECT r.trigger, r.priority, r.agent_profile_id AS profileId, c.step FROM runs r JOIN columns c ON c.id = r.column_id WHERE r.id = ?'
			)
			.get(id);
	const stepOf = () => board.ticket(db, ticketId).column_step;
	const runCount = () => (db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n;
	return {
		db,
		projectId,
		ticketId,
		profileId,
		columnOf,
		work,
		run,
		stepOf,
		runCount,
		current: () => runId
	};
}

describe('the chain', () => {
	it('queues exactly one run for the next work step, triggered on enter with the same profile; critique gets the review priority', () => {
		const c = chain('software', 'plan');
		const { next } = c.work('done');
		expect(c.run(next!.id)).toEqual({
			trigger: 'on_enter',
			priority: 'normal',
			profileId: c.profileId,
			step: 'implement'
		});
		expect(c.runCount()).toBe(2);
		expect(c.run(c.work('done').next!.id)).toMatchObject({ step: 'critique', priority: 'review' });
		expect(c.run(c.work('back', 'Befund').next!.id)).toMatchObject({ step: 'implement' });
	});

	it('queues no run once the step leads to acceptance, and none after a step that ends blocked', () => {
		const c = chain('direct', 'critique');
		expect(c.work('done')).toMatchObject({ outcome: { next: 'acceptance' }, next: undefined });
		const blocked = chain('software', 'implement');
		expect(blocked.work('blocked', 'Welches Format?').next).toBeUndefined();
		expect(blocked.runCount()).toBe(1);
	});

	it('queues no run for a run that ended without finishing its step, or that is not over yet', () => {
		const c = chain('software', 'plan');
		const runId = c.current();
		runs.startRun(c.db, system, runId);
		expect(queueNextStep(c.db, runId)).toBeUndefined();
		finishStep(c.db, { kind: 'agent', runId }, c.ticketId, { result: 'done', summary: 'Plan' });
		expect(queueNextStep(c.db, runId)).toBeUndefined(); // still running: it is its own pending run
		runs.finishRun(c.db, system, runId, { state: 'succeeded' });
		expect(queueNextStep(c.db, runId)).toMatchObject({ id: expect.any(Number) });
	});

	it('queues no second run while another run of the ticket is active or waiting in the queue', () => {
		for (const state of ['queued', 'running'] as const) {
			const c = chain('software', 'plan');
			const finished = c.current();
			runs.startRun(c.db, system, finished);
			finishStep(c.db, { kind: 'agent', runId: finished }, c.ticketId, {
				result: 'done',
				summary: 'Plan'
			});
			runs.finishRun(c.db, system, finished, { state: 'succeeded' });
			const other = runs.createRun(c.db, user, { ticketId: c.ticketId, profileId: c.profileId }).id;
			if (state === 'running') runs.startRun(c.db, system, other);

			expect(queueNextStep(c.db, finished)).toBeUndefined();
			expect(c.runCount()).toBe(2);
		}
	});

	it('queues no run while the ticket has an open question', () => {
		const c = chain('software', 'plan');
		const finished = c.current();
		runs.startRun(c.db, system, finished);
		finishStep(c.db, { kind: 'agent', runId: finished }, c.ticketId, {
			result: 'done',
			summary: 'Plan'
		});
		runs.finishRun(c.db, system, finished, { state: 'succeeded' });
		requestHuman(c.db, user, c.ticketId, { question: 'Noch offen?' });

		expect(queueNextStep(c.db, finished)).toBeUndefined();
	});

	it('queues no run while a blocks predecessor is not done, and again once it is', () => {
		const c = chain('software', 'plan');
		const predecessor = board.createTicket(c.db, user, c.projectId, { title: 'Davor' }).id;
		const finished = c.current();
		runs.startRun(c.db, system, finished);
		finishStep(c.db, { kind: 'agent', runId: finished }, c.ticketId, {
			result: 'done',
			summary: 'Plan'
		});
		runs.finishRun(c.db, system, finished, { state: 'succeeded' });
		board.linkRelation(c.db, user, predecessor, c.ticketId, 'blocks'); // finish_step itself refuses once linked

		expect(queueNextStep(c.db, finished)).toBeUndefined();
		expect(c.runCount()).toBe(1);

		board.moveTicket(c.db, user, predecessor, c.columnOf('done'));
		expect(queueNextStep(c.db, finished)).toMatchObject({ id: expect.any(Number) });
	});

	it('queues no run after a back into a work step while a blocks predecessor is not done', () => {
		const c = chain('software', 'critique');
		const predecessor = board.createTicket(c.db, user, c.projectId, { title: 'Davor' }).id;
		board.linkRelation(c.db, user, predecessor, c.ticketId, 'blocks');
		const { outcome, next } = c.work('back', 'Befund');
		expect(outcome).toMatchObject({ next: 'implement', then: 'run' });
		expect(next).toBeUndefined();
		expect(c.runCount()).toBe(1);
	});
});

describe('the round limit between author and critique', () => {
	/** Implement and critique alternate; each critique sends findings `n` back. */
	function rounds(c: ReturnType<typeof chain>, findings: string[]) {
		return findings.map((text) => {
			c.work('done');
			return c.work('back', text);
		});
	}

	it('turns the third back from critique into one question with both findings reports instead of a jump back', () => {
		const c = chain('software', 'implement');
		const [first, second] = rounds(c, ['Befund 1', 'Befund 2']);
		expect([first.outcome.next, second.outcome.next]).toEqual(['implement', 'implement']);
		c.work('done');

		const third = c.work('back', 'Befund 3');

		expect(third.outcome).toEqual({
			next: 'critique',
			then: 'human',
			question_id: expect.any(Number)
		});
		expect(third.next).toBeUndefined();
		expect(c.stepOf()).toBe('critique');
		const question = latestOpenQuestion(c.db, c.ticketId)!;
		expect(question.question).toMatch(/^Autor und Kritiker sind sich nach 2 Runden nicht einig/);
		expect(question.question).toContain('Befund 2');
		expect(question.question).toContain('Befund 3');
		expect(question.options.map((o) => o.stopsRun ?? false)).toEqual([false, false, true]);
	});

	it('counts anew once the human answers: the resumed critique may send the ticket back again', () => {
		const c = chain('software', 'implement');
		rounds(c, ['Befund 1', 'Befund 2']);
		c.work('done');
		const { outcome, finished } = c.work('back', 'Befund 3');
		answerQuestion(c.db, user, outcome.question_id!, { option: 1 });
		const resumed = c.db
			.prepare('SELECT id FROM runs WHERE resumed_from_run_id = ?')
			.get(finished) as {
			id: number;
		};
		runs.startRun(c.db, system, resumed.id);

		const back = finishStep(c.db, { kind: 'agent', runId: resumed.id }, c.ticketId, {
			result: 'back',
			summary: 'Befund 4'
		});

		expect(back).toEqual({ next: 'implement', then: 'run' });
	});

	it('counts anew once the human starts a run of the ticket', () => {
		const c = chain('software', 'implement');
		rounds(c, ['Befund 1', 'Befund 2']);
		const latest = c.current();
		runs.finishRun(c.db, user, latest, { state: 'cancelled' });
		const manual = runs.createRun(c.db, user, { ticketId: c.ticketId, profileId: c.profileId }).id;
		runs.startRun(c.db, system, manual);
		finishStep(c.db, { kind: 'agent', runId: manual }, c.ticketId, {
			result: 'done',
			summary: 'Fertig'
		});
		runs.finishRun(c.db, system, manual, { state: 'succeeded' });
		const critique = queueNextStep(c.db, manual)!.id;
		runs.startRun(c.db, system, critique);

		expect(
			finishStep(c.db, { kind: 'agent', runId: critique }, c.ticketId, {
				result: 'back',
				summary: 'B'
			})
		).toEqual({ next: 'implement', then: 'run' });
	});

	it('asks only once when the critique repeats its third back', () => {
		const c = chain('software', 'implement');
		rounds(c, ['Befund 1', 'Befund 2']);
		c.work('done');
		const runId = c.current();
		runs.startRun(c.db, system, runId);
		const agent: Actor = { kind: 'agent', runId };
		const first = finishStep(c.db, agent, c.ticketId, { result: 'back', summary: 'Befund 3' });
		expect(finishStep(c.db, agent, c.ticketId, { result: 'back', summary: 'Befund 3' })).toEqual(
			first
		);
		expect(c.db.prepare('SELECT count(*) AS n FROM questions').get()).toEqual({ n: 1 });
	});
});

function ticketInPlan(blocked: boolean) {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const stepColumn = (step: string) =>
		(
			db
				.prepare('SELECT id FROM columns WHERE project_id = ? AND step = ?')
				.get(projectId, step) as { id: number }
		).id;
	const predecessor = board.createTicket(db, user, projectId, { title: 'First' }).id;
	const id = board.createTicket(db, user, projectId, { title: 'Then' }).id;
	if (blocked) board.linkRelation(db, user, predecessor, id, 'blocks');
	db.prepare('UPDATE tickets SET column_id = ? WHERE id = ?').run(stepColumn('plan'), id);
	const profileId = runs.createProfile(db, user, {
		name: 'P',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const runId = runs.createRun(db, user, { ticketId: id, profileId }).id;
	runs.startRun(db, { kind: 'system' }, runId);
	const finish = () =>
		finishStep(db, { kind: 'agent', runId }, id, { result: 'done', summary: 'Plan' });
	return { db, id, finish };
}

describe('finishStep with done and an open blocks predecessor', () => {
	it('refuses to move the ticket into the next work step and names the predecessor and the way out', () => {
		const { db, id, finish } = ticketInPlan(true);
		expect(finish).toThrow(
			expect.objectContaining({
				code: 'blocked_by_predecessor',
				message: expect.stringContaining('STU-1'),
				hint: expect.stringContaining('result blocked')
			})
		);
		expect(board.ticket(db, id).column_step).toBe('plan');
	});

	it('moves the ticket on when no predecessor blocks it', () => {
		const { db, id, finish } = ticketInPlan(false);
		expect(finish()).toMatchObject({ next: 'implement', then: 'run' });
		expect(board.ticket(db, id).column_step).toBe('implement');
	});
});
