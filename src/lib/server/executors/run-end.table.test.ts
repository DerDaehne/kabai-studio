import { afterEach, describe, expect, it, vi } from 'vitest';
import { interventionOf, type Stall } from '../agents/loop-guard';
import { migrate, openDb } from '../db';
import * as board from '../domain/board';
import type { Actor } from '../domain/core';
import { answerQuestion, requestHuman } from '../domain/questions';
import * as runs from '../domain/runs';
import { finishStep, type StepResult } from '../domain/steps';
import { subscribe } from '../events';
import { startRunner } from '../runner';
import { builtinExecutor } from './builtin';
import type { Executor, ExecutorFacts, ExecutorIo, RunContext } from './contract';
import { call, fakeProvider, type Reply } from './fake-model';

const user: Actor = { kind: 'user' };

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

/** Everything the end of a run leaves behind, as the table states it for every scenario. */
type Row = {
	state: string;
	errorCode: string | null;
	events: string[];
	handoff: unknown;
	followUp: { reason: string | null; held: boolean } | null;
	nextStep: string | null;
	question: string | null;
	failureComment: string | null;
	answerComments: number;
};
type Scenario = {
	name: string;
	profile?: Partial<runs.Profile>;
	column?: string;
	/** What the fake model sends to the real builtin executor. */
	replies: (park: () => void) => Reply[];
	/** What an executor that only reports facts does for the same scenario: the domain effects of its tools, then its facts. */
	facts: (executor: FakeRun) => ExecutorFacts;
	/** How many runs of the scenario's chain execute; later ones wait. */
	executions?: number;
	/** The run to observe: the first one, the fresh run it handed off to, or the run that resumes it once the human answered. */
	observe?: 'first' | 'fresh' | 'resumed';
	expected: Row;
};

type FakeRun = {
	db: ReturnType<typeof setup>['db'];
	run: RunContext;
	io: ExecutorIo;
	/** 0 for the first run of the scenario, 1 for the run that follows it. */
	nth: number;
	park: () => void;
};
const agentOf = (run: RunContext): Actor => ({ kind: 'agent', runId: run.id });
const toolResult = ({ io }: FakeRun, tool: string) =>
	io.emit({ type: 'tool_result', payload: { tool, isError: false } });
const stepLog = ({ io }: FakeRun, step: number) =>
	io.emit({ type: 'log', payload: { kind: 'step', step } });
function finish(executor: FakeRun, result: StepResult, summary: string) {
	finishStep(executor.db, agentOf(executor.run), executor.run.ticketId, { result, summary });
	toolResult(executor, 'finish_step');
}
function ask(executor: FakeRun, question: string, options: { label: string }[] = []) {
	requestHuman(executor.db, agentOf(executor.run), executor.run.ticketId, { question, options });
	toolResult(executor, 'request_human');
}
const stall: Stall = {
	kind: 'length_stop',
	cause: 'length_stop',
	reason: 'Step 3 hit the output limit before it finished.',
	stepTokens: 1
};
const cutOff = (): Reply => ({
	chunks: [{ reasoning: 'Let me reconsider.\n' }],
	finish: 'length'
});
const runLabel = (text: string) => text.replace(/(Run |run |run=)\d+/g, '$1<run>');

const SCENARIOS: Scenario[] = [
	{
		name: 'S1 finish_step done succeeds and queues the run for the next step',
		replies: () => [
			{ chunks: [call('c1', 'finish_step', { result: 'done', summary: 'Plan: one writer.' })] }
		],
		facts: (x) => {
			finish(x, 'done', 'Plan: one writer.');
			return { ending: 'end_turn' };
		},
		expected: {
			state: 'succeeded',
			errorCode: null,
			events: ['message:handoff:agent'],
			handoff: {
				text: "Summary: the model ended without a closing text; this handoff is generated from the run's events.\nTools: finish_step 1×\nTicket: moved to implement\nOpen tasks: none",
				generated: true
			},
			followUp: null,
			nextStep: 'on_enter',
			question: null,
			failureComment: null,
			answerComments: 0
		}
	},
	{
		name: 'S2 request_human pauses without a follow-up run',
		replies: () => [{ chunks: [call('c1', 'request_human', { question: 'Which columns?' })] }],
		facts: (x) => {
			ask(x, 'Which columns?');
			return { ending: 'end_turn' };
		},
		expected: {
			state: 'paused',
			errorCode: null,
			events: ['message:handoff:agent'],
			handoff: {
				text: "Summary: the model ended without a closing text; this handoff is generated from the run's events.\nTools: request_human 1×\nTicket: not moved, still in plan\nOpen tasks: none",
				generated: true
			},
			followUp: null,
			nextStep: null,
			question: 'Which columns?',
			failureComment: null,
			answerComments: 0
		}
	},
	{
		name: 'S3 finish_step blocked pauses with the question',
		column: 'Umsetzen',
		replies: () => [
			{ chunks: [call('c1', 'finish_step', { result: 'blocked', summary: 'Which format?' })] }
		],
		facts: (x) => {
			finish(x, 'blocked', 'Which format?');
			return { ending: 'end_turn' };
		},
		expected: {
			state: 'paused',
			errorCode: null,
			events: ['message:handoff:agent'],
			handoff: {
				text: "Summary: the model ended without a closing text; this handoff is generated from the run's events.\nTools: finish_step 1×\nTicket: not moved, still in implement\nOpen tasks: none",
				generated: true
			},
			followUp: null,
			nextStep: null,
			question: 'Which format?',
			failureComment: null,
			answerComments: 0
		}
	},
	{
		name: 'S4 max_steps without finish_step fails with step_limit and a comment',
		profile: { max_steps: 2 },
		replies: () => [
			{ chunks: [call('c1', 'add_comment', { text: 'one' })] },
			{ chunks: [call('c2', 'add_comment', { text: 'two' })] }
		],
		facts: (x) => {
			stepLog(x, 1);
			toolResult(x, 'add_comment');
			stepLog(x, 2);
			toolResult(x, 'add_comment');
			return { ending: 'turn_limit' };
		},
		expected: {
			state: 'failed',
			errorCode: 'step_limit',
			events: ['message:handoff:agent'],
			handoff: {
				text: "Summary: the model ended without a closing text; this handoff is generated from the run's events.\nTools: add_comment 2×\nTicket: not moved, still in plan\nOpen tasks: none",
				generated: true
			},
			followUp: null,
			nextStep: null,
			question: null,
			failureComment:
				'Run <run> ist fehlgeschlagen: [step_limit] Der Run hat nach 2 Schritten aufgehört, ohne seinen Schritt mit finish_step abzuschließen.\nAusweg: Prüfe im Run-Log, ob der Agent finish_step erreicht hat, und erhöhe max_steps im Agent-Profil oder schneide das Ticket kleiner, dann starte einen neuen Run.',
			answerComments: 0
		}
	},
	{
		name: 'S5 max_steps reached by the step that finishes it succeeds',
		profile: { max_steps: 2 },
		replies: () => [
			{ chunks: [call('c1', 'add_comment', { text: 'one' })] },
			{ chunks: [call('c2', 'finish_step', { result: 'done', summary: 'Planned' })] }
		],
		facts: (x) => {
			stepLog(x, 1);
			toolResult(x, 'add_comment');
			stepLog(x, 2);
			finish(x, 'done', 'Planned');
			return { ending: 'turn_limit' };
		},
		expected: {
			state: 'succeeded',
			errorCode: null,
			events: ['message:handoff:agent'],
			handoff: {
				text: "Summary: the model ended without a closing text; this handoff is generated from the run's events.\nTools: add_comment 1×, finish_step 1×\nTicket: moved to implement\nOpen tasks: none",
				generated: true
			},
			followUp: null,
			nextStep: 'on_enter',
			question: null,
			failureComment: null,
			answerComments: 0
		}
	},
	{
		name: 'S6 parked in the middle of a step pauses with a held follow-up run',
		replies: (park) => [
			{
				chunks: [
					{ text: 'Commenting now.' },
					{ pause: park },
					call('c1', 'add_comment', { text: 'last words' })
				]
			}
		],
		facts: (x) => {
			x.park();
			return { ending: 'parked', lastMessage: 'Commenting now.' };
		},
		expected: {
			state: 'paused',
			errorCode: null,
			events: ['message:handoff:agent'],
			handoff: { text: 'Commenting now.' },
			followUp: { reason: 'quota', held: true },
			nextStep: null,
			question: null,
			failureComment: null,
			answerComments: 0
		}
	},
	{
		name: 'S7 parked in the last step without a tool call succeeds without a follow-up run',
		replies: (park) => [{ chunks: [{ pause: park }, { text: 'Nothing left to do.' }] }],
		facts: (x) => {
			x.park();
			return { ending: 'end_turn', lastMessage: 'Nothing left to do.' };
		},
		expected: {
			state: 'succeeded',
			errorCode: null,
			events: ['message:handoff:agent'],
			handoff: { text: 'Nothing left to do.' },
			followUp: null,
			nextStep: null,
			question: null,
			failureComment: null,
			answerComments: 0
		}
	},
	{
		name: 'S8 parked in the step that calls finish_step succeeds and queues the next step',
		replies: (park) => [
			{
				chunks: [{ pause: park }, call('c1', 'finish_step', { result: 'done', summary: 'Planned' })]
			}
		],
		facts: (x) => {
			x.park();
			finish(x, 'done', 'Planned');
			return { ending: 'parked' };
		},
		expected: {
			state: 'succeeded',
			errorCode: null,
			events: ['message:handoff:agent'],
			handoff: {
				text: "Summary: the model ended without a closing text; this handoff is generated from the run's events.\nTools: finish_step 1×\nTicket: moved to implement\nOpen tasks: none",
				generated: true
			},
			followUp: null,
			nextStep: 'on_enter',
			question: null,
			failureComment: null,
			answerComments: 0
		}
	},
	{
		name: 'S9 stalled with a fresh run left hands off to a recovery run',
		replies: () => [cutOff(), cutOff(), cutOff()],
		facts: () => ({ ending: 'stalled', stall }),
		expected: {
			state: 'paused',
			errorCode: null,
			events: ['intervention::agent', 'message:handoff:agent'],
			handoff: {
				text: "Summary: the model ended without a closing text; this handoff is generated from the run's events.\nTools: none\nTicket: not moved, still in plan\nOpen tasks: none",
				generated: true
			},
			followUp: { reason: 'recovery', held: false },
			nextStep: null,
			question: null,
			failureComment: null,
			answerComments: 0
		}
	},
	{
		name: 'S10 stalled with the chain used up asks the human',
		observe: 'fresh',
		replies: () => Array.from({ length: 6 }, cutOff),
		facts: ({ io, nth }) => {
			if (nth === 1)
				for (const attempt of [1, 2])
					io.emit({ type: 'intervention', payload: interventionOf(stall, attempt, 2) });
			return { ending: 'stalled', stall };
		},
		executions: 2,
		expected: {
			state: 'paused',
			errorCode: null,
			events: ['intervention::agent', 'message:handoff:agent'],
			handoff: {
				text: "Summary: the model ended without a closing text; this handoff is generated from the run's events.\nTools: none\nTicket: not moved, still in plan\nOpen tasks: none",
				generated: true
			},
			followUp: null,
			nextStep: null,
			question:
				'Run <run> kommt nicht weiter (Stillstand oder Längenlimit). Wie soll es weitergehen?\n\nSeine Kette hat den frischen Run schon verbraucht (höchstens 1 je Kette). 2 Hinweise in diesem Run, zuletzt: „Your answer hit the output limit. Your plan was good, do not re-plan: think briefly, then take the smallest next action. Decide, change, verify.“. Den Stand zeigt die Run-Akte: /p/STU/t/1?run=<run>.',
			failureComment: null,
			answerComments: 0
		}
	},
	{
		name: 'S11 a model that ends without a closing text gets a generated handoff',
		replies: () => [
			{ chunks: [call('c1', 'add_comment', { text: 'Header row done.' })] },
			{ chunks: [] }
		],
		facts: (x) => {
			toolResult(x, 'add_comment');
			return { ending: 'end_turn' };
		},
		expected: {
			state: 'succeeded',
			errorCode: null,
			events: ['message:handoff:agent'],
			handoff: {
				text: "Summary: the model ended without a closing text; this handoff is generated from the run's events.\nTools: add_comment 1×\nTicket: not moved, still in plan\nOpen tasks: none",
				generated: true
			},
			followUp: null,
			nextStep: null,
			question: null,
			failureComment: null,
			answerComments: 0
		}
	},
	{
		name: 'S12 a run resuming after an answered question collects the answer exactly once',
		observe: 'resumed',
		replies: () => [
			{
				chunks: [
					call('c1', 'request_human', {
						question: 'Which columns go into the export?',
						options: [{ label: 'All' }, { label: 'Only id and title' }]
					})
				]
			},
			{ chunks: [{ text: 'Exporting id and title.' }] }
		],
		facts: (x) => {
			if (x.nth === 0) {
				ask(x, 'Which columns go into the export?', [
					{ label: 'All' },
					{ label: 'Only id and title' }
				]);
				return { ending: 'end_turn' };
			}
			x.io.emit({ type: 'message', payload: { step: 1, text: 'Exporting id and title.' } });
			return { ending: 'end_turn', lastMessage: 'Exporting id and title.' };
		},
		executions: 2,
		expected: {
			state: 'succeeded',
			errorCode: null,
			events: ['message:handoff:agent'],
			handoff: { text: 'Exporting id and title.' },
			followUp: null,
			nextStep: null,
			question: null,
			failureComment: null,
			answerComments: 1
		}
	}
];

function setup(profile: Partial<runs.Profile>) {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const columns = Object.fromEntries(
		db
			.prepare('SELECT name, id FROM columns WHERE project_id = ?')
			.all(projectId)
			.map((c) => [c.name, c.id])
	) as Record<string, number>;
	const ticketId = board.createTicket(db, user, projectId, {
		title: 'Refine the export',
		description: 'Export tickets as CSV.',
		column_id: columns['Planen']
	}).id;
	const profileId = runs.createProfile(db, user, {
		name: 'Local',
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: 'http://model.test/v1',
		model: 'ornith-1.5-35b',
		...profile
	}).id;
	return { db, projectId, columns, ticketId, profileId };
}

const ended = (state: () => unknown) =>
	vi.waitFor(() => expect(state()).not.toMatch(/^(queued|running)$/), { timeout: 3000 });

type Environment = {
	db: ReturnType<typeof setup>['db'];
	ticketId: number;
	/** Asks the run to park for the quota. */
	parkRun: (runId: number) => void;
	firstRun: () => number;
};
type ExecutorFor = (scenario: Scenario, env: Environment) => Executor;

/** The real builtin executor on a fake model: it works the tool loop and reports its facts. */
const builtinDriver: ExecutorFor = (scenario, env) => {
	const provider = fakeProvider(...scenario.replies(() => env.parkRun(env.firstRun())));
	return builtinExecutor(env.db, { fetch: provider.fetch });
};

/** An executor that does what the scenario's tools do in the domain and reports only facts. */
const factsOnlyDriver: ExecutorFor = (scenario, env) => {
	let executions = 0;
	return {
		async execute(run, io) {
			const nth = executions++;
			if (nth >= (scenario.executions ?? 1)) return new Promise<ExecutorFacts>(() => {});
			return scenario.facts({ db: env.db, run, io, nth, park: () => env.parkRun(run.id) });
		}
	};
};

/** Runs one scenario with the given executor and reads the row off the database and the bus. */
async function drive(scenario: Scenario, executorFor: ExecutorFor): Promise<Row> {
	const s = setup(scenario.profile ?? {});
	const { db } = s;
	const busEvents: { runId: number; eventType: string; key?: string; actorKind: string }[] = [];
	cleanups.push(
		subscribe((event) => {
			if (event.type === 'run.event')
				busEvents.push({
					runId: event.runId as number,
					eventType: event.eventType as string,
					key: event.key as string | undefined,
					actorKind: (event.actor as Actor).kind
				});
		})
	);
	if (scenario.column)
		db.prepare('UPDATE tickets SET column_id = ? WHERE id = ?').run(
			s.columns[scenario.column],
			s.ticketId
		);
	let first = 0;
	const env: Environment = {
		db,
		ticketId: s.ticketId,
		parkRun: (runId) => runner.park(runId, 'quota', '2099-01-01T00:00:00Z'),
		firstRun: () => first
	};
	const runner = startRunner(db, { builtin: executorFor(scenario, env) });
	cleanups.push(runner.stop);
	first = runs.createRun(db, user, { ticketId: s.ticketId, profileId: s.profileId }).id;
	const state = (id: number) =>
		(db.prepare('SELECT state FROM runs WHERE id = ?').get(id) as { state: string }).state;
	await ended(() => state(first));
	let observed = first;
	if (scenario.observe === 'resumed') {
		const { id: questionId } = db.prepare('SELECT id FROM questions').get() as { id: number };
		answerQuestion(db, user, questionId, { option: 2 });
		const queuedByAnswer = db
			.prepare('SELECT id FROM runs WHERE resumed_from_run_id = ?')
			.get(first) as { id: number };
		runs.finishRun(db, user, queuedByAnswer.id, { state: 'cancelled' });
		observed = runs.createRun(db, user, {
			ticketId: s.ticketId,
			profileId: s.profileId,
			resumedFromRunId: first
		}).id;
		await ended(() => state(observed));
	}
	if (scenario.observe === 'fresh') {
		observed = (
			db.prepare('SELECT id FROM runs WHERE resumed_from_run_id = ?').get(first) as { id: number }
		).id;
		await ended(() => state(observed));
	}
	return rowOf(db, observed, busEvents);
}

async function rowOf(
	db: ReturnType<typeof setup>['db'],
	runId: number,
	busEvents: { runId: number; eventType: string; key?: string; actorKind: string }[]
): Promise<Row> {
	const run = db.prepare('SELECT state, error FROM runs WHERE id = ?').get(runId) as {
		state: string;
		error: string | null;
	};
	const failureComment = () =>
		(
			db
				.prepare(
					"SELECT body FROM comments WHERE run_id = ? AND body LIKE '% ist fehlgeschlagen:%'"
				)
				.get(runId) as { body: string } | undefined
		)?.body;
	if (run.state === 'failed') await vi.waitFor(() => expect(failureComment()).toBeDefined());
	const handoffRow = db
		.prepare("SELECT payload FROM run_events WHERE run_id = ? AND idempotency_key = 'handoff'")
		.get(runId) as { payload: string } | undefined;
	const followUp = db
		.prepare('SELECT resume_reason, not_before FROM runs WHERE resumed_from_run_id = ?')
		.get(runId) as { resume_reason: string | null; not_before: string | null } | undefined;
	const nextStep = db
		.prepare("SELECT trigger FROM runs WHERE id <> ? AND trigger = 'on_enter'")
		.get(runId) as { trigger: string } | undefined;
	const question = db.prepare('SELECT question FROM questions WHERE run_id = ?').get(runId) as
		{ question: string } | undefined;
	const ends = db
		.prepare("SELECT payload FROM run_events WHERE run_id = ? AND type = 'intervention'")
		.all(runId)
		.map((e) => JSON.parse(e.payload as string) as { reason: string });
	const endsWithHandoff = ends.filter((e) => e.reason.endsWith('The run ends with a handoff.'));
	const events = busEvents
		.filter((e) => e.runId === runId)
		.filter(
			(e) => e.key === 'handoff' || (e.eventType === 'intervention' && endsWithHandoff.length)
		)
		.map((e) => `${e.eventType}:${e.key ?? ''}:${e.actorKind}`);
	const comment = failureComment();
	return {
		state: run.state,
		errorCode: run.error?.match(/^\[(\w+)\]/)?.[1] ?? null,
		events: [...new Set(events)],
		handoff: handoffRow && JSON.parse(handoffRow.payload),
		followUp: followUp
			? { reason: followUp.resume_reason, held: followUp.not_before !== null }
			: null,
		nextStep: nextStep?.trigger ?? null,
		question: question ? runLabel(question.question) : null,
		failureComment: comment ? runLabel(comment) : null,
		answerComments: (
			db.prepare("SELECT count(*) AS n FROM comments WHERE body LIKE 'Antwort:%'").get() as {
				n: number;
			}
		).n
	};
}

describe('what the end of a run leaves behind', () => {
	describe.each([
		['the builtin executor', builtinDriver],
		['an executor that reports only facts', factsOnlyDriver]
	] as const)('with %s', (_driver, executorFor) => {
		it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
			'%s',
			async (_name, scenario) => {
				expect(await drive(scenario, executorFor)).toEqual(scenario.expected);
			}
		);
	});
});
