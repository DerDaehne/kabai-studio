import type { DatabaseSync } from 'node:sqlite';
import type { Locator, Page } from '@playwright/test';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { latestOpenQuestion, requestHuman } from '../../src/lib/server/domain/questions.ts';
import { DISPUTE_OPTIONS } from '../../src/lib/server/domain/steps.ts';
import { expect, open, queueRun, test, type SeededTicket } from './fixtures.ts';

const HUMAN: Actor = { kind: 'user' };
const SHORT = 'Autor und Prüfung sind sich nach 2 Runden nicht einig. Wie soll es weitergehen?';
const FINDING_WORD = 'Befundzeile';
const FINDING = `${FINDING_WORD} `.repeat(300).trim();
const OPTIONS = DISPUTE_OPTIONS;

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
		expect(Math.round((await tile.locator('.tile').boundingBox())!.height)).toBe(308);
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

const lineHeightOf = (locator: Locator) =>
	locator.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));

test.describe('at 1440 px, with the real options and a profile', () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test('the tile fills its 2×2 slot exactly, two tiles do not overlap, and Enter opens the Run-Akte', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const ticket = seedTicket('Real dispute options');
		const question = `${SHORT}\n\nBefunde jetzt:\n${FINDING.slice(0, 1800)}`;
		fakeModel.reply({
			call: {
				name: 'request_human',
				args: { question, options: OPTIONS.map(({ label }) => ({ label })) }
			}
		});
		await open(page, '/');
		await queueRun(db, page, ticket.id, fakeModel);

		const slot = tileOf(page, ticket.ref);
		await expect(slot.getByRole('button', { name: /^Antwort 3/ })).toBeVisible();
		await expect(slot).toContainText('fragt'); // the profile line
		const tile = (await slot.locator('.tile').boundingBox())!;
		const cell = (await slot.boundingBox())!;
		expect(Math.round(tile.height)).toBe(Math.round(cell.height));
		expect(Math.round(cell.height)).toBe(308);

		await page.keyboard.press('j');
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(new RegExp(`${ticket.path}\\?run=`));
	});
});

test.describe('the line clamp and the "mehr" link', () => {
	const ONE_PARAGRAPH = 'Die Umsetzung weicht ab. '.repeat(80).trim();
	const WIDTHS = [
		{ width: 1440, height: 900, lines: 3 },
		{ width: 375, height: 667, lines: 2 }
	];

	for (const { width, height, lines } of WIDTHS) {
		test(`a 2,000-character single paragraph is cut at ${lines} lines at ${width} px and offers "mehr"`, async ({
			page,
			db,
			seedTicket
		}) => {
			await page.setViewportSize({ width, height });
			const ticket = seedTicket(`One long paragraph ${width}`);
			askWithFinding(db, ticket, ONE_PARAGRAPH, '');
			await open(page, '/');

			const slot = tileOf(page, ticket.ref);
			const text = slot.locator('.question');
			await expect(slot.getByRole('link', { name: /^mehr/ })).toBeVisible();
			expect(await text.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(
				lines * (await lineHeightOf(text)) + 1
			);
			if (width >= 760) expect(Math.round((await slot.boundingBox())!.height)).toBe(308);
		});
	}

	test('"mehr" follows what is cut off: shown for 79 characters at 375 px, absent for 88 characters at 1440 px', async ({
		page,
		db,
		seedTicket
	}) => {
		const cutAtPhone =
			'Soll der Export die Kopfzeile auch bei leerer Tabelle schreiben oder weglassen?';
		const fitsAtDesktop = `${'Wort '.repeat(17)}Ende?`;
		expect(cutAtPhone).toHaveLength(79);
		expect(fitsAtDesktop).toHaveLength(90);
		const ticket = seedTicket('Cut at the phone');
		const other = seedTicket('Fits at the desktop');
		askWithFinding(db, ticket, cutAtPhone, '');
		askWithFinding(db, other, fitsAtDesktop, '');

		await page.setViewportSize({ width: 375, height: 667 });
		await open(page, '/');
		await expect(tileOf(page, ticket.ref).getByRole('link', { name: /^mehr/ })).toBeVisible();

		await page.setViewportSize({ width: 1440, height: 900 });
		await expect(tileOf(page, other.ref).getByRole('link', { name: /^mehr/ })).toBeHidden();
	});

	test('"mehr" is a 44 px touch target on a phone', async ({ page, db, seedTicket }) => {
		await page.setViewportSize({ width: 375, height: 667 });
		const ticket = seedTicket('Touch target');
		askWithFinding(db, ticket);
		await open(page, '/');
		const more = tileOf(page, ticket.ref).getByRole('link', { name: /^mehr/ });
		expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	});
});
