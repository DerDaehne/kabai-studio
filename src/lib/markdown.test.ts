import { expect, it } from 'vitest';
import { renderDescription } from './markdown';

it('renders common markdown (heading, bold, list, link) as HTML', () => {
	const html = renderDescription(
		'# Titel\n\n**fett** und eine Liste:\n\n- a\n- b\n\n[kabai](https://example.com)'
	);
	expect(html).toContain('<h1>Titel</h1>');
	expect(html).toContain('<strong>fett</strong>');
	expect(html).toContain('<li>a</li>');
	expect(html).toContain('<a href="https://example.com">kabai</a>');
});

it('never executes a <script> tag: with html disabled it comes out as escaped text', () => {
	const html = renderDescription('Vorher <script>alert(1)</script> nachher');
	expect(html).not.toContain('<script>');
	expect(html).toContain('&lt;script&gt;');
});

it('never turns a javascript: link into a clickable href', () => {
	const html = renderDescription('[klick mich](javascript:alert(1))');
	expect(html).not.toContain('href="javascript:');
});

it('also blocks javascript: hidden behind whitespace or mixed case, as markdown-it normalises the scheme', () => {
	const html = renderDescription('[x](  JaVaScRiPt:alert(1))');
	expect(html).not.toMatch(/href="\s*javascript:/i);
});

it('passes plain text through unescaped-looking but safe (no markup injected via attributes)', () => {
	const html = renderDescription('Text mit "Anführungszeichen" & einem <Winkel> drin.');
	expect(html).not.toContain('<Winkel>');
	expect(html).toContain('&lt;Winkel&gt;');
});
