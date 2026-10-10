// Renders server-side: the media query falls back to the tab list here, and keys, focus and the panorama need a
// browser (tests/browser/pivot.test.ts).
import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Pivot, { type Facet } from './Pivot.svelte';

const facets: Facet[] = [
	{ id: 'fragen', label: 'Fragen', count: 2, width: '560px' },
	{ id: 'laeuft', label: 'Läuft' },
	{ id: 'fertig', label: 'Fertig', count: 0 }
];
const panel = createRawSnippet((facet: () => Facet) => ({
	render: () => `<p>content of ${facet().id}</p>`
}));

const withoutHydrationMarkers = (html: string) => html.replace(/<!--.*?-->/g, '');
const renderPivot = (active?: string) =>
	withoutHydrationMarkers(
		render(Pivot, { props: { facets, active, label: 'Takt-Facetten', panel } }).body
	);
const tags = (body: string, pattern: RegExp) => body.match(pattern) ?? [];
const tabs = (body: string) => tags(body, /<button[^>]*role="tab"[^>]*>/g);
const panels = (body: string) => tags(body, /<section[^>]*>/g);
const idOf = (tag = '') => tag.match(/ id="([^"]+)"/)?.[1];

describe('Pivot', () => {
	it('renders a named tab list whose tabs control the panels of their facets', () => {
		const body = renderPivot();
		expect(body).toMatch(/role="tablist" aria-label="Takt-Facetten"/);
		const [tab] = tabs(body);
		const [section] = panels(body);
		expect(tab).toContain(`aria-controls="${idOf(section)}"`);
		expect(section).toContain(`aria-labelledby="${idOf(tab)}"`);
		expect(section).toContain('role="tabpanel"');
	});

	it('selects the first facet when none is given and shows only its panel', () => {
		const body = renderPivot();
		expect(tabs(body).map((tab) => /aria-selected="true"/.test(tab))).toEqual([true, false, false]);
		expect(tabs(body).map((tab) => /tabindex="0"/.test(tab))).toEqual([true, false, false]);
		expect(panels(body).map((section) => / hidden/.test(section))).toEqual([false, true, true]);
	});

	it('selects the facet given from outside', () => {
		const body = renderPivot('fertig');
		expect(tabs(body).map((tab) => /aria-selected="true"/.test(tab))).toEqual([false, false, true]);
		expect(panels(body).map((section) => / hidden/.test(section))).toEqual([true, true, false]);
	});

	it('shows a count next to the title and the heading of each facet that has one, zero included', () => {
		const body = renderPivot();
		expect(tags(body, /<span class="count[^"]*">\d+<\/span>/g)).toHaveLength(4);
		expect(body).toMatch(/Fragen <span class="count[^"]*">2<\/span>/);
		expect(body).toMatch(/Fertig <span class="count[^"]*">0<\/span>/);
	});

	it('renders every facet with its own width, for the panorama the styles lay out before hydration', () => {
		const body = renderPivot();
		expect(panels(body)).toHaveLength(3);
		expect(panels(body)[0]).toContain('--facet-width: 560px');
		expect(body).toContain('<p>content of laeuft</p>');
	});
});
