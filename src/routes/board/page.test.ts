import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'svelte/server';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import { LIVE_DEPENDENCY, type LiveRun, type LiveState } from '$lib/shell/live.svelte';
import { actions, load, type BoardPage } from './+page.server';
import { BOARD_DEPENDENCY } from './list';
import Page from './+page.svelte';

const dir = mkdtempSync(join(tmpdir(), 'studio-board-route-'));
process.env.STUDIO_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const user: Actor = { kind: 'user' };
const studio = board.createProject(db(), user, { key: 'STU', name: 'Studio' }).id;
const shop = board.createProject(db(), user, { key: 'SHO', name: 'Shop' }).id;
const archive = board.createProject(db(), user, { key: 'OLD', name: 'Altlast' }).id;

const columnId = (projectId: number, name: string) =>
	db().prepare('SELECT id FROM columns WHERE project_id = ? AND name = ?').get(projectId, name)!
		.id as number;
const create = (projectId: number, title: string, column?: string) =>
	board.createTicket(db(), user, projectId, {
		title,
		column_id: column ? columnId(projectId, column) : undefined
	});

const epic = board.createTicket(db(), user, studio, { title: 'Release 1', type: 'epic' });
const tasks = create(studio, 'Tasks halb erledigt', 'Ready');
board.linkRelation(db(), user, epic.id, tasks.id, 'parent_of');
board.completeTask(db(), user, board.addTask(db(), user, tasks.id, 'Eins').id);
board.addTask(db(), user, tasks.id, 'Zwei');
const accepted = create(studio, 'Wartet auf Abnahme', 'Abnahme');
board.addTask(db(), user, accepted.id, 'Noch offen');
const shopTicket = create(shop, 'Warenkorb', 'Ready');
create(archive, 'Archiviert');
db().prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(archive);

async function loaded() {
	const dependencies: string[] = [];
	const data = (await load({
		depends: (...d: string[]) => dependencies.push(...d)
	} as never)) as BoardPage;
	return { data, dependencies };
}
const loadedTicket = async (id: number) =>
	(await loaded()).data.tickets.find((ticket) => ticket.id === id)!;

async function post(action: keyof typeof actions, fields: Record<string, string | number>) {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, String(value));
	const request = new Request('http://localhost/board', { method: 'POST', body });
	return (await actions[action]({ request } as never)) as Record<string, unknown>;
}

const live = (
	runs: LiveRun[] = [],
	projects = [{ id: studio, code: 'STU', name: 'Studio', palette: 1 as const }]
): LiveState => ({
	projects,
	runs,
	openQuestions: 0,
	halt: null,
	activeRuns: 0
});
const html = (data: Partial<BoardPage> & { live: LiveState }) =>
	render(Page as never, {
		props: { data: { tickets: [], roles: {}, ...data } } as never
	}).body.replace(/<!--[\s\S]*?-->/g, '');
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the board load', () => {
	it('lists the tickets of every active project and reloads with the live state and every board change', async () => {
		const { data, dependencies } = await loaded();
		const refs = data.tickets.map((ticket) => ticket.ref);
		expect(refs).toEqual(expect.arrayContaining(['STU-1', 'STU-2', 'STU-3', 'SHO-1']));
		expect(refs).not.toContain('OLD-1');
		expect(dependencies).toEqual(expect.arrayContaining([LIVE_DEPENDENCY, BOARD_DEPENDENCY]));
	});

	it('gives each ticket its project, column, task progress and epic', async () => {
		expect(await loadedTicket(tasks.id)).toMatchObject({
			ref: 'STU-2',
			number: 2,
			title: 'Tasks halb erledigt',
			project: { id: studio, code: 'STU', name: 'Studio' },
			column: { id: columnId(studio, 'Ready'), name: 'Ready', kind: 'normal' },
			tasks: { done: 1, total: 2 },
			epic: 'STU-1'
		});
		expect((await loadedTicket(shopTicket.id)).epic).toBeNull();
	});

	it('names the role prompt of every column', async () => {
		const { data } = await loaded();
		expect(data.roles[columnId(studio, 'Backlog')]).toMatch(/^Do: sort new work in/);
		expect(data.roles[columnId(shop, 'Done')]).toBe('');
	});

	it('names the column > and < lead to, and why a blocked one is closed, with the way out', async () => {
		const { next } = await loadedTicket(tasks.id);
		expect(next.forward).toMatchObject({
			columnId: columnId(studio, 'In Arbeit'),
			name: 'In Arbeit',
			blockers: []
		});
		expect(next.back).toMatchObject({ columnId: columnId(studio, 'Refine'), name: 'Refine' });

		const done = (await loadedTicket(accepted.id)).next.forward!;
		expect(done.name).toBe('Done');
		expect(done.blockers[0]).toMatchObject({ code: 'open_tasks' });
		expect(done.blockers[0].message).toContain('STU-3');
		expect(done.blockers[0].hint).not.toBe('');
	});
});

describe('the board actions', () => {
	it('moves a ticket to an allowed column for the human', async () => {
		const ticket = create(studio, 'Verschieben');
		expect(
			await post('move', { ticketId: ticket.id, columnId: columnId(studio, 'Refine') })
		).toEqual({});
		expect(board.ticket(db(), ticket.id)).toMatchObject({
			column_name: 'Refine',
			moved_by: '{"kind":"user"}'
		});
	});

	it('refuses a move the workflow does not allow, with the reason and the way out', async () => {
		const ticket = create(studio, 'Gesperrt', 'Abnahme');
		board.addTask(db(), user, ticket.id, 'Offen');
		const refused = await post('move', { ticketId: ticket.id, columnId: columnId(studio, 'Done') });
		expect(refused).toMatchObject({ status: 409 });
		expect((refused.data as { message: string }).message).toMatch(/offen.*\. .+/i);
		expect(board.ticket(db(), ticket.id).column_name).toBe('Abnahme');
	});

	it('creates a ticket in the current project and column and names it', async () => {
		const result = await post('create', {
			projectId: shop,
			columnId: columnId(shop, 'Ready'),
			title: 'Schnell angelegt'
		});
		const created = db()
			.prepare(
				"SELECT number, column_id FROM tickets WHERE project_id = ? AND title = 'Schnell angelegt'"
			)
			.get(shop) as { number: number; column_id: number };
		expect(result).toEqual({ ref: `SHO-${created.number}` });
		expect(created.column_id).toBe(columnId(shop, 'Ready'));
	});

	it('creates a ticket in the first column when no column is given', async () => {
		await post('create', { projectId: shop, title: 'Ohne Spalte' });
		const created = db()
			.prepare("SELECT column_id FROM tickets WHERE title = 'Ohne Spalte'")
			.get() as { column_id: number };
		expect(created.column_id).toBe(columnId(shop, 'Backlog'));
	});

	it('refuses a ticket without a title, with the way out', async () => {
		const refused = await post('create', { projectId: shop, title: '  ' });
		expect(refused).toMatchObject({ status: 409 });
		expect((refused.data as { message: string }).message).toBe(
			'Ein Ticket braucht einen Titel. Gib einen Titel an, der sagt, worum es im Ticket geht.'
		);
	});

	it('renames a ticket', async () => {
		const ticket = create(studio, 'Alter Titel');
		expect(await post('rename', { ticketId: ticket.id, title: 'Neuer Titel' })).toEqual({});
		expect((await loadedTicket(ticket.id)).title).toBe('Neuer Titel');
	});

	it('deletes a ticket', async () => {
		const ticket = create(studio, 'Weg damit');
		expect(await post('delete', { ticketId: ticket.id })).toEqual({});
		expect(await loadedTicket(ticket.id)).toBeUndefined();
	});

	it('reports a ticket that is gone as not found', async () => {
		expect(await post('delete', { ticketId: 999_999 })).toMatchObject({ status: 404 });
	});
});

describe('the board view', () => {
	it('shows a group per column with its name, how a run starts there and its role', async () => {
		const { data } = await loaded();
		const markup = text(html({ ...data, live: live() }));
		expect(markup).toMatch(/Ready \d+ Start per :run · Do: pick the ticket up; do not refine it/);
		expect(markup).toMatch(/Abnahme \d+ Start per :run · Do: nothing; finished work waits here/);
	});

	it('shows each ticket with project code and number, title, task progress, epic and project', async () => {
		const { data } = await loaded();
		const markup = html({ ...data, live: live() });
		expect(markup).toMatch(/<a [^>]*href="\/p\/STU\/t\/2"[^>]*>Tasks halb erledigt<\/a>/);
		expect(text(markup)).toMatch(
			/STU STU-2 Tasks halb erledigt .*1\/2 Tasks erledigt Epic STU-1 Studio/
		);
	});

	it('shows the run of a ticket with its state and agent', async () => {
		const { data } = await loaded();
		const run: LiveRun = {
			id: 7,
			profile: 'qwen',
			location: 'lokal',
			project: { id: studio, code: 'STU', name: 'Studio', palette: 1 },
			ticket: 'STU-2',
			state: 'running'
		};
		expect(text(html({ ...data, live: live([run]) }))).toContain(
			'Tasks halb erledigt arbeitet · qwen (lokal)'
		);
	});

	it('shows "Noch kein Ticket" with the hint on o while a project has no tickets', () => {
		const markup = text(html({ tickets: [], live: live() }));
		expect(markup).toContain('Noch kein Ticket');
		expect(markup).toMatch(/ o .*legt/);
		expect(markup).not.toContain('Noch kein Projekt');
	});
});
