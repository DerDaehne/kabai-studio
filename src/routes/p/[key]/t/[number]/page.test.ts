// Renders the page server-side: $effect does not run here, so key bindings and live updates are not reachable
// from this test (a known Vitest/Svelte-server-runtime gap) — those are covered by a headless-browser check instead.
import { render } from 'svelte/server';
import { expect, it, vi } from 'vitest';
import type { TicketDetail } from '$lib/server/ticket-view';
import Page from './+page.svelte';

vi.mock('$app/state', () => ({
	page: {
		data: { locale: 'en' },
		url: new URL('http://studio.test/p/STU/t/1'),
		params: { key: 'STU', number: '1' }
	}
}));

const base: TicketDetail = {
	id: 1,
	ref: 'STU-1',
	project: { id: 1, code: 'STU', name: 'Studio', palette: 1 },
	title: 'Beispiel-Ticket',
	description: '**fett** <script>alert(1)</script> [klick](javascript:alert(1))',
	type: 'ticket',
	column: { id: 10, name: 'In Arbeit', phase: 'work', position: 3 },
	lage: {
		ticketId: 1,
		projectId: 1,
		step: 'implement',
		variant: 'software',
		lage: 'waiting',
		reason: { kind: 'failure' },
		progress: { index: 2, total: 4 }
	},
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
		{ columnId: 11, name: 'Review', phase: 'work', position: 4, blockers: [] },
		{
			columnId: 12,
			name: 'Abnahme',
			phase: 'acceptance',
			position: 5,
			blockers: [
				{ code: 'open_tasks', message: 'STU-1 hat 1 offene Tasks.', hint: 'Erledige sie zuerst.' }
			]
		}
	]
};

// the run control (tabs, start) has its own tests; here it renders with no run and no profile
const noRuns = { runs: [], start: { profiles: [] }, flow: false };
const page = (ticket: TicketDetail, form: unknown = null, flow = false) =>
	render(Page, { props: { data: { ticket, ...noRuns, flow }, form } as any }).body;

it('shows the crumb to the board, the kicker with project and ref, and one bold title', () => {
	const body = page(base);
	expect(body).toContain('Board');
	expect(body).toMatch(/class="rk-kicker[^"]*"[\s\S]*STU[\s\S]*STU-1/);
	expect(body.match(/<h1[^>]*>/g)).toHaveLength(1);
	expect(body).toMatch(/<h1 class="rk-title[^"]*">Beispiel-Ticket<\/h1>/);
});

it('puts the Lage with its reason and the step under the title, and the column only in the expert view', () => {
	const facts = (body: string) => body.match(/<p class="rk-facts[^"]*"[\s\S]*?<\/p>/)![0];
	expect(facts(page(base))).toMatch(/Waiting for you · Run failed/);
	expect(facts(page(base))).toContain('Step 2 of 4');
	expect(facts(page(base))).toContain('implementation');
	expect(facts(page(base))).not.toContain('In Arbeit');
	expect(facts(page(base, null, true))).toContain('Column In Arbeit');
});

it('offers the facets trace, file and runs, and question only while one is open', () => {
	const names = (body: string) =>
		[...body.matchAll(/role="tab"[^>]*>\s*([a-z]+)/g)].map((match) => match[1]);
	expect(names(page(base))).toEqual(['trace', 'file', 'runs']);
	const asked = page({
		...base,
		openQuestion: { id: 1, question: 'Weiter so?', options: [], answer: null }
	});
	expect(names(asked)).toEqual(['question', 'trace', 'file', 'runs']);
});

it('renders the description as markdown and never as executable HTML or a javascript: link', () => {
	const body = page(base);
	expect(body).toContain('<strong>fett</strong>');
	expect(body).not.toContain('<script>');
	expect(body).toContain('&lt;script&gt;');
	expect(body).not.toMatch(/href="\s*javascript:/i);
});

it('shows each task as a switch that is on when done, and offers rename and delete', () => {
	const body = page(base);
	expect(body).toMatch(/<label class="rk-switch"><input type="checkbox" checked[^>]*>\s*Erledigt/);
	expect(body).toMatch(
		/<label class="rk-switch"><input type="checkbox"(?![^>]*checked)[^>]*>\s*Offen/
	);
	expect(body).toContain('>Rename<');
	expect(body).toContain('>Delete<');
});

it('tells user, agent and system comments apart with a distinct icon plus text, and names the run on an agent comment', () => {
	const body = page(base);
	expect(body).toContain('Human');
	expect(body).toMatch(/Agent · Run 5/);
	expect(body).toContain('System');
	expect(body).toContain('Bitte prüfen.');

	// one <svg><path> per comment's author icon, each aria-hidden; the three must differ from each other
	const icons = [
		...body.matchAll(
			/<span class="author[^"]*"><svg[^>]*aria-hidden="true"[^>]*><path d="([^"]+)">/g
		)
	].map((m) => m[1]);
	expect(icons).toHaveLength(3);
	expect(new Set(icons).size).toBe(3); // user, agent, system each get a different glyph
});

it('groups relations under a label and marks a still-blocking predecessor', () => {
	const body = page(base);
	expect(body).toMatch(/Waits for[\s\S]*STU-2[\s\S]*Vorgänger/);
	expect(body).toContain('still blocking');
	expect(body).toMatch(/Children[\s\S]*STU-3/);
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
	expect(page(base)).not.toContain('Open question');
});

// Errors offer a way out: every refused action shows message AND hint, not just one of the two. All five forms
// render it through the shared `formError` snippet, so these four reachable actions also cover a regression in
// `taskDialog`'s identical call — only its surrounding dialog content is gated by client state no SSR render can
// set, not the error rendering itself.
it.each(['addTask', 'addComment', 'move', 'update'])(
	'shows both message and hint for a %s failure',
	(action) => {
		const body = page(base, { action, code: 'x', message: 'Die Nachricht.', hint: 'Der Ausweg.' });
		expect(body).toContain('Die Nachricht.');
		expect(body).toContain('Der Ausweg.');
		// exactly once: the error belongs to the form that caused it, not to every form on the page
		expect(body.split('Die Nachricht.').length - 1).toBe(1);
	}
);

it('offers a delete confirmation dialog naming the ticket, not a silent delete', () => {
	const body = page(base);
	expect(body).toContain('Delete ticket');
	expect(body).toMatch(/STU-1[\s\S]*Beispiel-Ticket[\s\S]*cannot be undone/);
	expect(body).toContain('action="?/delete"');
});

it('shows the loaded run in the trace facet, and an empty state before the first run', () => {
	const events = [
		{ seq: 1, type: 'message', key: 'step:1:message', payload: { step: 1, text: 'Ich lese.' } }
	];
	const withRun = render(Page, {
		props: {
			data: {
				ticket: base,
				trace: { id: 3, state: 'running', waitsForAnswer: false, events },
				...noRuns
			},
			form: null
		} as any
	}).body;
	expect(withRun).toMatch(/Run 3[\s\S]*Ich lese\./);
	expect(withRun).not.toContain('No run yet');
	expect(page(base)).toContain('No run yet');
});
