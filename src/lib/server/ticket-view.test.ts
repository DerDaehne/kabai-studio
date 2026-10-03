import { afterEach, describe, expect, it } from 'vitest';
import * as board from './domain/board';
import { DomainError, type Actor } from './domain/core';
import { answerQuestion, requestHuman } from './domain/questions';
import {
	appendEvent,
	createProfile,
	createRun,
	deleteProfile,
	finishRun,
	startRun
} from './domain/runs';
import { migrate, openDb } from './db';
import { startRunner } from './runner';
import { findTicketId, runStart, runTabs, runTrace, ticketDetail } from './ticket-view';

const user: Actor = { kind: 'user' };

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const columnId = (name: string) =>
		db.prepare('SELECT id FROM columns WHERE project_id = ? AND name = ?').get(projectId, name)!
			.id as number;
	return { db, projectId, columnId };
}

describe('ticketDetail', () => {
	it('shows ref, project (with palette), title, description, type and column', () => {
		const { db, projectId } = setup();
		const { id } = board.createTicket(db, user, projectId, {
			title: 'Titel',
			description: 'Text'
		});
		const t = ticketDetail(db, user, id);
		expect(t.ref).toBe('STU-1');
		expect(t.project).toEqual({ id: projectId, code: 'STU', name: 'Studio', palette: 1 });
		expect(t.title).toBe('Titel');
		expect(t.description).toBe('Text');
		expect(t.type).toBe('ticket');
		expect(t.column.name).toBe('Backlog');
	});

	it('lists tasks in position order with their done flag, exactly as tasksOf does', () => {
		const { db, projectId } = setup();
		const { id } = board.createTicket(db, user, projectId, { title: 'T' });
		const a = board.addTask(db, user, id, 'A').id;
		board.addTask(db, user, id, 'B');
		board.completeTask(db, user, a);
		expect(ticketDetail(db, user, id).tasks).toEqual([
			{ id: a, title: 'A', done: true },
			{ id: expect.any(Number), title: 'B', done: false }
		]);
	});

	it('lists every comment chronologically with its author kind and run, system comments included', () => {
		const { db, projectId } = setup();
		const { id } = board.createTicket(db, user, projectId, { title: 'T' });
		board.addComment(db, user, id, 'Erster Kommentar');
		const taskId = board.addTask(db, user, id, 'A').id;
		board.deleteTask(db, user, taskId, 'überholt');
		const comments = ticketDetail(db, user, id).comments;
		expect(comments.map((c) => [c.authorKind, c.runId])).toEqual([
			['user', null],
			['system', null]
		]);
		expect(comments[0].body).toBe('Erster Kommentar');
		expect(comments[1].body).toContain('gelöscht von user. Grund: überholt');
	});

	it('names relations from this ticket, in the same reading as get_ticket, with the blocking flag on an open predecessor', () => {
		const { db, projectId } = setup();
		const blocker = board.createTicket(db, user, projectId, { title: 'Vorgänger' }).id;
		const { id } = board.createTicket(db, user, projectId, { title: 'T' });
		board.linkRelation(db, user, blocker, id, 'blocks');
		const relations = ticketDetail(db, user, id).relations;
		expect(relations.waits_for).toEqual([
			{ ref: 'STU-1', title: 'Vorgänger', column: 'Backlog', blocking: true }
		]);
	});

	it('offers every allowedMoves target, in board order, with a blocked one carrying message and hint', () => {
		const { db, projectId, columnId } = setup();
		const { id } = board.createTicket(db, user, projectId, {
			title: 'T',
			column_id: columnId('Abnahme')
		});
		board.addTask(db, user, id, 'offen');
		const moves = ticketDetail(db, user, id).moves;
		expect(moves.map((m) => [m.name, m.position, m.kind])).toEqual([
			['Review', 4, 'normal'],
			['Done', 6, 'done'],
			['Human Intervention', 7, 'human_intervention']
		]);
		const toDone = moves.find((m) => m.name === 'Done');
		expect(toDone?.blockers).toEqual([
			{
				code: 'open_tasks',
				message: 'STU-1 hat 1 offene Tasks: „offen“.',
				hint: 'Erledige die Tasks (completeTask) oder lösche überholte mit Begründung (deleteTask).'
			}
		]);
		expect(moves.find((m) => m.name === 'Review')?.blockers).toEqual([]);
	});

	it('shows the open question while unanswered, and none once the human has answered it', () => {
		const { db, projectId } = setup();
		const { id } = board.createTicket(db, user, projectId, { title: 'T' });
		const profileId = createProfile(db, user, {
			name: 'P',
			executor: 'builtin',
			provider: 'openai-compatible',
			model: 'm'
		}).id;
		const runId = createRun(db, user, { ticketId: id, profileId }).id;
		const agent: Actor = { kind: 'agent', runId };
		const q = requestHuman(db, agent, id, { question: 'Weiter so?' });
		expect(ticketDetail(db, user, id).openQuestion?.id).toBe(q.id);
		answerQuestion(db, user, q.id, { text: 'Ja' });
		expect(ticketDetail(db, user, id).openQuestion).toBeUndefined();
	});
});

describe('findTicketId', () => {
	it('resolves a project key and ticket number to the ticket id, case-insensitively, and undefined when unknown', () => {
		const { db, projectId } = setup();
		const { id, number } = board.createTicket(db, user, projectId, { title: 'T' });
		expect(findTicketId(db, 'STU', number)).toBe(id);
		expect(findTicketId(db, 'stu', number)).toBe(id);
		expect(findTicketId(db, 'STU', number + 1)).toBeUndefined();
		expect(findTicketId(db, 'NOPE', number)).toBeUndefined();
	});
});

describe('runTrace', () => {
	const stops: (() => void)[] = [];
	afterEach(() => stops.splice(0).forEach((stop) => stop()));

	function withRuns() {
		const { db, projectId } = setup();
		const ticketId = board.createTicket(db, user, projectId, { title: 'T' }).id;
		const profileId = createProfile(db, user, {
			name: 'P',
			executor: 'builtin',
			provider: 'openai-compatible',
			model: 'm'
		}).id;
		const newRun = () => createRun(db, user, { ticketId, profileId }).id;
		const running = () => {
			const id = newRun();
			startRun(db, user, id);
			return id;
		};
		return { db, projectId, ticketId, profileId, newRun, running };
	}

	it('is undefined before the ticket has a run, and for a run of another ticket', () => {
		const { db, projectId, ticketId, newRun } = withRuns();
		expect(runTrace(db, ticketId)).toBeUndefined();
		const runId = newRun();
		const other = board.createTicket(db, user, projectId, { title: 'Anderes' }).id;
		expect(runTrace(db, other, runId)).toBeUndefined();
	});

	it('shows the newest run of the ticket unless a run is selected', () => {
		const { db, ticketId, newRun } = withRuns();
		const older = newRun();
		const newer = newRun();
		expect(runTrace(db, ticketId)?.id).toBe(newer);
		expect(runTrace(db, ticketId, older)?.id).toBe(older);
		expect(runTrace(db, ticketId, older)?.state).toBe('queued');
	});

	it('loads the events of the run in seq order with their key and payload', () => {
		const { db, ticketId, running } = withRuns();
		const runId = running();
		const agent: Actor = { kind: 'agent', runId };
		appendEvent(db, agent, runId, { type: 'log', payload: { kind: 'prompt' } });
		appendEvent(db, agent, runId, {
			type: 'tool_call',
			key: 'call-1',
			payload: { step: 1, tool: 'get_ticket', args: {} }
		});
		expect(runTrace(db, ticketId)?.events).toEqual([
			{ seq: 1, type: 'log', key: null, payload: { kind: 'prompt' } },
			{
				seq: 2,
				type: 'tool_call',
				key: 'call-1',
				payload: { step: 1, tool: 'get_ticket', args: {} }
			}
		]);
	});

	it('reads code and message of a failed run and the way out from the failure comment the runner wrote', async () => {
		const { db, ticketId, newRun } = withRuns();
		const runId = newRun();
		const fail = async () => {
			throw new DomainError('step_limit', 'Der Run hat aufgehört.', 'Erhöhe max_steps.');
		};
		stops.push(startRunner(db, { builtin: { execute: fail } }).stop);
		while (runTrace(db, ticketId)?.state !== 'failed')
			await new Promise((resolve) => setImmediate(resolve));
		expect(runTrace(db, ticketId)?.failure).toEqual({
			code: 'step_limit',
			message: 'Der Run hat aufgehört.',
			wayOut: 'Erhöhe max_steps.'
		});
		expect(runTrace(db, ticketId, runId)?.continuedBy).toBeUndefined();
	});

	it('leaves the way out empty when the failure comment is missing', () => {
		const { db, ticketId, running } = withRuns();
		const runId = running();
		finishRun(db, user, runId, { state: 'failed', error: '[executor_error] boom' });
		expect(runTrace(db, ticketId)?.failure).toEqual({
			code: 'executor_error',
			message: 'boom',
			wayOut: ''
		});
	});

	it('knows a paused run waits for the human until the answer queues the run that continues it', () => {
		const { db, ticketId, running } = withRuns();
		const runId = running();
		const q = requestHuman(db, { kind: 'agent', runId }, ticketId, { question: 'Weiter so?' });
		finishRun(db, user, runId, { state: 'paused' });
		expect(runTrace(db, ticketId)).toMatchObject({ state: 'paused', waitsForAnswer: true });
		expect(runTrace(db, ticketId)?.continuedBy).toBeUndefined();

		answerQuestion(db, user, q.id, { text: 'Ja' });
		const continued = runTrace(db, ticketId, runId);
		expect(continued?.waitsForAnswer).toBe(false);
		expect(continued?.continuedBy).toBe(runTrace(db, ticketId)?.id);
		expect(continued?.continuedBy).not.toBe(runId);
	});

	it('does not name a cancelled follow-up run as the one that continues', () => {
		const { db, ticketId, profileId, running } = withRuns();
		const runId = running();
		finishRun(db, user, runId, { state: 'paused' });
		const resume = () => createRun(db, user, { ticketId, profileId, resumedFromRunId: runId }).id;
		finishRun(db, user, resume(), { state: 'cancelled' });
		expect(runTrace(db, ticketId, runId)?.continuedBy).toBeUndefined();
		const next = resume();
		expect(runTrace(db, ticketId, runId)?.continuedBy).toBe(next);
	});
});

describe('runTabs', () => {
	function withProfile(pool = 'local') {
		const { db, projectId } = setup();
		const ticketId = board.createTicket(db, user, projectId, { title: 'T' }).id;
		const profileId = createProfile(db, user, {
			name: 'Lokal',
			executor: 'builtin',
			provider: 'openai-compatible',
			model: 'm',
			pool
		}).id;
		return { db, projectId, ticketId, profileId };
	}

	it('lists the runs of the ticket newest first with state, profile, times and usage', () => {
		const { db, projectId, ticketId, profileId } = withProfile();
		const older = createRun(db, user, { ticketId, profileId }).id;
		startRun(db, user, older);
		finishRun(db, user, older, {
			state: 'succeeded',
			usage: { tokensIn: 1200, tokensOut: 80, cost: 0.5 }
		});
		const newer = createRun(db, user, { ticketId, profileId }).id;
		const other = board.createTicket(db, user, projectId, { title: 'Anderes' }).id;
		createRun(db, user, { ticketId: other, profileId });

		const tabs = runTabs(db, ticketId);
		expect(tabs.map((tab) => [tab.id, tab.state])).toEqual([
			[newer, 'queued'],
			[older, 'succeeded']
		]);
		expect(tabs[1]).toMatchObject({
			profile: 'Lokal',
			tokensIn: 1200,
			tokensOut: 80,
			cost: 0.5,
			resumedFrom: null,
			resumeReason: null
		});
		expect(tabs[1].startedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
		expect(tabs[1].finishedAt).toMatch(/Z$/);
		expect(tabs[0]).toMatchObject({ startedAt: null, finishedAt: null });
	});

	it('gives only a queued run the reason it waits, in the words of waitReason', () => {
		const { db, ticketId, profileId } = withProfile();
		const busy = createRun(db, user, { ticketId, profileId }).id;
		startRun(db, user, busy);
		createRun(db, user, { ticketId, profileId });
		const [waiting, running] = runTabs(db, ticketId);
		expect(waiting.waitText).toBe('wartet: Pool „local“ ist voll (1 von 1 aktiv).');
		expect(running.waitText).toBeUndefined();
	});

	it('names the run a continuation comes from and why', () => {
		const { db, ticketId, profileId } = withProfile();
		const first = createRun(db, user, { ticketId, profileId }).id;
		startRun(db, user, first);
		finishRun(db, user, first, { state: 'paused' });
		createRun(db, user, {
			ticketId,
			profileId,
			resumedFromRunId: first,
			resumeReason: 'context_budget'
		});
		expect(runTabs(db, ticketId)[0]).toMatchObject({
			resumedFrom: first,
			resumeReason: 'context_budget'
		});
	});

	it('keeps a run whose profile was deleted, without a profile name', () => {
		const { db, ticketId, profileId } = withProfile();
		const runId = createRun(db, user, { ticketId, profileId }).id;
		finishRun(db, user, runId, { state: 'cancelled' });
		deleteProfile(db, user, profileId);
		expect(runTabs(db, ticketId)[0].profile).toBeNull();
	});
});

describe('runStart', () => {
	const profile = (db: ReturnType<typeof setup>['db'], name: string) =>
		createProfile(db, user, {
			name,
			executor: 'builtin',
			provider: 'openai-compatible',
			model: 'm'
		}).id;

	it('offers no profile and preselects none before the first profile exists', () => {
		const { db, projectId } = setup();
		expect(runStart(db, projectId)).toEqual({ profiles: [], preselected: undefined });
	});

	it('preselects the first profile by name before the project has run', () => {
		const { db, projectId } = setup();
		const zeta = profile(db, 'Zeta');
		const alpha = profile(db, 'Alpha');
		expect(runStart(db, projectId)).toEqual({
			profiles: [
				{ id: alpha, name: 'Alpha' },
				{ id: zeta, name: 'Zeta' }
			],
			preselected: alpha
		});
	});

	it('preselects the profile this project used last, not the one another project used', () => {
		const { db, projectId } = setup();
		const alpha = profile(db, 'Alpha');
		const zeta = profile(db, 'Zeta');
		const ticketId = board.createTicket(db, user, projectId, { title: 'T' }).id;
		createRun(db, user, { ticketId, profileId: alpha });
		createRun(db, user, { ticketId, profileId: zeta });
		const otherProject = board.createProject(db, user, { key: 'WEB', name: 'Website' }).id;
		const otherTicket = board.createTicket(db, user, otherProject, { title: 'W' }).id;
		createRun(db, user, { ticketId: otherTicket, profileId: alpha });
		expect(runStart(db, projectId).preselected).toBe(zeta);
		expect(runStart(db, otherProject).preselected).toBe(alpha);
	});
});
