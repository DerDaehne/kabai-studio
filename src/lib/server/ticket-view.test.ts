import { afterEach, describe, expect, it } from 'vitest';
import * as board from './domain/board';
import { DomainError, type Actor } from './domain/core';
import { answerQuestion, requestHuman } from './domain/questions';
import { appendEvent, createProfile, createRun, finishRun, startRun } from './domain/runs';
import { migrate, openDb } from './db';
import { startRunner } from './runner';
import { findTicketId, runTrace, ticketDetail } from './ticket-view';

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
