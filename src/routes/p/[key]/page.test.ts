import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'svelte/server';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import { actions, load, type ProjectPage } from './+page.server';
import Page from './+page.svelte';

const dir = mkdtempSync(join(tmpdir(), 'studio-project-route-'));
process.env.STUDIO_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

board.createProject(db(), { kind: 'user' }, { key: 'STU', name: 'Studio' });

const loaded = (key: string) => load({ params: { key } } as never) as ProjectPage;

async function createTicket(title: string) {
	const body = new FormData();
	body.set('title', title);
	const request = new Request('http://localhost/p/STU', { method: 'POST', body });
	try {
		return await actions.createTicket({ request, params: { key: 'STU' } } as never);
	} catch (thrown) {
		return thrown; // a redirect
	}
}

const html = (data: ProjectPage, form: unknown = null) =>
	render(Page as never, { props: { data, form } as never }).body.replace(/<!--[\s\S]*?-->/g, '');
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the project page', () => {
	it('loads name, key and the columns in board order with their role prompts', () => {
		const { project, columns } = loaded('STU');
		expect(project).toMatchObject({ code: 'STU', name: 'Studio' });
		expect(columns.map((column) => column.name)).toEqual([
			'Backlog',
			'Refine',
			'Ready',
			'In Arbeit',
			'Review',
			'Abnahme',
			'Done',
			'Human Intervention',
			'Human Answered'
		]);
		expect(columns[0].role).toMatch(/^Do: sort new work in/);
	});

	it('404s with a message for a key no project has', () => {
		expect(() => loaded('NOPE')).toThrow(
			expect.objectContaining({
				status: 404,
				body: { message: 'Ein Projekt NOPE gibt es nicht.' }
			})
		);
	});

	it('shows name, key, each column with its role, and a way to the first ticket', () => {
		const markup = html(loaded('STU'));
		expect(markup).toMatch(/<h1[^>]*>.*Studio<\/h1>/s);
		expect(text(markup)).toContain('STU');
		expect(text(markup)).toContain('Backlog Do: sort new work in');
		expect(markup).toMatch(/<label [^>]*>Titel<\/label>/);
		expect(markup).toMatch(/<button [^>]*type="submit"[^>]*>\s*Ticket anlegen<\/button>/);
		expect(markup).toMatch(/<a [^>]*href="\/projects"/);
	});
});

describe('creating a ticket from the project page', () => {
	it('creates it in the first column and opens its Run-Akte', async () => {
		expect(await createTicket('Erstes Ticket')).toMatchObject({
			status: 303,
			location: '/p/STU/t/1'
		});
		const id = db().prepare("SELECT id FROM tickets WHERE title = 'Erstes Ticket'").get()!
			.id as number;
		expect(board.ticket(db(), id).column_name).toBe('Backlog');
	});

	it('refuses a blank title with the message and way out of the domain', async () => {
		expect(await createTicket('  ')).toMatchObject({
			status: 400,
			data: { message: expect.stringContaining('Ausweg: Gib einen Titel an') }
		});
	});
});
