// Renders the page server-side: $effect does not run here, so key bindings and live updates are not reachable
// from this test (a known Vitest/Svelte-server-runtime gap) — those are covered by a headless-browser check instead.
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import type { TicketDetail } from '$lib/server/ticket-view';
import Page from './+page.svelte';

const base: TicketDetail = {
	id: 1,
	ref: 'STU-1',
	project: { id: 1, code: 'STU', name: 'Studio', palette: 1 },
	title: 'Beispiel-Ticket',
	description: '**fett** <script>alert(1)</script> [klick](javascript:alert(1))',
	type: 'ticket',
	column: { id: 10, name: 'In Arbeit', position: 3 },
	tasks: [
		{ id: 1, title: 'Erledigt', done: true },
		{ id: 2, title: 'Offen', done: false }
	],
	comments: [
		{
			id: 1,
			authorKind: 'user',
			author: 'user',
			body: 'Bitte prüfen.',
			createdAt: '',
			runId: null
		},
		{
			id: 2,
			authorKind: 'agent',
			author: 'agent (Run 5)',
			body: 'Erledigt.',
			createdAt: '',
			runId: 5
		},
		{
			id: 3,
			authorKind: 'system',
			author: 'system',
			body: 'Task gelöscht.',
			createdAt: '',
			runId: null
		}
	],
	relations: {
		waits_for: [{ ref: 'STU-2', title: 'Vorgänger', column: 'Backlog', blocking: true }],
		children: [{ ref: 'STU-3', title: 'Kind', column: 'Ready' }]
	},
	moves: [
		{ columnId: 11, name: 'Review', position: 4, blockers: [] },
		{
			columnId: 12,
			name: 'Abnahme',
			position: 5,
			blockers: [
				{ code: 'open_tasks', message: 'STU-1 hat 1 offene Tasks.', hint: 'Erledige sie zuerst.' }
			]
		}
	]
};

const page = (ticket: TicketDetail) =>
	render(Page, { props: { data: { ticket }, form: null } as any }).body;

it('shows the breadcrumb (project + ref), title and current column', () => {
	const body = page(base);
	expect(body).toContain('STU');
	expect(body).toContain('Studio');
	expect(body).toContain('STU-1');
	expect(body).toContain('Beispiel-Ticket');
	expect(body).toContain('In Arbeit');
});

it('renders the description as markdown and never as executable HTML or a javascript: link', () => {
	const body = page(base);
	expect(body).toContain('<strong>fett</strong>');
	expect(body).not.toContain('<script>');
	expect(body).toContain('&lt;script&gt;');
	expect(body).not.toMatch(/href="\s*javascript:/i);
});

it('lists tasks with their done state and offers rename/delete', () => {
	const body = page(base);
	expect(body).toMatch(/\[x\][^<]*Erledigt/);
	expect(body).toMatch(/\[ \][^<]*Offen/);
	expect(body).toContain('>Umbenennen<');
	expect(body).toContain('>Löschen<');
});

it('tells user, agent and system comments apart and names the run on an agent comment', () => {
	const body = page(base);
	expect(body).toContain('Mensch');
	expect(body).toMatch(/Agent[^<]*Run 5/);
	expect(body).toContain('System');
	expect(body).toContain('Bitte prüfen.');
});

it('groups relations under a German label and marks a still-blocking predecessor', () => {
	const body = page(base);
	expect(body).toMatch(/Wartet auf[\s\S]*STU-2[\s\S]*Vorgänger/);
	expect(body).toContain('blockiert noch');
	expect(body).toMatch(/Kinder[\s\S]*STU-3/);
});

it('offers every allowedMoves target, a button for the open one, the reason for the blocked one', () => {
	const body = page(base);
	expect(body).toMatch(/action="\?\/move"[\s\S]*?value="11"[\s\S]*?>Review</);
	expect(body).toContain('STU-1 hat 1 offene Tasks.');
	expect(body).toContain('Erledige sie zuerst.');
	expect(body).not.toMatch(/action="\?\/move"[\s\S]*?value="12"/); // Abnahme is blocked: no submit form for it
});

it('highlights an open question above the fold with a link to the Takt', () => {
	const withQuestion = page({
		...base,
		openQuestion: { id: 1, question: 'Weiter so?', options: [], answer: null }
	});
	expect(withQuestion).toContain('Weiter so?');
	expect(withQuestion).toContain('href="/takt"');
	expect(page(base)).not.toContain('Offene Frage');
});

it('offers a delete confirmation dialog naming the ticket, not a silent delete', () => {
	const body = page(base);
	expect(body).toContain('Ticket löschen');
	expect(body).toMatch(/STU-1[\s\S]*Beispiel-Ticket[\s\S]*unwiderruflich/);
	expect(body).toContain('action="?/delete"');
});
