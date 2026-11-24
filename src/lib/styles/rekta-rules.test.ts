import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = (name: string) => readFileSync(`src/lib/styles/${name}`, 'utf8');
const rektaWeights = new Set(['300', '400', '500', '600', '700']);

describe("Rekta's basic rules", () => {
	it('keeps every font weight on a Rekta step', () => {
		const offStep = globSync('src/**/*.{svelte,css}')
			.filter((file) => !file.includes('rekta.'))
			.flatMap((file) =>
				[...readFileSync(file, 'utf8').matchAll(/font-weight:\s*(\d+)\s*;/g)]
					.filter((match) => !rektaWeights.has(match[1]))
					.map((match) => `${file}: ${match[0]}`)
			);
		expect(offStep).toEqual([]);
	});

	it('takes the control heights from Rekta and has no media query of its own for touch', () => {
		const tokens = styles('tokens.css');
		expect(tokens).toMatch(/--control-h: var\(--rk-control-height\);/);
		expect(tokens).toMatch(/--control-h-sm: var\(--rk-control-height\);/);
		expect(tokens).not.toMatch(/pointer:\s*coarse/);
	});

	it("turns the turnstile out and in with Rekta's angles and curves", () => {
		const tokens = styles('tokens.css');
		expect(tokens).toMatch(/--motion-turnstile-out: var\(--rk-turnstile-out-angle\);/);
		expect(tokens).toMatch(/--motion-turnstile-in: var\(--rk-turnstile-in-angle\);/);
		expect(tokens).toMatch(/--ease-turn-out: var\(--rk-ease-turn-out\);/);
		expect(tokens).toMatch(/--ease-turn-in: var\(--rk-ease-turn-in\);/);
		const base = styles('base.css');
		expect(base).toMatch(/turnstile-out;\s+animation-timing-function: var\(--ease-turn-out\);/);
		expect(base).toMatch(/turnstile-in;\s+animation-timing-function: var\(--ease-turn-in\);/);
		expect(base).toMatch(/rotateY\(calc\(-1 \* var\(--motion-turnstile-out\)\)\)/);
		expect(base).toMatch(/rotateY\(var\(--motion-turnstile-in\)\)/);
	});

	it('reads no turnstile angle through the deprecated alias', () => {
		const readers = globSync('src/**/*.{svelte,css,ts}')
			.filter((file) => !/(^|\/)rekta(\.tokens\.css|\.css|\.js|\.d\.ts)$/.test(file))
			.filter((file) => !file.endsWith('.test.ts'))
			.filter((file) => /--rk-turnstile-angle\b/.test(readFileSync(file, 'utf8')));
		expect(readers).toEqual([]);
	});
});

describe("Rekta's view transition and breakpoints", () => {
	it("leaves the page's own view transitions alone: Rekta's cross-fade applies only while it marks the root", () => {
		const rules = styles('rekta.css').match(/^[^\n{]*::view-transition-[^{]*\{/gm) ?? [];
		expect(rules.length).toBeGreaterThan(0);
		for (const rule of rules) expect(rule).toContain('[data-rk-crossfade]');
		expect(styles('base.css')).not.toContain('data-rk-crossfade');
	});

	it('puts the wide pivot where the studio does', () => {
		expect(styles('rekta.tokens.css')).toMatch(/--rk-pivot-wide: 1300px;/);
		for (const file of ['src/lib/ui/Pivot.svelte', 'src/routes/takt/+page.svelte'])
			expect(readFileSync(file, 'utf8')).toContain('min-width: 1300px');
	});
});
