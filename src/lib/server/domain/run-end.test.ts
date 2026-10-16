import { describe, expect, it } from 'vitest';
import type { Stall } from '../agents/loop-guard';
import { migrate, openDb } from '../db';
import type { ExecutorFacts } from '../executors/contract';
import type { ParkReason } from '../runner';
import * as board from './board';
import type { Actor } from './core';
import { requestHuman } from './questions';
import { endExecutedRun } from './run-end';
import * as runs from './runs';
import { finishStep } from './steps';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };
const stall: Stall = {
	kind: 'length_stop',
	cause: 'length_stop',
	reason: 'Step 1 hit the output limit before it finished.'
};
const quota: ParkReason = { reason: 'quota', notBefore: '2099-01-01T00:00:00.000Z' };

/** A ticket in its implement step with a started run, and the facts-only way to end that run. */
function world() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'END', name: 'Ende' }).id;
	const implement = board.columns(db, projectId).find((c) => c.step === 'implement')!.id;
	const ticketId = board.createTicket(db, user, projectId, {
		title: 'Export',
		description: 'CSV export',
		size: 'S',
		column_id: implement
	}).id;
	board.completeTasks(db, user, ticketId, board.addTasks(db, user, ticketId, ['Criterion']).ids);
	const profileId = runs.createProfile(db, user, {
		name: 'Local',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const started = (id: number) => {
		runs.startRun(db, system, id);
		return { id, ticketId, profile: { id: profileId } };
	};
	const first = () => started(runs.createRun(db, user, { ticketId, profileId }).id);
	const agent = (run: { id: number }): Actor => ({ kind: 'agent', runId: run.id });
	const row = (id: number) =>
		db.prepare('SELECT state, error, tokens_in, tokens_out FROM runs WHERE id = ?').get(id) as {
			state: string;
			error: string | null;
			tokens_in: number;
			tokens_out: number;
		};
	const resumedFrom = (id: number) =>
		db
			.prepare('SELECT id, resume_reason, not_before FROM runs WHERE resumed_from_run_id = ?')
			.all(id) as { id: number; resume_reason: string | null; not_before: string | null }[];
	const nextStepRuns = () =>
		db.prepare("SELECT id FROM runs WHERE trigger = 'on_enter'").all() as { id: number }[];
	const questions = (runId: number) =>
		db.prepare('SELECT question FROM questions WHERE run_id = ?').all(runId) as {
			question: string;
		}[];
	const events = (runId: number) =>
		db
			.prepare('SELECT seq, type, idempotency_key AS key, payload FROM run_events WHERE run_id = ?')
			.all(runId)
			.map((e) => ({ ...e, payload: JSON.parse(e.payload as string) })) as {
			seq: number;
			type: string;
			key: string | null;
			payload: Record<string, unknown>;
		}[];
	const comments = () =>
		db.prepare('SELECT run_id, body FROM comments ORDER BY id').all() as {
			run_id: number | null;
			body: string;
		}[];
	const finishOwnStep = (run: { id: number }) =>
		finishStep(db, agent(run), ticketId, { result: 'done', summary: 'Done.' });
	const end = (
		run: { id: number; ticketId: number; profile: { id: number } },
		facts: ExecutorFacts,
		park?: ParkReason
	) => endExecutedRun(db, run, facts, park);
	return {
		db,
		ticketId,
		profileId,
		started,
		first,
		agent,
		row,
		resumedFrom,
		nextStepRuns,
		questions,
		events,
		comments,
		finishOwnStep,
		end
	};
}

describe('endExecutedRun', () => {
	describe('a run that asked the human', () => {
		it.each<[string, ExecutorFacts, ParkReason?]>([
			['ended its turn', { ending: 'end_turn' }],
			['was parked', { ending: 'parked' }, quota],
			['stalled', { ending: 'stalled', stall }],
			['hit the turn limit', { ending: 'turn_limit' }]
		])('pauses when it %s, without a follow-up run', (_name, facts, park) => {
			const w = world();
			const run = w.first();
			requestHuman(w.db, w.agent(run), w.ticketId, { question: 'Which columns?' });

			w.end(run, facts, park);

			expect(w.row(run.id).state).toBe('paused');
			expect(w.resumedFrom(run.id)).toEqual([]);
			expect(w.events(run.id).some((e) => e.key === 'handoff')).toBe(true);
		});

		it('counts any question of the run, also one that was answered before the run ended', () => {
			const w = world();
			const run = w.first();
			const { id } = requestHuman(w.db, w.agent(run), w.ticketId, { question: 'Which columns?' });
			w.db
				.prepare(
					'UPDATE questions SET answer = \'{"text":"All"}\', answered_at = CURRENT_TIMESTAMP WHERE id = ?'
				)
				.run(id);

			w.end(run, { ending: 'turn_limit' });

			expect(w.row(run.id).state).toBe('paused');
		});
	});

	describe('a parked run', () => {
		it('pauses and queues a follow-up run with the park reason, held back until its time', () => {
			const w = world();
			const run = w.first();

			w.end(run, { ending: 'parked', lastMessage: 'Commenting now.' }, quota);

			expect(w.row(run.id).state).toBe('paused');
			expect(w.resumedFrom(run.id)).toMatchObject([
				{ resume_reason: 'quota', not_before: '2099-01-01T00:00:00.000Z' }
			]);
			expect(w.nextStepRuns()).toEqual([]);
		});

		it('points the follow-up run at the handoff of the parked run', () => {
			const w = world();
			const run = w.first();

			w.end(run, { ending: 'parked', lastMessage: 'Commenting now.' }, quota);

			const handoff = w.events(run.id).find((e) => e.key === 'handoff')!;
			expect(handoff.payload).toEqual({ text: 'Commenting now.' });
		});

		it('succeeds instead when the run finished its step, so the next step gets a fresh run, not a resume', () => {
			const w = world();
			const run = w.first();
			w.finishOwnStep(run);

			w.end(run, { ending: 'parked' }, quota);

			expect(w.row(run.id).state).toBe('succeeded');
			expect(w.resumedFrom(run.id)).toEqual([]);
			expect(w.nextStepRuns()).toHaveLength(1);
		});

		it('queues the follow-up for the quota even when the chain has used up its fresh runs', () => {
			const w = world();
			const stalled = w.first();
			w.end(stalled, { ending: 'stalled', stall });
			const fresh = w.started(w.resumedFrom(stalled.id)[0].id);

			w.end(fresh, { ending: 'parked' }, quota);

			expect(w.row(fresh.id).state).toBe('paused');
			expect(w.resumedFrom(fresh.id)).toMatchObject([{ resume_reason: 'quota' }]);
			expect(w.questions(fresh.id)).toEqual([]);
		});

		it('fails the run, and writes nothing, when nobody asked it to park', () => {
			const w = world();
			const run = w.first();

			expect(() => w.end(run, { ending: 'parked' })).toThrow(/park/);

			expect(w.row(run.id).state).toBe('running');
			expect(w.events(run.id)).toEqual([]);
		});
	});

	describe('a stalled run', () => {
		it('pauses and queues a recovery run while its chain has a fresh run left, after one intervention event', () => {
			const w = world();
			const run = w.first();

			w.end(run, { ending: 'stalled', stall });

			expect(w.row(run.id).state).toBe('paused');
			expect(w.resumedFrom(run.id)).toMatchObject([{ resume_reason: 'recovery' }]);
			expect(w.events(run.id).map((e) => [e.type, e.key])).toEqual([
				['intervention', null],
				['message', 'handoff']
			]);
			expect(w.events(run.id)[0].payload).toMatchObject({
				attempt: 1,
				max: 1,
				kind: 'length_stop'
			});
		});

		it('asks the human instead once the chain has used up its fresh run', () => {
			const w = world();
			const stalled = w.first();
			w.end(stalled, { ending: 'stalled', stall });
			const fresh = w.started(w.resumedFrom(stalled.id)[0].id);

			w.end(fresh, { ending: 'stalled', stall });

			expect(w.row(fresh.id).state).toBe('paused');
			expect(w.resumedFrom(fresh.id)).toEqual([]);
			expect(w.questions(fresh.id)).toHaveLength(1);
			expect(w.questions(fresh.id)[0].question).toContain(`Run ${fresh.id} kommt nicht weiter`);
		});

		it('succeeds when the run finished its step before it stalled', () => {
			const w = world();
			const run = w.first();
			w.finishOwnStep(run);

			w.end(run, { ending: 'stalled', stall });

			expect(w.row(run.id).state).toBe('succeeded');
			expect(w.resumedFrom(run.id)).toEqual([]);
		});
	});

	describe('a run at its turn limit', () => {
		it('fails with step_limit and a comment that names the way out when it did not finish its step', () => {
			const w = world();
			const run = w.first();
			w.db
				.prepare("INSERT INTO run_events (run_id, seq, type, payload) VALUES (?, 1, 'log', ?)")
				.run(run.id, JSON.stringify({ kind: 'step', step: 1 }));

			w.end(run, { ending: 'turn_limit' });

			expect(w.row(run.id)).toMatchObject({
				state: 'failed',
				error: expect.stringMatching(/^\[step_limit\] .*nach 1 Schritten .*finish_step/)
			});
			expect(w.comments()).toEqual([
				{
					run_id: run.id,
					body: expect.stringMatching(/Ausweg: .*finish_step.*max_steps.*kleiner/)
				}
			]);
			expect(w.events(run.id).some((e) => e.key === 'handoff')).toBe(true);
		});

		it('succeeds when it finished its step', () => {
			const w = world();
			const run = w.first();
			w.finishOwnStep(run);

			w.end(run, { ending: 'turn_limit' });

			expect(w.row(run.id).state).toBe('succeeded');
			expect(w.nextStepRuns()).toHaveLength(1);
			expect(w.comments().filter((c) => c.body.includes('fehlgeschlagen'))).toEqual([]);
		});
	});

	describe('a run that ended its turn', () => {
		it('succeeds without a next step while its step is not finished', () => {
			const w = world();
			const run = w.first();

			w.end(run, { ending: 'end_turn', lastMessage: 'All done.' });

			expect(w.row(run.id).state).toBe('succeeded');
			expect(w.nextStepRuns()).toEqual([]);
			expect(w.resumedFrom(run.id)).toEqual([]);
		});

		it('succeeds and queues the run for the next step once its step is finished', () => {
			const w = world();
			const run = w.first();
			w.finishOwnStep(run);

			w.end(run, { ending: 'end_turn' });

			expect(w.row(run.id).state).toBe('succeeded');
			expect(w.nextStepRuns()).toHaveLength(1);
		});
	});

	it('books the usage the facts carry on the run, whatever the ending', () => {
		const w = world();
		const run = w.first();

		w.end(run, { ending: 'end_turn', usage: { tokensIn: 7, tokensOut: 3 } });

		expect(w.row(run.id)).toMatchObject({ tokens_in: 7, tokens_out: 3 });
	});

	describe('the handoff', () => {
		it('is the last message of the executor when there is one', () => {
			const w = world();
			const run = w.first();

			w.end(run, { ending: 'end_turn', lastMessage: 'Exported the header row.' });

			expect(w.events(run.id)).toMatchObject([
				{ type: 'message', key: 'handoff', payload: { text: 'Exported the header row.' } }
			]);
		});

		it('is generated from the tool results and names the step key, not the column, when there is none', () => {
			const w = world();
			const run = w.first();
			const result = (tool: string, isError: boolean, seq: number) =>
				w.db
					.prepare(
						"INSERT INTO run_events (run_id, seq, type, payload) VALUES (?, ?, 'tool_result', ?)"
					)
					.run(run.id, seq, JSON.stringify({ tool, isError }));
			result('add_comment', false, 1);
			result('finish_step', true, 2);
			result('finish_step', false, 3);
			w.finishOwnStep(run);

			w.end(run, { ending: 'end_turn' });

			const handoff = w.events(run.id).find((e) => e.key === 'handoff')!;
			expect(handoff.payload).toEqual({
				text: [
					"Summary: the model ended without a closing text; this handoff is generated from the run's events.",
					'Tools: add_comment 1×, finish_step 2× (1 failed)',
					'Ticket: moved to critique',
					'Open tasks: none'
				].join('\n'),
				generated: true
			});
		});
	});
});
