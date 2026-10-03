import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	renderModelsSection,
	buildReadme
} from '../../../scripts/generate-model-catalog-readme.ts';
import { MODELS } from './model-catalog.ts';

describe('README "Local models" section', () => {
	it('matches what the catalog generates (run `npm run docs:models` after editing the catalog)', () => {
		const readmePath = new URL('../../../README.md', import.meta.url);
		const current = readFileSync(readmePath, 'utf8');
		expect(buildReadme(current, MODELS)).toBe(current);
	});

	it('shows the fix for every pitfall, not just the problem', () => {
		const rendered = renderModelsSection(MODELS);
		for (const entry of MODELS) {
			for (const pitfall of entry.pitfalls) {
				expect(rendered).toContain(pitfall.fix);
			}
		}
	});
});
