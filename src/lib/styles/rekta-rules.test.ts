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

	it("eases the turnstile with Rekta's curve", () => {
		expect(styles('tokens.css')).toMatch(/--ease-out: var\(--rk-ease-out\);/);
		expect(styles('base.css')).toMatch(/animation-timing-function: var\(--ease-out\);/);
	});
});
