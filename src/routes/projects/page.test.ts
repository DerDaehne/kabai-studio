import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'svelte/server';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import { requestHuman } from '$lib/server/domain/questions';
import { subscribe, type StudioEvent } from '$lib/server/events';
import { LIVE_DEPENDENCY } from '$lib/shell/live.svelte';
import { actions, load, type ProjectRow } from './+page.server';
import Page from './+page.svelte';

const dir = mkdtempSync(join(tmpdir(), 'studio-projects-route-'));
process.env.STUDIO_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const user: Actor = { kind: 'user' };
const studio = board.createProject(db(), user, { key: 'STU', name: 'Studio' }).id;

async function loaded() {
	const dependencies: string[] = [];
	const data = (await load({ depends: (d: string) => dependencies.push(d) } as never)) as {
		projects: ProjectRow[];
	};
	return { data, dependencies };
}

async function create(fields: { name: string; key: string }) {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, value);
	const request = new Request('http://localhost/projects', { method: 'POST', body });
	try {
		return await actions.create({ request } as never);
	} catch (thrown) {
		return thrown; // a redirect
	}
}

const columnsOf = (key: string) =>
	db()
		.prepare(
			'SELECT c.name FROM columns c JOIN projects p ON p.id = c.project_id WHERE p.key = ? ORDER BY c.position'
		)
		.all(key)
		.map((row) => row.name);

const html = (data: { projects: ProjectRow[] }, form: unknown = null) =>
	render(Page as never, { props: { data, form } as never }).body.replace(/<!--[\s\S]*?-->/g, '');
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const inputNamed = (markup: string, name: string) =>
	markup.match(new RegExp(`<input [^>]*name="${name}"[^>]*>`))?.[0] ?? '';

describe('the project list', () => {
	it('lists every project with key, name, column count and open questions, archived ones marked', async () => {
		const ticketId = board.createTicket(db(), user, studio, { title: 'Frage' }).id;
		requestHuman(db(), user, ticketId, { question: 'Welcher Port?' });
		const old = board.createProject(db(), user, { key: 'ALT', name: 'Altlast' }).id;
		db().prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(old);

		const { data, dependencies } = await loaded();
		expect(data.projects).toEqual([
			expect.objectContaining({
				code: 'ALT',
				name: 'Altlast',
				columns: 9,
				openQuestions: 0,
				archived: true
			}),
			expect.objectContaining({
				code: 'STU',
				name: 'Studio',
				columns: 9,
				openQuestions: 1,
				archived: false
			})
		]);
		expect(dependencies).toContain(LIVE_DEPENDENCY);
	});

	it('shows each project as a link into it, with its counts', async () => {
		const markup = html((await loaded()).data);
		expect(markup).toMatch(/<a [^>]*href="\/p\/STU"[^>]*>Studio<\/a>/);
		expect(text(markup)).toContain('9 Spalten · 1 offene Frage');
		expect(text(markup)).toContain('archiviert');
	});
});

describe('creating a project', () => {
	it('creates it through the domain layer as the user, with the Software template', async () => {
		const events: StudioEvent[] = [];
		const off = subscribe((event) => events.push(event));
		await create({ name: 'Kundenportal', key: 'CRM' });
		off();

		expect(events).toEqual([expect.objectContaining({ type: 'project.created', actor: user })]);
		expect(columnsOf('CRM')).toEqual(columnsOf('STU'));
		expect(columnsOf('CRM')).toEqual([
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
	});

	it('leads straight into the new project, not to a page in between', async () => {
		expect(await create({ name: 'Webshop', key: 'SHOP' })).toMatchObject({
			status: 303,
			location: '/p/SHOP'
		});
	});

	it('takes the key in capitals and without surrounding spaces, however it was typed', async () => {
		expect(await create({ name: ' Blog ', key: ' blog ' })).toMatchObject({
			location: '/p/BLOG'
		});
		expect(db().prepare("SELECT name FROM projects WHERE key = 'BLOG'").get()?.name).toBe('Blog');
	});

	it('refuses a taken key at the key field with a plain message and way out, keeping what was typed', async () => {
		const result = await create({ name: 'Zweites Studio', key: 'stu' });
		expect(result).toMatchObject({
			status: 400,
			data: { field: 'key', name: 'Zweites Studio', key: 'STU' }
		});
		const { message } = (result as { data: { message: string } }).data;
		expect(message).toBe(
			'Den Key „STU“ hat schon das Projekt „Studio“. Ausweg: Wähle einen anderen Key, z. B. STU2, oder arbeite im Projekt „Studio“ weiter.'
		);
	});

	it('refuses a taken name at the name field', async () => {
		expect(await create({ name: 'STUDIO', key: 'NEU' })).toMatchObject({
			status: 400,
			data: { field: 'name', message: expect.stringContaining('Ausweg: Wähle einen anderen Namen') }
		});
	});

	it('shows the error at the field it concerns and keeps the typed values in the form', async () => {
		const form = { field: 'key', message: 'Den Key „STU“ hat schon …', name: 'Neu', key: 'STU' };
		const markup = html((await loaded()).data, form);
		expect(inputNamed(markup, 'key')).toContain('aria-invalid="true"');
		expect(inputNamed(markup, 'name')).not.toContain('aria-invalid');
		expect(inputNamed(markup, 'name')).toContain('value="Neu"');
		expect(text(markup)).toContain('Den Key „STU“ hat schon …');
	});

	it('offers the form with labelled fields even before the first project exists', () => {
		const markup = html({ projects: [] });
		expect(markup).not.toContain('<ul');
		expect(markup).toMatch(/<label [^>]*>Name<\/label>/);
		expect(markup).toMatch(/<label [^>]*>Key<\/label>/);
		expect(markup).toMatch(/<button [^>]*type="submit"[^>]*>\s*Projekt anlegen<\/button>/);
	});
});
