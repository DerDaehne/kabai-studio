import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'svelte/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import { ROLES, VARIANTS } from '$lib/server/domain/variants';
import { actions, load, type ProjectPage } from './+page.server';
import Page from './+page.svelte';

vi.mock('$app/state', () => ({ page: { data: { locale: 'de' } } }));

const dir = mkdtempSync(join(tmpdir(), 'studio-project-route-'));
process.env.STUDIO_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

board.createProject(db(), { kind: 'user' }, { key: 'STU', name: 'Studio' });
board.createProject(db(), { kind: 'user' }, { key: 'WIS', name: 'Wissen' }, 'knowledge');

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
	it('loads name, key, variant and the steps of that variant in board order', () => {
		expect(loaded('STU')).toMatchObject({
			project: { code: 'STU', name: 'Studio' },
			variant: 'software',
			steps: VARIANTS.software
		});
		expect(loaded('WIS')).toMatchObject({ variant: 'knowledge', steps: VARIANTS.knowledge });
	});

	it('404s with a message for a key no project has', () => {
		expect(() => loaded('NOPE')).toThrow(
			expect.objectContaining({
				status: 404,
				body: { message: 'Ein Projekt NOPE gibt es nicht.' }
			})
		);
	});

	it('shows name, key, the variant with its steps in order and a way to the first ticket', () => {
		const markup = html(loaded('STU'));
		expect(markup).toMatch(/<h1[^>]*>.*Studio<\/h1>/s);
		expect(text(markup)).toContain('STU');
		expect(text(markup)).toContain('Variante Software');
		expect(text(markup)).toContain('Backlog Präzisieren Planen Umsetzen Kritik Abnahme Fertig');
		expect(markup).toMatch(/<label [^>]*>Titel<\/label>/);
		expect(markup).toMatch(/<button [^>]*type="submit"[^>]*>\s*Ticket anlegen<\/button>/);
		expect(markup).toMatch(/<a [^>]*href="\/projects"/);
	});

	it('shows the steps of the other variants and no role text of any step', () => {
		const knowledge = text(html(loaded('WIS')));
		expect(knowledge).toContain('Variante Wissen');
		expect(knowledge).toContain('Backlog Recherchieren Entwerfen Kritik Abnahme Fertig');
		for (const role of Object.values(ROLES)) expect(knowledge).not.toContain(role.slice(0, 40));
		expect(knowledge).not.toContain('Do: ');
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
