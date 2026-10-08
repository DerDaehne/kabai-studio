import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import HairlineList from './HairlineList.svelte';
import Progress from './Progress.svelte';
import Sparkline from './Sparkline.svelte';
import StatPair from './StatPair.svelte';
import Tag from './Tag.svelte';
import Tile from './Tile.svelte';
import { tones } from './tone';

const text = (content: string) =>
	createRawSnippet(() => ({ render: () => `<span>${content}</span>` }));
const accessibleName = (body: string) => body.match(/aria-label="([^"]*)"/)?.[1];

describe('Tile', () => {
	it.each(tones)('fills itself with the tile token of the %s tone', (tone) => {
		const { body } = render(Tile, { props: { tone, children: text('3 runs') } });
		expect(body).toContain(`data-tone="${tone}"`);
		expect(body).toContain(`style="--tile-fill: var(--tile-${tone})"`);
	});

	it('is a link with href, a button with onclick and a plain container otherwise', () => {
		const children = text('run');
		const link = render(Tile, { props: { href: '/takt', children } }).body;
		const button = render(Tile, { props: { onclick: () => {}, children } }).body;
		const container = render(Tile, { props: { children } }).body;
		expect(link).toMatch(/<a href="\/takt" class="tile /);
		expect(button).toMatch(/<button type="button" class="tile /);
		expect(container).toMatch(/<div class="tile /);
	});

	it('takes the size that its importance asks for, 1x1 by default', () => {
		expect(render(Tile, { props: { children: text('a') } }).body).toContain('data-size="1x1"');
		const large = render(Tile, { props: { size: '2x2', children: text('a') } }).body;
		expect(large).toContain('data-size="2x2"');
	});
});

describe('Sparkline', () => {
	const sparkline = (values: number[], unit?: string) =>
		render(Sparkline, { props: { values, label: 'tokens je minute', unit } }).body;

	it('names the latest value and a rising trend as its text alternative, also as its title', () => {
		const body = sparkline([3, 5, 8]);
		expect(body).toContain('role="img"');
		expect(accessibleName(body)).toBe('tokens je minute: 8, steigend');
		expect(body).toContain('<title>tokens je minute: 8, steigend</title>');
	});

	it('says falling or steady when the series ends below or at its start', () => {
		expect(accessibleName(sparkline([9, 12, 4]))).toBe('tokens je minute: 4, fallend');
		expect(accessibleName(sparkline([4, 9, 4]))).toBe('tokens je minute: 4, gleichbleibend');
	});

	it('formats the value the German way and adds the unit', () => {
		expect(accessibleName(sparkline([1200, 12345], 'tok'))).toBe(
			'tokens je minute: 12.345 tok, steigend'
		);
	});

	it('shows „keine Daten“ as text instead of an empty graph', () => {
		const body = sparkline([]);
		expect(body).not.toContain('<svg');
		expect(body).toContain('tokens je minute: keine Daten');
	});

	it('draws a single value as a flat line without claiming a trend', () => {
		const body = sparkline([5]);
		expect(accessibleName(body)).toBe('tokens je minute: 5');
		expect(body).toContain('d="M0,2 L100,2"');
	});

	it('draws in the full state colour of its tone, or in the text colour when neutral', () => {
		const tone = (value: 'error' | 'neutral') =>
			render(Sparkline, { props: { values: [1, 2], label: 'x', tone: value } }).body;
		expect(tone('error')).toContain('--stroke: var(--mark-error);');
		expect(tone('neutral')).toContain('--stroke: currentColor;');
	});
});

describe('Progress', () => {
	const progress = (value: number, max: number, format?: 'count' | 'percent') =>
		render(Progress, { props: { value, max, label: 'kriterien', format } }).body;

	it('states "x von y" in words next to a native progress bar', () => {
		const body = progress(3, 8);
		expect(body).toMatch(/<progress [^>]*aria-label="kriterien"/);
		expect(body).toMatch(/<progress [^>]*aria-valuetext="3 von 8"/);
		expect(body).toMatch(/<span class="figure[^"]*">3 von 8<\/span>/);
	});

	it('states a percentage when asked to', () => {
		expect(progress(3, 8, 'percent')).toMatch(/aria-valuetext="38\s%"/u);
	});

	it('stays at zero instead of dividing by zero when nothing is planned yet', () => {
		const body = progress(0, 0);
		expect(body).toMatch(/<progress [^>]*value="0"/);
		expect(body).toMatch(/aria-valuetext="0 von 0"/);
	});
});

describe('StatPair', () => {
	it('shows the figure in German digits with its unit, and the label that names it', () => {
		const { body } = render(StatPair, {
			props: { label: 'tokens heute', value: 12345, unit: 'tok' }
		});
		expect(body).toMatch(/12\.345(<!--[^>]*-->)?<span class="unit[^"]*">\u00a0tok<\/span>/);
		expect(body).toMatch(/<span class="label[^"]*">tokens heute<\/span>/);
	});
});

describe('Tag', () => {
	it.each(tones)('puts a square in the full %s colour before the word', (tone) => {
		const { body } = render(Tag, { props: { tone, children: text('läuft') } });
		expect(body).toContain(`--square: var(--mark-${tone});`);
		expect(body).toContain('<span>läuft</span>');
	});
});

describe('HairlineList', () => {
	it('renders one labelled list item per entry, in order', () => {
		const items = [{ key: 'a' }, { key: 'b' }];
		const row = createRawSnippet((item: () => { key: string }) => ({
			render: () => `<span>${item().key}</span>`
		}));
		const { body } = render(HairlineList<{ key: string }>, {
			props: { items, row, label: 'runs' }
		});
		expect(body).toMatch(/<ul class="hairline-list[^"]*" aria-label="runs">/);
		expect([...body.matchAll(/<li[^>]*><span>(\w)<\/span>/g)].map((m) => m[1])).toEqual(['a', 'b']);
	});
});
