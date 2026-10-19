import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256, splitVendored, UPSTREAM } from '../../../scripts/sync-rekta.ts';

// Offline drift guard for the vendored Rekta Design files. Comparing against upstream needs the network and
// runs nightly (scripts/sync-rekta.ts --check); this suite only proves the files are what the sync wrote.

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const vendoredFiles = {
	'rekta.tokens.css': read('./rekta.tokens.css'),
	'rekta.css': read('./rekta.css')
};
const tokens = splitVendored(vendoredFiles['rekta.tokens.css']);
const declared = new Set([...tokens.body.matchAll(/(--rk-[\w-]+):/g)].map((match) => match[1]));
// Public hooks the page writes and Rekta's stylesheet reads; they are no tokens
const hooks = new Set(['--rk-banner-h', '--rk-pivot-h', '--rk-pivot-scale', '--rk-toast-left']);

function appSources(): { file: string; text: string }[] {
	const root = new URL('../../', import.meta.url);
	return readdirSync(root, { recursive: true, encoding: 'utf8' })
		.filter((file) => /\.(css|svelte|ts)$/.test(file))
		.filter((file) => !file.endsWith('.test.ts') && !/(^|\/)rekta(\.tokens)?\.css$/.test(file))
		.map((file) => ({ file, text: readFileSync(new URL(file, root), 'utf8') }));
}

describe.each(Object.entries(vendoredFiles))('vendored %s', (name, text) => {
	const vendored = splitVendored(text);

	it('carries a provenance header with source, commit, output, hash, licence and the design system notice', () => {
		expect(text).toContain(` * Source: ${UPSTREAM}\n`);
		expect(vendored.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(vendored.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(text).toContain(` * Output: dist/${name}\n`);
		expect(text).toContain(' * License: MIT');
		expect(text).toContain('Porsche Design System source code (Apache License 2.0)');
	});

	it('matches the SHA-256 in its header, so nobody edited the generated CSS by hand', () => {
		expect(sha256(vendored.body)).toBe(vendored.sha256);
	});
});

describe('the two vendored files together', () => {
	it('reads every hook the app writes', () => {
		const sheet = splitVendored(vendoredFiles['rekta.css']).body;
		for (const hook of hooks) expect(sheet, hook).toContain(`var(${hook}`);
	});

	it('come from the same Rekta commit', () => {
		expect(splitVendored(vendoredFiles['rekta.css']).commit).toBe(tokens.commit);
	});

	it('start their bodies with the generator line, so the header hides nothing of the generated file', () => {
		expect(tokens.body).toMatch(
			/^\/\* Rekta Design tokens\. Generated from .* by scripts\/build\.mjs/
		);
	});

	it('declare every --rk-* variable that the app uses or overrides', () => {
		const unknown = appSources().flatMap(({ file, text }) =>
			[...text.matchAll(/--rk-[\w-]+/g)]
				.map((match) => match[0])
				.filter((name) => !declared.has(name) && !hooks.has(name))
				.map((name) => `${file}: ${name}`)
		);
		expect(declared.size).toBeGreaterThan(100);
		expect(unknown).toEqual([]);
	});

	it('leave no 0.1 --rekta-* name anywhere in the app', () => {
		const old = appSources().flatMap(({ file, text }) => (text.includes('--rekta-') ? [file] : []));
		expect(old).toEqual([]);
	});
});

describe('tokens.css on top of rekta.tokens.css', () => {
	const tokensCss = read('./tokens.css');
	const declarationsIn = (rule: string) =>
		new Map([...rule.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]));

	it('imports the Rekta tokens before declaring anything, so its own names can build on them', () => {
		expect(tokensCss.indexOf("@import './rekta.tokens.css';")).toBeGreaterThan(0);
		expect(tokensCss.indexOf("@import './rekta.tokens.css';")).toBeLessThan(
			tokensCss.indexOf('\n:root {')
		);
	});

	it('imports the component sheet right after the tokens, so the shell rules that follow win', () => {
		expect(tokensCss.indexOf("@import './rekta.css';")).toBe(
			tokensCss.indexOf("@import './rekta.tokens.css';") + "@import './rekta.tokens.css';\n".length
		);
	});

	it('points the tile, mark, type, weight and motion tokens and the UI fonts at Rekta values', () => {
		const root = declarationsIn(
			tokensCss.slice(tokensCss.indexOf('\n:root {'), tokensCss.indexOf('\n}'))
		);
		const rektaBacked = [...root].filter(([name]) =>
			/^--(tile|mark|type|weight|motion)-|^--(rule|radius-tile|ease-base|font-sans|font-mono)$/.test(
				name
			)
		);
		expect(rektaBacked.length).toBeGreaterThan(25);
		for (const [name, value] of rektaBacked) expect(value, name).toMatch(/^var\(--rk-[\w-]+\)$/);
	});

	it('sets every Rekta duration to 0s under data-motion="off", by Rekta itself', () => {
		const start = tokens.body.indexOf(':root[data-motion="off"] {');
		expect(start).toBeGreaterThan(0);
		const off = declarationsIn(tokens.body.slice(start, tokens.body.indexOf('}', start)));
		const durations = [...declared].filter((name) =>
			/^--rk-duration-(short|moderate|long|press|pivot-glide|pivot-size|stagger|pulse|busy|float|dots)$/.test(
				name
			)
		);
		expect(durations).toHaveLength(11);
		for (const name of durations) expect(off.get(name), name).toBe('0s');
	});

	it('overrides only the toast window of the Rekta durations, and does not zero any itself', () => {
		expect(tokensCss).not.toMatch(/^\s*--rk-duration-(?!toast:)[\w-]+:/m);
		expect(tokensCss).toMatch(/^\s*--rk-duration-toast: 10000ms;/m);
	});

	it('keeps the toast window out of the code: it is read from the token', () => {
		const hardCoded = [
			'ui/toast.svelte.ts',
			'ui/Toaster.svelte',
			'../routes/board/row-flows.svelte.ts'
		].filter((file) =>
			/\b10_?000\b/.test(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
		);
		expect(hardCoded).toEqual([]);
	});
});
