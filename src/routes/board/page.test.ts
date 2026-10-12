import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'svelte/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LIVE_DEPENDENCY, type LiveRun, type LiveState } from '$lib/live';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import * as runs from '$lib/server/domain/runs';
import { requestHuman } from '$lib/server/domain/questions';
import { actions, load, type BoardPage } from './+page.server';
import { BOARD_DEPENDENCY, FLOW_COOKIE } from './list';
import Page from './+page.svelte';

const pageData = vi.hoisted(() => ({ locale: 'de' }));
vi.mock('$app/state', () => ({ page: { data: pageData } }));

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
const tasks = create(studio, 'Tasks halb erledigt', 'Planen');
board.linkRelation(db(), user, epic.id, tasks.id, 'parent_of');
board.completeTask(db(), user, board.addTask(db(), user, tasks.id, 'Eins').id);
board.addTask(db(), user, tasks.id, 'Zwei');
const accepted = create(studio, 'Wartet auf Abnahme', 'Abnahme');
board.addTask(db(), user, accepted.id, 'Noch offen');
const shopTicket = create(shop, 'Warenkorb', 'Planen');
create(archive, 'Archiviert');
db().prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(archive);
const newestRunProfile = runs.createProfile(db(), user, {
	name: 'newest-run',
	executor: 'builtin',
	provider: 'openai-compatible',
	model: 'm'
}).id;
const queuedRun = (title: string) => {
	const ticket = create(shop, title, 'Umsetzen');
	runs.createRun(db(), user, { ticketId: ticket.id, profileId: newestRunProfile });
	return ticket;
};

async function loaded(cookie?: string) {
	const dependencies: string[] = [];
	const data = (await load({
		depends: (...d: string[]) => dependencies.push(...d),
		cookies: { get: (name: string) => (name === FLOW_COOKIE ? cookie : undefined) }
	} as never)) as BoardPage;
	return { data, dependencies };
}
const loadedTicket = async (id: number) =>
	(await loaded()).data.tickets.find((ticket) => ticket.id === id)!;

async function post(action: keyof typeof actions, fields: Record<string, string | number>) {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, String(value));
	const request = new Request('http://localhost/board', { method: 'POST', body });
	return (await actions[action]({ request, locals: { locale: 'de' } } as never)) as Record<
		string,
		unknown
	>;
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
		props: { data: { tickets: [], columns: [], flow: false, ...data } } as never
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
			column: { id: columnId(studio, 'Planen'), name: 'Planen', phase: 'work' },
			tasks: { done: 1, total: 2 },
			epic: 'STU-1'
		});
		expect((await loadedTicket(shopTicket.id)).epic).toBeNull();
	});

	it('opens the expert view only when the browser chose it', async () => {
		expect((await loaded()).data.flow).toBe(false);
		expect((await loaded('lage')).data.flow).toBe(false);
		expect((await loaded('flow')).data.flow).toBe(true);
	});

	it('lists every column of every active project once, in step order, with its project and step', async () => {
		const { data } = await loaded();
		const studioColumns = data.columns.filter((column) => column.projectId === studio);
		expect(studioColumns.map((column) => column.step)).toEqual([
			'backlog',
			'refine',
			'plan',
			'implement',
			'critique',
			'acceptance',
			'done'
		]);
		expect(studioColumns[3]).toMatchObject({ name: 'Umsetzen', phase: 'work', position: 3 });
		expect(data.columns.some((column) => column.projectId === archive)).toBe(false);
	});

	it('gives each ticket the state and profile of its newest run', async () => {
		const bare = create(shop, 'Ohne Run', 'Umsetzen');
		expect((await loadedTicket(bare.id)).run).toBeNull();
		const ticket = queuedRun('Mit Run');
		expect((await loadedTicket(ticket.id)).run).toEqual({ state: 'queued', profile: 'newest-run' });
	});

	it('reads the board in the same few statements however many tickets, runs and questions there are', async () => {
		const statements = async () => {
			const database = db();
			const prepare = database.prepare.bind(database);
			let count = 0;
			database.prepare = ((sql: string) => (count++, prepare(sql))) as typeof database.prepare;
			try {
				await loaded();
			} finally {
				database.prepare = prepare;
			}
			return count;
		};
		const profile = runs.createProfile(db(), user, {
			name: 'many',
			executor: 'builtin',
			provider: 'openai-compatible',
			model: 'm'
		}).id;
		const queued = (title: string) => {
			const ticket = create(studio, title, 'Umsetzen');
			const run = runs.createRun(db(), user, { ticketId: ticket.id, profileId: profile }).id;
			return { ticket, run };
		};
		queued('Einer wartet');
		const few = await statements();
		for (let i = 0; i < 20; i++) {
			const { ticket, run } = queued(`Viele ${i}`);
			board.addTask(db(), user, ticket.id, 'Offen');
			runs.startRun(db(), user, run);
			requestHuman(db(), { kind: 'agent', runId: run }, ticket.id, { question: 'Weiter?' });
		}
		expect(await statements()).toBe(few);
		expect(few).toBeLessThanOrEqual(4);
	});
});

describe('the Lage on the board load', () => {
	it('gives each ticket lage, reason, step and progress', async () => {
		expect(await loadedTicket(tasks.id)).toMatchObject({
			lage: 'open',
			reason: { kind: 'ready' },
			step: 'plan',
			progress: { index: 2, total: 5 }
		});
		expect(await loadedTicket(accepted.id)).toMatchObject({
			lage: 'acceptance',
			step: 'acceptance'
		});
	});

	it('follows a new question, a run change and a move on the next load, which every live event triggers', async () => {
		const ticket = create(studio, 'Lage live', 'Umsetzen');
		const { dependencies } = await loaded();
		expect(dependencies).toContain(LIVE_DEPENDENCY);
		expect(dependencies).toContain(BOARD_DEPENDENCY);

		const profile = runs.createProfile(db(), user, {
			name: 'lage-live',
			executor: 'builtin',
			provider: 'openai-compatible',
			model: 'm'
		}).id;
		const run = runs.createRun(db(), user, { ticketId: ticket.id, profileId: profile }).id;
		expect((await loadedTicket(ticket.id)).reason.kind).toBe('capacity');
		runs.startRun(db(), user, run);
		expect((await loadedTicket(ticket.id)).lage).toBe('working');

		requestHuman(db(), { kind: 'agent', runId: run }, ticket.id, { question: 'Weiter?' });
		expect(await loadedTicket(ticket.id)).toMatchObject({
			lage: 'waiting',
			reason: { kind: 'question' }
		});

		await post('move', { ticketId: ticket.id, columnId: columnId(studio, 'Abnahme') });
		const moved = await loadedTicket(ticket.id);
		expect(moved).toMatchObject({ step: 'acceptance', reason: { kind: 'question' } });
	});
});

describe('the board actions', () => {
	it('moves a ticket to an allowed column for the human', async () => {
		const ticket = create(studio, 'Verschieben');
		expect(
			await post('move', { ticketId: ticket.id, columnId: columnId(studio, 'Präzisieren') })
		).toEqual({});
		expect(board.ticket(db(), ticket.id)).toMatchObject({
			column_name: 'Präzisieren',
			moved_by: '{"kind":"user"}'
		});
	});

	it('refuses a move the workflow does not allow, with the reason and the way out', async () => {
		const ticket = create(studio, 'Gesperrt', 'Abnahme');
		board.addTask(db(), user, ticket.id, 'Offen');
		const refused = await post('move', {
			ticketId: ticket.id,
			columnId: columnId(studio, 'Fertig')
		});
		expect(refused).toMatchObject({ status: 409 });
		const { message } = refused.data as { message: string };
		expect(message).toMatch(/offen.*\. .+/i);
		expect(message).toContain('Hake die offenen Tasks ab oder lösche sie.');
		expect(message).not.toContain('completeTask');
		expect(board.ticket(db(), ticket.id).column_name).toBe('Abnahme');
	});

	it('creates a ticket in the current project and column and names it', async () => {
		const result = await post('create', {
			projectId: shop,
			columnId: columnId(shop, 'Planen'),
			title: 'Schnell angelegt'
		});
		const created = db()
			.prepare(
				"SELECT number, column_id FROM tickets WHERE project_id = ? AND title = 'Schnell angelegt'"
			)
			.get(shop) as { number: number; column_id: number };
		expect(result).toEqual({ ref: `SHO-${created.number}` });
		expect(created.column_id).toBe(columnId(shop, 'Planen'));
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
	const headings = (markup: string) =>
		[...markup.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((match) =>
			text(match[1]).trim().replace(/ \d+$/, '')
		);
	const COLUMN_NAMES = ['Backlog', 'Präzisieren', 'Planen', 'Umsetzen', 'Kritik'];

	it('shows the five Lagen in fixed order, what waits for the human first, and no column name', async () => {
		const { data } = await loaded();
		const markup = html({ ...data, live: live() });
		expect(headings(markup)).toEqual([
			'Wartet auf dich',
			'In Arbeit',
			'Offen',
			'Zur Abnahme',
			'Fertig'
		]);
		for (const name of COLUMN_NAMES) expect(text(markup)).not.toContain(name);
	});

	it('shows each ticket with project code and number, title, its progress track and where it stands in everyday words', async () => {
		const { data } = await loaded();
		const markup = html({ ...data, live: live() });
		expect(markup).toMatch(/<a [^>]*href="\/p\/STU\/t\/2"[^>]*>Tasks halb erledigt<\/a>/);
		expect(text(markup)).toMatch(
			/STU STU-2 Tasks halb erledigt Vorgehen festlegen Bereit zum Start/
		);
		const track =
			markup.match(
				/aria-label="Schritt 2 von 5"[^>]*>([\s\S]*?)<\/span>\s*<span class="step/
			)?.[1] ?? '';
		expect(track.match(/class="dot/g)).toHaveLength(5);
		expect(track.match(/filled/g)).toHaveLength(2);
	});

	it('names the kind of what waits for the human and says a step works right now', async () => {
		const { data } = await loaded();
		const base = data.tickets[0];
		const asking = { ...base, lage: 'waiting' as const, reason: { kind: 'question' as const } };
		const checked = {
			...base,
			id: base.id + 1000,
			lage: 'working' as const,
			reason: { kind: 'working' as const },
			step: 'critique',
			column: { ...base.column, phase: 'work' as const }
		};
		const markup = text(html({ tickets: [asking, checked], live: live() }));
		expect(markup).toMatch(/Wartet auf dich 1 .*Offene Frage .*In Arbeit 1 .*wird gerade geprüft/);
	});

	it('translates the capacity reason into the page locale', async () => {
		const { data } = await loaded();
		const queued = {
			...data.tickets[0],
			lage: 'open' as const,
			reason: {
				kind: 'capacity' as const,
				causes: [
					{ code: 'pool_full' as const, pool: 'local', active: 1, limit: 1 },
					{ code: 'ahead' as const, count: 2 }
				]
			}
		};
		const markup = html({ tickets: [queued], live: live() });
		expect(text(markup)).toContain('Pool „local“ ist voll (1 von 1 aktiv), 2 vor ihm in der Queue');
		pageData.locale = 'en';
		try {
			const english = html({ tickets: [queued], live: live() });
			expect(text(english)).toContain('Pool "local" is full (1 of 1 active), 2 ahead in the queue');
			expect(headings(english)).toEqual([
				'Waiting for you',
				'In progress',
				'Open',
				'For acceptance',
				'Done'
			]);
		} finally {
			pageData.locale = 'de';
		}
	});

	it('shows the expert view with the columns, the Lage, the newest run with its profile, task progress and epic', async () => {
		queuedRun('Mit Run');
		const { data } = await loaded();
		const markup = html({ ...data, flow: true, live: live() });
		expect(headings(markup)).toEqual([
			'Backlog',
			'Präzisieren',
			'Planen',
			'Umsetzen',
			'Kritik',
			'Abnahme',
			'Fertig'
		]);
		expect(text(markup)).toMatch(
			/STU-2 Tasks halb erledigt Offen · Bereit zum Start 1\/2 Tasks erledigt Epic STU-1/
		);
		expect(text(markup)).toMatch(/Mit Run Offen · .* in der Queue · newest-run/);
	});

	it('shows "Noch kein Ticket" with the hint on o while a project has no tickets', () => {
		const markup = text(html({ tickets: [], live: live() }));
		expect(markup).toContain('Noch kein Ticket');
		expect(markup).toMatch(/ o .*legt/);
		expect(markup).not.toContain('Noch kein Projekt');
	});
});
