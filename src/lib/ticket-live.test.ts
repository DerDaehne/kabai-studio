// Drives real domain mutations through the real event bus (not a fake event shape) so the predicate is checked
// against exactly what the Run-Akte's live listener receives — the gap the review found: the page's own effect was
// otherwise the only thing reading `event.ticketId`, and nothing failed when that check was disabled.
import { expect, it } from 'vitest';
import * as board from './server/domain/board';
import type { Actor } from './server/domain/core';
import { migrate, openDb } from './server/db';
import { subscribe, type StudioEvent } from './server/events';
import * as runs from './server/domain/runs';
import { concernsTicket } from './ticket-live';

const user: Actor = { kind: 'user' };

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const a = board.createTicket(db, user, projectId, { title: 'A' }).id;
	const b = board.createTicket(db, user, projectId, { title: 'B' }).id;
	const profileId = runs.createProfile(db, user, {
		name: 'Test',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const agent: Actor = {
		kind: 'agent',
		runId: runs.createRun(db, user, { ticketId: a, profileId }).id
	};
	const refineId = db
		.prepare("SELECT id FROM columns WHERE project_id = ? AND name = 'Refine'")
		.get(projectId)!.id as number;
	return { db, a, b, agent, refineId };
}

it('matches a comment, a task added, a task completed and a move of this ticket, not a comment on another one', () => {
	const { db, a, b, agent, refineId } = setup();
	const events: StudioEvent[] = [];
	const off = subscribe((e) => events.push(e));

	board.addComment(db, agent, a, 'Status: läuft.');
	const taskId = board.addTask(db, user, a, 'Kriterium').id;
	board.completeTask(db, user, taskId);
	board.moveTicket(db, user, a, refineId);
	board.addComment(db, user, b, 'Anderes Ticket');
	off();

	const [commentA, taskAdded, taskCompleted, moved, commentB] = events;
	for (const own of [commentA, taskAdded, taskCompleted, moved])
		expect(concernsTicket(own, a)).toBe(true);
	expect(concernsTicket(commentB, a)).toBe(false);
	expect(concernsTicket(commentA, b)).toBe(false);
});
