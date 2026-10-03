// Renders the views a fresh instance opens on; their data comes from the root layout's live state.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { LiveState } from '$lib/shell/live.svelte';
import Board from './board/+page.svelte';
import Stellwerk from './+page.svelte';

const live = (projects: LiveState['projects']): LiveState => ({
	projects,
	runs: [],
	openQuestions: 0,
	halted: false,
	activeRuns: 0
});
const studio = { id: 1, code: 'STU', name: 'Studio', palette: 1 as const };
const html = (view: unknown, data: object) =>
	render(view as never, { props: { data: { user: { name: 'owner' }, ...data } } as never }).body;
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe.each([
	['Stellwerk', Stellwerk],
	['Board', Board]
])('the %s', (_name, view) => {
	it('without a project says so in one sentence and leads to creating one', () => {
		const markup = html(view, { live: live([]) });
		expect(text(markup)).toContain('Noch kein Projekt');
		expect(text(markup)).toMatch(/Noch kein Projekt [^.]+\. Projekt anlegen/);
		expect(markup).toMatch(/<a [^>]*href="\/projects"[^>]*>Projekt anlegen<\/a>/);
	});

	it('with a project shows no such empty state', () => {
		expect(text(html(view, { live: live([studio]) }))).not.toContain('Noch kein Projekt');
	});
});
