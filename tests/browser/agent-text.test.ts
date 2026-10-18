import type { DatabaseSync } from 'node:sqlite';
import type { Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { addComment } from '../../src/lib/server/domain/board.ts';
import {
	appendEvent,
	createProfile,
	createRun,
	finishRun,
	startRun
} from '../../src/lib/server/domain/runs.ts';
import { expect, intoWorkStep, open, queueRun, test } from './fixtures.ts';

const HUMAN = { kind: 'user' } as const;

const LONG_LINE = `const value = "${'x'.repeat(200)}";`;
const MARKDOWN = [
	'# Findings',
	'',
	'- first point',
	'- second point',
	'',
	'```',
	LONG_LINE,
	'```',
	'',
	'![tracker](https://evil.example/pixel.png)'
].join('\n');

async function expectRendered(scope: Locator) {
	await expect(scope.locator('.agent-text li').first()).toHaveText('first point');
	await expect(scope.locator('pre code')).toContainText(LONG_LINE);
	await expect(scope.locator('img')).toHaveCount(0);
}

test('the Run-Akte shows comment, step message and final report as markdown, headings below the page title, a long code block scrolling inside itself', async ({
	page,
	db,
	seedTicket
}) => {
	const loaded: string[] = [];
	page.on('request', (request) => loaded.push(request.url()));
	const ticket = seedTicket('Render agent text');
	addComment(db, { kind: 'agent' }, ticket.id, MARKDOWN);
	finishedRunSaying(db, ticket.id, MARKDOWN);
	await page.setViewportSize({ width: 375, height: 800 });
	await open(page, ticket.path);

	const facetOf = { '.comments': /^akte/, '.message': /^spur/, '.report': /^spur/ };
	for (const [scope, facet] of Object.entries(facetOf)) {
		await page.getByRole('tab', { name: facet }).click();
		await expectRendered(page.locator(scope));
		await expect(
			page.locator(scope).getByRole('heading', { name: 'Findings', level: 4 })
		).toBeVisible();
	}
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

	const block = page.locator('.report pre');
	expect(await block.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
	).toBeLessThanOrEqual(0);
	expect(loaded.filter((url) => url.includes('evil.example'))).toEqual([]);
});

function finishedRunSaying(db: DatabaseSync, ticketId: number, text: string) {
	intoWorkStep(db, ticketId);
	const profile = createProfile(db, HUMAN, {
		name: `Fake ${randomUUID()}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: 'http://127.0.0.1:1',
		model: 'fake'
	});
	const run = createRun(db, HUMAN, { ticketId, profileId: profile.id }).id;
	startRun(db, HUMAN, run);
	appendEvent(db, HUMAN, run, { type: 'message', payload: { step: 1, text } });
	appendEvent(db, HUMAN, run, { type: 'message', key: 'handoff', payload: { text } });
	finishRun(db, HUMAN, run, { state: 'succeeded' });
}

test('Takt shows a question as a short heading with the rest rendered below, and the start tile shows plain text', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const question = `Which format?\n\n- CSV is flat\n- JSON nests\n\n\`\`\`\n${LONG_LINE}\n\`\`\``;
	fakeModel.reply({
		call: {
			name: 'request_human',
			args: {
				question,
				options: [{ label: '**CSV**', effect: 'uses `commas`' }, { label: 'JSON' }]
			}
		}
	});
	const ticket = seedTicket('Plain previews');
	await open(page, '/takt');
	await queueRun(db, page, ticket.id, fakeModel);

	await expect(page.getByRole('heading', { name: 'Which format?', level: 2 })).toBeVisible();
	const rest = page.locator('.question-rest');
	await expect(rest.getByRole('listitem').first()).toHaveText('CSV is flat');
	await expect(rest.locator('pre code')).toContainText(LONG_LINE);
	await page.setViewportSize({ width: 375, height: 800 });
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
	).toBeLessThanOrEqual(0);
	await expect(page.locator('.option .label').first()).toHaveText('CSV');
	await expect(page.locator('.option .effect').first()).toHaveText('uses commas');

	await open(page, '/');
	const tile = page.locator('.tile-frame', { hasText: ticket.ref }).locator('.question');
	await expect(tile).toContainText('Which format?');
	const shown = (await tile.textContent()) ?? '';
	expect(shown).not.toMatch(/```|^- |\*\*/m);
	await expect(tile.locator('li, pre, code')).toHaveCount(0);
});
