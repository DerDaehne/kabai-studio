import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import * as board from './board';
import type { Actor } from './core';
import { answerQuestion, latestOpenQuestion, requestHuman } from './questions';
import { acceptTicket, returnTicket } from './intents';
import * as runs from './runs';
import { assemblePrompt } from '../agents/prompt';
import { ticketLagen } from '../lagen';
import { finishStep, queueNextStep, queueUnblockedSuccessors, type StepResult } from './steps';
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

describe('approval in critique', () => {
	it('refuses a run that resumes the author run, since it is still the author', () => {
		const c = chain('software', 'implement');
		const author = c.current();
		runs.startRun(c.db, system, author);
		finishStep(c.db, { kind: 'agent', runId: author }, c.ticketId, {
			result: 'done',
			summary: 'Fertig'
		});
		runs.finishRun(c.db, system, author, { state: 'paused' });
		const resumed = runs.createRun(c.db, system, {
			ticketId: c.ticketId,
			profileId: c.profileId,
			resumedFromRunId: author,
			resumeReason: 'quota'
		}).id;
		runs.startRun(c.db, system, resumed);

		expect(() =>
			finishStep(c.db, { kind: 'agent', runId: resumed }, c.ticketId, {
				result: 'done',
				summary: 'Passt'
			})
		).toThrow(expect.objectContaining({ code: 'self_approval' }));
		expect(c.stepOf()).toBe('critique');
	});
});

describe('the round limit on going back', () => {
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

	it.each([
		{ variant: 'software', start: 'implement', backTo: 'refine', workBack: ['done', 'done'] },
		{ variant: 'knowledge', start: 'draft', backTo: 'research', workBack: ['done'] }
	] as const)(
		'turns the third back into the question in a $variant loop that never reaches critique',
		({ variant, start, backTo, workBack }) => {
			const c = chain(variant, start);
			for (const finding of ['Befund 1', 'Befund 2']) {
				const back = c.work('back', finding);
				expect(back.outcome).toEqual({ next: backTo, then: 'run' });
				expect(back.next).toBeDefined();
				workBack.forEach((result) => c.work(result));
			}

			const third = c.work('back', 'Befund 3');

			expect(third.outcome).toEqual({
				next: start,
				then: 'human',
				question_id: expect.any(Number)
			});
			expect(third.next).toBeUndefined();
			const question = latestOpenQuestion(c.db, c.ticketId)!.question;
			expect(question).toMatch(/^Die Schritte sind sich nach 2 Runden nicht einig/);
			expect(question).toContain('Befund 2');
			expect(question).toContain('Befund 3');
		}
	);

	it('counts every back towards the same limit, from critique and from an earlier step alike', () => {
		const c = chain('software', 'implement');
		rounds(c, ['Befund 1']);
		expect(c.work('back', 'Befund 2').outcome).toEqual({ next: 'refine', then: 'run' });
		c.work('done');
		c.work('done');
		c.work('done');

		expect(c.work('back', 'Befund 3').outcome.then).toBe('human');
	});

	it('counts the back of a critique run the human started, so the third back is the question', () => {
		const c = chain('software', 'critique');
		expect(c.work('back', 'Befund 1').outcome).toEqual({ next: 'implement', then: 'run' });
		c.work('done');
		expect(c.work('back', 'Befund 2').outcome).toEqual({ next: 'implement', then: 'run' });
		c.work('done');

		const third = c.work('back', 'Befund 3');

		expect(third.outcome).toEqual({
			next: 'critique',
			then: 'human',
			question_id: expect.any(Number)
		});
	});

	it('keeps counting through a critique run that resumes after a park', () => {
		const c = chain('software', 'implement');
		rounds(c, ['Befund 1', 'Befund 2']);
		c.work('done');
		const parked = c.current();
		runs.startRun(c.db, system, parked);
		runs.finishRun(c.db, system, parked, { state: 'paused' });
		const resumed = runs.createRun(c.db, system, {
			ticketId: c.ticketId,
			profileId: c.profileId,
			resumedFromRunId: parked,
			resumeReason: 'context_budget'
		}).id;
		runs.startRun(c.db, system, resumed);

		const third = finishStep(c.db, { kind: 'agent', runId: resumed }, c.ticketId, {
			result: 'back',
			summary: 'Befund 3'
		});

		expect(third).toEqual({ next: 'critique', then: 'human', question_id: expect.any(Number) });
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

describe('the chain across a blocks predecessor', () => {
	/** A started successor whose `back` run ended while the predecessor, in another project, was still open. */
	function gated() {
		const c = chain('software', 'critique');
		const otherProject = board.createProject(c.db, user, { key: 'PRE', name: 'Davor' }).id;
		const predecessor = board.createTicket(c.db, user, otherProject, { title: 'Davor' }).id;
		board.linkRelation(c.db, user, predecessor, c.ticketId, 'blocks');
		const back = c.work('back', 'Finding: the header row is missing');
		const finish = (id: number) => board.moveTicket(c.db, user, id, doneColumn(c.db, id));
		return { c, predecessor, back, finish };
	}
	const doneColumn = (db: ReturnType<typeof chain>['db'], ticketId: number) =>
		board.columns(db, board.ticket(db, ticketId).project_id).find((col) => col.phase === 'done')!
			.id;
	const lageOf = (c: ReturnType<typeof chain>, ticketId: number) =>
		ticketLagen(c.db).find((row) => row.ticketId === ticketId)!;
	/** Adds a newest run of the successor that ends in `state`. */
	const endRun = (c: ReturnType<typeof chain>, state: 'failed' | 'cancelled' | 'paused') => {
		const id = runs.createRun(c.db, user, { ticketId: c.ticketId, profileId: c.profileId }).id;
		runs.startRun(c.db, system, id);
		runs.finishRun(c.db, system, id, { state, error: 'model gone' });
	};

	it('queues exactly one run for a started successor once its predecessor is done, across projects', () => {
		const { c, predecessor, back, finish } = gated();
		expect(lageOf(c, c.ticketId)).toMatchObject({
			lage: 'open',
			reason: { kind: 'predecessors' }
		});
		finish(predecessor);
		const queued = queueUnblockedSuccessors(c.db, predecessor);

		expect(queued).toHaveLength(1);
		expect(c.run(queued[0].id)).toMatchObject({
			trigger: 'on_enter',
			profileId: c.profileId,
			step: 'implement'
		});
		expect(queueUnblockedSuccessors(c.db, predecessor)).toEqual([]);
		expect(c.runCount()).toBe(back.finished + 1);
		expect(lageOf(c, c.ticketId)).toMatchObject({ reason: { kind: 'capacity' } });
	});

	it('gives the follow-up run the context of the back run: its summary among the latest comments', () => {
		const { c, predecessor, finish } = gated();
		finish(predecessor);
		const [queued] = queueUnblockedSuccessors(c.db, predecessor);
		const profile = runs.getProfile(c.db, c.profileId);

		const { user: prompt } = assemblePrompt(c.db, { id: queued.id, ticketId: c.ticketId, profile });

		expect(prompt).toContain('Finding: the header row is missing');
	});

	it('queues nothing for a successor that never ran, in the backlog or in a work step', () => {
		for (const step of ['backlog', 'implement'] as const) {
			const c = chain('software', 'plan');
			const predecessor = board.createTicket(c.db, user, c.projectId, { title: 'Davor' }).id;
			const idle = board.createTicket(c.db, user, c.projectId, {
				title: 'Idle',
				column_id: c.columnOf(step)
			}).id;
			board.linkRelation(c.db, user, predecessor, idle, 'blocks');
			board.moveTicket(c.db, user, predecessor, doneColumn(c.db, predecessor));

			expect(queueUnblockedSuccessors(c.db, predecessor)).toEqual([]);
			expect(lageOf(c, idle)).toMatchObject({
				reason: { kind: step === 'backlog' ? 'not_prioritized' : 'ready' }
			});
			expect(c.runCount()).toBe(1);
		}
	});

	it('queues nothing while the successor has an open question', () => {
		const { c, predecessor, finish } = gated();
		requestHuman(c.db, user, c.ticketId, { question: 'Which format?' });
		finish(predecessor);
		expect(queueUnblockedSuccessors(c.db, predecessor)).toEqual([]);
	});

	it.each(['failed', 'cancelled', 'paused'] as const)(
		'queues nothing when the newest run of the successor is %s',
		(state) => {
			const { c, predecessor, finish } = gated();
			endRun(c, state);
			finish(predecessor);
			expect(queueUnblockedSuccessors(c.db, predecessor)).toEqual([]);
		}
	);

	it('queues nothing when the newest run ended without finishing its step (stalled)', () => {
		const c = chain('software', 'implement');
		const predecessor = board.createTicket(c.db, user, c.projectId, { title: 'Davor' }).id;
		board.linkRelation(c.db, user, predecessor, c.ticketId, 'blocks');
		runs.startRun(c.db, system, c.current());
		runs.finishRun(c.db, system, c.current(), { state: 'succeeded' });
		board.moveTicket(c.db, user, predecessor, doneColumn(c.db, predecessor));

		expect(queueUnblockedSuccessors(c.db, predecessor)).toEqual([]);
	});

	it('queues nothing while the successor has a run waiting or running', () => {
		for (const start of [false, true]) {
			const { c, predecessor, finish } = gated();
			const waiting = runs.createRun(c.db, user, {
				ticketId: c.ticketId,
				profileId: c.profileId
			}).id;
			if (start) runs.startRun(c.db, system, waiting);
			finish(predecessor);
			expect(queueUnblockedSuccessors(c.db, predecessor)).toEqual([]);
		}
	});

	it('queues nothing while another predecessor is still open', () => {
		const { c, predecessor, finish } = gated();
		const second = board.createTicket(c.db, user, c.projectId, { title: 'Auch davor' }).id;
		board.linkRelation(c.db, user, second, c.ticketId, 'blocks');
		finish(predecessor);
		expect(queueUnblockedSuccessors(c.db, predecessor)).toEqual([]);

		finish(second);
		expect(queueUnblockedSuccessors(c.db, second)).toHaveLength(1);
	});

	it('does not count a predecessor that only reached acceptance as done under the default', () => {
		const { c, predecessor } = gated();
		const acceptance = board
			.columns(c.db, board.ticket(c.db, predecessor).project_id)
			.find((col) => col.phase === 'acceptance')!;
		board.moveTicket(c.db, user, predecessor, acceptance.id);
		expect(board.blockingPredecessors(c.db, c.ticketId)).toHaveLength(1);
		expect(queueUnblockedSuccessors(c.db, predecessor)).toEqual([]);

		board.moveTicket(c.db, user, predecessor, doneColumn(c.db, predecessor));
		expect(queueUnblockedSuccessors(c.db, predecessor)).toHaveLength(1);
	});

	it('queues nothing when the newest run recorded back but then failed', () => {
		const { c, predecessor, back, finish } = gated();
		c.db
			.prepare("UPDATE runs SET state = 'failed', error = 'model gone' WHERE id = ?")
			.run(back.finished);
		finish(predecessor);

		expect(queueUnblockedSuccessors(c.db, predecessor)).toEqual([]);
	});
});

describe('releasing a predecessor again and again', () => {
	const done = (db: ReturnType<typeof chain>['db'], id: number) =>
		board.columns(db, board.ticket(db, id).project_id).find((col) => col.phase === 'done')!.id;

	it('A: accept -> return -> accept gives one follow-up per release', () => {
		const c = chain('software', 'critique');
		const pre = board.createTicket(c.db, user, c.projectId, {
			title: 'Davor',
			column_id: c.columnOf('acceptance')
		}).id;
		board.linkRelation(c.db, user, pre, c.ticketId, 'blocks');
		c.work('back', 'Finding 1');
		acceptTicket(c.db, user, pre);
		const first = queueUnblockedSuccessors(c.db, pre);
		expect(first).toHaveLength(1);
		expect(queueUnblockedSuccessors(c.db, pre)).toEqual([]);
		returnTicket(c.db, user, pre, 'Nochmal');
		expect(queueUnblockedSuccessors(c.db, pre)).toEqual([]);
		// the follow-up still runs while the predecessor is open again and ends back
		runs.startRun(c.db, system, first[0].id);
		finishStep(c.db, { kind: 'agent', runId: first[0].id }, c.ticketId, {
			result: 'back',
			summary: 'Finding 2'
		});
		runs.finishRun(c.db, system, first[0].id, { state: 'succeeded' });
		expect(queueNextStep(c.db, first[0].id)).toBeUndefined();
		// predecessor released again: human moves it to done
		const preRun = runs.pendingRun(c.db, pre)!;
		runs.finishRun(c.db, system, preRun.id, { state: 'cancelled' });
		board.moveTicket(c.db, user, pre, done(c.db, pre));
		const second = queueUnblockedSuccessors(c.db, pre);
		expect(second).toHaveLength(1);
		expect(queueUnblockedSuccessors(c.db, pre)).toEqual([]);
		const onEnter = c.db
			.prepare("SELECT count(*) AS n FROM runs WHERE ticket_id = ? AND trigger = 'on_enter'")
			.get(c.ticketId) as { n: number };
		expect(onEnter.n).toBe(2);
	});

	it('B: successor in a knowledge project, predecessor in a direct project', () => {
		const c = chain('knowledge', 'critique');
		const other = board.createProject(c.db, user, { key: 'DIR', name: 'Direkt' }, 'direct').id;
		const pre = board.createTicket(c.db, user, other, { title: 'Davor' }).id;
		board.linkRelation(c.db, user, pre, c.ticketId, 'blocks');
		c.work('back', 'Finding');
		board.moveTicket(c.db, user, pre, done(c.db, pre));
		const queued = queueUnblockedSuccessors(c.db, pre);
		expect(queued).toHaveLength(1);
		expect(c.run(queued[0].id)).toMatchObject({ trigger: 'on_enter', step: 'draft' });
	});

	it('D: a successor the human parked in a work step after its run finished done is started by an unrelated predecessor move', () => {
		const c = chain('software', 'critique');
		board.setBlocksSatisfiedAt(c.db, user, c.projectId, 'review_ok');
		const pre = board.createTicket(c.db, user, c.projectId, {
			title: 'Davor',
			column_id: c.columnOf('acceptance')
		}).id;
		board.approveReview(c.db, user, pre);
		board.linkRelation(c.db, user, pre, c.ticketId, 'blocks');
		expect(board.blockingPredecessors(c.db, c.ticketId)).toEqual([]);
		const critique = c.current();
		runs.startRun(c.db, system, critique);
		finishStep(c.db, { kind: 'agent', runId: critique }, c.ticketId, {
			result: 'done',
			summary: 'Passt'
		});
		runs.finishRun(c.db, system, critique, { state: 'succeeded' }); // as the runner ends it: the executor returned
		expect(queueNextStep(c.db, critique)).toBeUndefined();
		expect(c.stepOf()).toBe('acceptance');
		board.moveTicket(c.db, user, c.ticketId, c.columnOf('implement')); // human parks S in a work step
		const before = c.runCount();
		acceptTicket(c.db, user, pre); // predecessor was already satisfied; this move changes nothing for S
		expect(queueUnblockedSuccessors(c.db, pre)).toEqual([]);
		expect(c.runCount()).toBe(before);
	});
});
