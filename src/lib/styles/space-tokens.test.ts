import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const defined = new Set(
	[...readFileSync('src/lib/styles/tokens.css', 'utf8').matchAll(/(--space-[\w-]+)\s*:/g)].map(
		(match) => match[1]
	)
);

describe('spacing tokens', () => {
	it('defines every --space-* token that a component or stylesheet uses', () => {
		const unknown = globSync('src/**/*.{svelte,css}').flatMap((file) =>
			[...readFileSync(file, 'utf8').matchAll(/var\((--space-[\w-]+)\)/g)]
				.filter((match) => !defined.has(match[1]))
				.map((match) => `${file}: ${match[1]}`)
		);
		expect(unknown).toEqual([]);
	});
});
