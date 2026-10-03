import { describe, expect, it } from 'vitest';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import { answerQuestion, requestHuman } from './domain/questions';
import { createProfile, createRun } from './domain/runs';
import { migrate, openDb } from './db';
import { findTicketId, ticketDetail } from './ticket-view';

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
		expect(moves.map((m) => [m.name, m.position])).toEqual([
			['Review', 4],
			['Done', 6],
			['Human Intervention', 7]
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
