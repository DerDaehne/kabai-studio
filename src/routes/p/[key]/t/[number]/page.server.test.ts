import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import { findTicketId, type TicketDetail } from '$lib/server/ticket-view';
import { actions, load } from './+page.server';

// A real (file-backed) STUDIO_DATA_DIR, like the secrets route test: db() is a process-wide singleton.
const dir = mkdtempSync(join(tmpdir(), 'studio-ticket-route-'));
process.env.STUDIO_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const user: Actor = { kind: 'user' };
const projectId = board.createProject(db(), user, { key: 'STU', name: 'Studio' }).id;
const params = (number: number) => ({ key: 'STU', number: String(number) });
const noop = () => {};

function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		return err;
	}
	throw new Error('expected a throw');
}

async function post(
	action: keyof typeof actions,
	ticketNumber: number,
	fields: Record<string, string>
) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const request = new Request('http://localhost/p/STU/t/1', { method: 'POST', body });
	return actions[action]({ request, params: params(ticketNumber) } as never);
}

// `load`'s declared return type is the generic page-data shape $types.d.ts infers; this names the real one back.
async function loadTicket(number: number): Promise<{ ticket: TicketDetail }> {
	return load({ params: params(number), depends: noop } as never) as never;
}

describe('load', () => {
	it('404s with a message naming the missing ticket, so +error.svelte has something to show', () => {
		const err = thrown(() => load({ params: params(999), depends: noop } as never));
		expect(err).toMatchObject({
			status: 404,
			body: { message: expect.stringContaining('STU-999') }
		});
	});

	it('loads ref, title and column for an existing ticket', async () => {
		const { number } = board.createTicket(db(), user, projectId, { title: 'Erstes Ticket' });
		const data = await loadTicket(number);
		expect(data.ticket.ref).toBe(`STU-${number}`);
		expect(data.ticket.title).toBe('Erstes Ticket');
		expect(data.ticket.column.name).toBe('Backlog');
	});
});

describe('actions', () => {
	it('update sets title and description, and refuses a blank title with message and hint', async () => {
		const { number, id } = board.createTicket(db(), user, projectId, { title: 'T' });
		expect(
			await post('update', number, { title: 'Neuer Titel', description: 'Text' })
		).toBeUndefined();
		expect(board.ticket(db(), id)).toMatchObject({ id });
		const after = await loadTicket(number);
		expect(after.ticket.title).toBe('Neuer Titel');
		expect(after.ticket.description).toBe('Text');

		const fail = await post('update', number, { title: '  ', description: 'Text' });
		expect(fail).toMatchObject({
			status: 400,
			data: {
				code: 'empty_title',
				hint: 'Gib einen Titel an, der sagt, worum es im Ticket geht.'
			}
		});
	});

	it('addTask creates an open task, a blank title fails', async () => {
		const { number } = board.createTicket(db(), user, projectId, { title: 'T' });
		await post('addTask', number, { title: 'Erstes Kriterium' });
		const after = await loadTicket(number);
		expect(after.ticket.tasks).toEqual([
			{ id: expect.any(Number), title: 'Erstes Kriterium', done: false }
		]);

		expect(await post('addTask', number, { title: '' })).toMatchObject({
			status: 400,
			data: {
				code: 'empty_title',
				hint: expect.stringContaining('Titel')
			}
		});
	});

	it('completeTask and reopenTask flip the done flag', async () => {
		const { number, id } = board.createTicket(db(), user, projectId, { title: 'T' });
		const taskId = board.addTask(db(), user, id, 'A').id;
		await post('completeTask', number, { taskId: String(taskId) });
		expect((await loadTicket(number)).ticket.tasks[0].done).toBe(true);
		await post('reopenTask', number, { taskId: String(taskId) });
		expect((await loadTicket(number)).ticket.tasks[0].done).toBe(false);
	});

	it('renameTask and deleteTask require a reason, which lands as a system comment', async () => {
		const { number, id } = board.createTicket(db(), user, projectId, { title: 'T' });
		const taskId = board.addTask(db(), user, id, 'Alt').id;

		const reasonHint = 'Gib `reason` an — sie landet als System-Kommentar am Ticket.';
		expect(
			await post('renameTask', number, { taskId: String(taskId), title: 'Neu' })
		).toMatchObject({
			status: 400,
			data: { code: 'reason_required', hint: reasonHint }
		});
		await post('renameTask', number, {
			taskId: String(taskId),
			title: 'Neu',
			reason: 'Tippfehler'
		});
		let after = await loadTicket(number);
		expect(after.ticket.tasks[0].title).toBe('Neu');
		expect(after.ticket.comments.at(-1)).toMatchObject({ authorKind: 'system' });

		expect(await post('deleteTask', number, { taskId: String(taskId) })).toMatchObject({
			status: 400,
			data: { code: 'reason_required', hint: reasonHint }
		});
		await post('deleteTask', number, { taskId: String(taskId), reason: 'überholt' });
		after = await loadTicket(number);
		expect(after.ticket.tasks).toEqual([]);
	});

	it('addComment appends a comment to the history', async () => {
		const { number } = board.createTicket(db(), user, projectId, { title: 'T' });
		await post('addComment', number, { body: 'Status: läuft.' });
		const after = await loadTicket(number);
		expect(after.ticket.comments.at(-1)).toMatchObject({
			authorKind: 'user',
			body: 'Status: läuft.'
		});
	});

	it('move only accepts an allowedMoves target, with the blocker reported on a refused move', async () => {
		const { number, id } = board.createTicket(db(), user, projectId, { title: 'T' });
		const refine = findColumn(id, 'Refine'); // adjacent to Backlog, so an allowed move
		await post('move', number, { columnId: String(refine) });
		expect((await loadTicket(number)).ticket.column.name).toBe('Refine');

		const abnahme = findColumn(id, 'Abnahme'); // not adjacent to Refine, so not an allowed move
		const fail = await post('move', number, { columnId: String(abnahme) });
		expect(fail).toMatchObject({ status: 400, data: { code: 'transition_not_allowed' } });
	});

	it('delete removes the ticket and redirects to the board', async () => {
		const { number, id } = board.createTicket(db(), user, projectId, { title: 'Weg damit' });
		await expect(actions.delete({ params: params(number) } as never)).rejects.toMatchObject({
			status: 303,
			location: '/board'
		});
		expect(() => board.ticket(db(), id)).toThrow('gibt es nicht');
	});
});

function findColumn(ticketId: number, name: string): number {
	const t = board.ticket(db(), ticketId);
	return db()
		.prepare('SELECT id FROM columns WHERE project_id = ? AND name = ?')
		.get(t.project_id, name)!.id as number;
}
