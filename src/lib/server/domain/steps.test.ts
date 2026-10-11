import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import * as board from './board';
import type { Actor } from './core';
import * as runs from './runs';
import { finishStep } from './steps';

const user: Actor = { kind: 'user' };

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
