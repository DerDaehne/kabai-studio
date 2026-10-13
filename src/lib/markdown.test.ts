import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { leadText, plainText, renderAgentText, splitLead } from './markdown';

const MALICIOUS = [
	'<script>alert(1)</script>',
	'<img src=x onerror=alert(1)>',
	'[x](javascript:alert(1))',
	'[x](  JaVaScRiPt:alert(1))',
	'[x](data:image/png;base64,AAAA)',
	'[x](data:text/html;base64,AAAA)',
	'![x](https://evil.example/x.png)',
	'![](data:image/png;base64,AAAA)',
	'![x][ref]\n\n[ref]: https://evil.example/x.png',
	"[x](javascript:alert('https:'))"
].join('\n\n');

it('renders common markdown (heading, bold, list, link) as HTML', () => {
	const html = renderAgentText(
		'## Titel\n\n**fett** und eine Liste:\n\n- a\n- b\n\n[kabai](https://example.com)'
	);
	expect(html).toContain('<h5>Titel</h5>');
	expect(html).toContain('<strong>fett</strong>');
	expect(html).toContain('<li>a</li>');
	expect(html).toContain('<a href="https://example.com" rel="noopener noreferrer">kabai</a>');
});

it('keeps single newlines as line breaks', () => {
	expect(renderAgentText('eins\nzwei')).toContain('eins<br>\nzwei');
});

it('shifts headings three levels down and never past h6', () => {
	const html = renderAgentText('# a\n\n### b\n\n###### c');
	expect(html).toContain('<h4>a</h4>');
	expect(html).toContain('<h6>b</h6>');
	expect(html).toContain('<h6>c</h6>');
	expect(html).not.toMatch(/<h[123]>/);
});

it('wraps malicious markdown so that nothing executable or remote arrives', () => {
	const html = renderAgentText(MALICIOUS);
	expect(html).not.toMatch(/<script/i);
	expect(html).not.toMatch(/<img/i);
	expect(html).not.toMatch(/\bonerror\s*=\s*"/i);
	expect(html).toContain('&lt;script&gt;');
	for (const [, href] of html.matchAll(/href="([^"]*)"/g)) expect(href).toMatch(/^https?:/);
});

it('shows an image as a plain link the reader has to click, never as an <img>', () => {
	const html = renderAgentText('![chart](https://example.com/p.png)');
	expect(html).not.toContain('<img');
	expect(html).toContain('<a href="https://example.com/p.png" rel="noopener noreferrer">chart</a>');
});

it('gives every link rel="noopener noreferrer" and leaves no other scheme clickable', () => {
	const html = renderAgentText('[a](https://a.example) [b](http://b.example) [c](mailto:x@y.z)');
	expect(html.match(/<a /g)).toHaveLength(2);
	expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
	expect(html).not.toContain('mailto:x@y.z"');
});

it('turns markdown into plain text without markers', () => {
	const text = plainText(
		'# Titel\n\n**fett** und `code` mit [Link](https://example.com)\n\n- eins\n- zwei\n\n```js\nconst a = 1;\n```'
	);
	expect(text).toBe('Titel\nfett und code mit Link\neins zwei\nconst a = 1;');
	expect(text).not.toMatch(/\*\*|^- |#|`/m);
});

it('gives the first paragraph as short form and the markdown after it as rest', () => {
	expect(leadText('**Erster** Absatz\nzweite Zeile\n\nZweiter')).toBe(
		'Erster Absatz\nzweite Zeile'
	);
	expect(splitLead('Kopf\n\n- a\n- b\n\n```\ncode\n```')).toEqual({
		lead: 'Kopf',
		rest: '- a\n- b\n\n```\ncode\n```'
	});
	expect(splitLead('')).toEqual({ lead: '', rest: '' });
	expect(splitLead('Nur eins').rest).toBe('');
});

it('keeps the rest directly after the first block, also without a blank line', () => {
	expect(splitLead('Frage\n- a\n- b').rest).toBe('- a\n- b');
});

it('counts a lone carriage return as a line break when splitting off the rest', () => {
	expect(splitLead('Frage\r\r- a\r- b').rest).toBe('- a\n- b');
});

it('lets only AgentText inject markup: no {@html} elsewhere, no other markdown-it user', () => {
	const files = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? files(path) : [path];
		});
	const source = files('src').filter(
		(path) => /\.(svelte|ts)$/.test(path) && !path.endsWith('.test.ts')
	);
	const using = (needle: RegExp) =>
		source.filter((path) => needle.test(readFileSync(path, 'utf8'))).sort();
	expect(using(/\{\s*@html\b/)).toEqual([join('src', 'lib', 'ui', 'AgentText.svelte')]);
	expect(using(/\.(inner|outer)HTML\s*=|insertAdjacentHTML/)).toEqual([]);
	expect(using(/['"]markdown-it['"]/)).toEqual([join('src', 'lib', 'markdown.ts')]);
});
