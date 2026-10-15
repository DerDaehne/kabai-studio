import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { latestOpenQuestion, requestHuman } from '../../src/lib/server/domain/questions.ts';
import { expect, open, test, type SeededTicket } from './fixtures.ts';

const HUMAN: Actor = { kind: 'user' };
const SHORT = 'Autor und Kritiker sind sich nicht einig. Wie soll es weitergehen?';
const FINDING_WORD = 'Befundzeile';
const FINDING = `${FINDING_WORD} `.repeat(300).trim();
const OPTIONS = [{ label: 'Zurückgehen' }, { label: 'Weitergehen' }, { label: 'Aufhören' }];

function askWithFinding(db: DatabaseSync, ticket: SeededTicket, lead = SHORT, finding = FINDING) {
	requestHuman(db, HUMAN, ticket.id, {
		question: finding ? `${lead}\n\nBefunde jetzt:\n${finding}` : lead,
		options: OPTIONS
	});
}

const tileOf = (page: Page, ref: string) =>
	page
		.getByRole('region', { name: 'jetzt', exact: true })
		.locator('.slot')
		.filter({ hasText: ref });

test.describe('at 1440 px', () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test('a question with a 3,000-character finding keeps its 2×2 tile and shows only the short form', async ({
		page,
		db,
		seedTicket
	}) => {
		expect(FINDING.length).toBeGreaterThanOrEqual(3000);
		const ticket = seedTicket('Long finding at 1440');
		askWithFinding(db, ticket);
		await open(page, '/');

		const tile = tileOf(page, ticket.ref);
		await expect(tile).toContainText(SHORT);
		await expect(tile).not.toContainText(FINDING_WORD);
		await expect(tile).toHaveAttribute('data-size', '2x2');
		const box = (await tile.boundingBox())!;
		expect(Math.round(box.width)).toBe(308);
		expect(Math.round(box.height)).toBe(308);
		expect(
			await tile
				.locator('.tile')
				.evaluate((element) => element.scrollHeight <= element.clientHeight)
		).toBe(true);
	});

	test('1 to 3 answer in the tile, u takes the answer back, and "mehr" leads to the full text', async ({
		page,
		db,
		seedTicket
	}) => {
		const ticket = seedTicket('Answer a long question');
		askWithFinding(db, ticket);
		await open(page, '/');
		const tile = tileOf(page, ticket.ref);
		await expect(tile.getByRole('button', { name: /^Antwort \d/ })).toHaveCount(3);

		for (const key of ['1', '2', '3']) {
			await page.keyboard.press(key);
			await expect(page.getByText(`Antwort gesendet · ${ticket.ref}`)).toBeVisible();
			await expect(tile).toBeHidden();
			expect(latestOpenQuestion(db, ticket.id)).toBeUndefined();
			await page.keyboard.press('u');
			await expect(tile).toContainText(SHORT);
			expect(latestOpenQuestion(db, ticket.id)).toMatchObject({ answer: null });
		}

		await tile.getByRole('link', { name: /^mehr/ }).click();
		await expect(page).toHaveURL(new RegExp(`${ticket.path}`));
		await expect(page.locator('.question .agent-text')).toContainText(FINDING_WORD);
		await expect(page.locator('.question .agent-text').getByText('Befunde jetzt:')).toBeVisible();
	});

	test('the live regions read the short form only, while Takt and the Run-Akte show the whole text', async ({
		page,
		db,
		seedTicket
	}) => {
		const ticket = seedTicket('Announce the short form');
		askWithFinding(db, ticket, SHORT, `- erster Punkt\n- zweiter Punkt\n\n${FINDING}`);

		await open(page, '/takt');
		const announced = page.locator('[aria-live="polite"]').filter({ hasText: ticket.ref });
		await expect(announced).toHaveText(`${ticket.ref}: ${SHORT}`);
		await expect(page.getByRole('heading', { name: SHORT, level: 2 })).toBeVisible();
		await expect(page.locator('.question-rest').getByRole('listitem').first()).toHaveText(
			'erster Punkt'
		);
		await expect(page.locator('.question-rest')).toContainText(FINDING_WORD);

		await open(page, ticket.path);
		const status = page.getByRole('status').filter({ hasText: 'Offene Frage' });
		await expect(status).toContainText(SHORT);
		await expect(status).not.toContainText(FINDING_WORD);
		await expect(page.locator('.question .agent-text')).toContainText(FINDING_WORD);
	});
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test('a question tile with a 3,000-character finding is no taller than one whose short form fills the line limit', async ({
		page,
		db,
		seedTicket
	}) => {
		const wordy = `${'Streit um die Reihenfolge. '.repeat(8)}Wie soll es weitergehen?`;
		const plain = seedTicket('Short form fills the limit');
		const long = seedTicket('Same short form, long finding');
		askWithFinding(db, plain, wordy, '');
		askWithFinding(db, long, wordy, FINDING);
		await open(page, '/');

		const heights = [];
		for (const ticket of [plain, long]) {
			const tile = tileOf(page, ticket.ref);
			await expect(tile.getByRole('link', { name: /^mehr/ })).toBeVisible();
			await expect(tile).not.toContainText(FINDING_WORD);
			heights.push((await tile.boundingBox())!.height);
		}
		expect(heights[1]).toBe(heights[0]);
	});
});
