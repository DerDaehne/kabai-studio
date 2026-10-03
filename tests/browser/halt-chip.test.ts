import type { Page } from '@playwright/test';
import { expect, open, queueRun, test } from './fixtures.ts';

async function haltViaCommand(page: Page) {
	await page.keyboard.press(':');
	await page.keyboard.type('anhalten');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: 'Alle Agents anhalten?' })).toBeVisible();
	await page.keyboard.press('y');
}

async function releaseViaCommand(page: Page) {
	await page.keyboard.press(':');
	await page.keyboard.type('fortsetzen');
	await page.keyboard.press('Enter');
}

const chipOf = (view: Page) => view.getByText(/Angehalten · \d+ wartend/);

test('the halt chip appears after :anhalten at every width and disappears with a toast after :fortsetzen, live in a second tab', async ({
	page,
	browser,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Keep working while halted');
	fakeModel.reply('hang');

	const wideContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
	const wide = await wideContext.newPage();

	await open(page, '/'); // default viewport is 1280 px
	await open(wide, '/');

	await queueRun(db, page, ticket.id, fakeModel);
	await expect(page.getByText(/^Fake model/)).toBeVisible();

	await haltViaCommand(page);

	// A phone tab opened only after the halt: its layout load, not a live event, must carry the halted state.
	const phoneContext = await browser.newContext({ viewport: { width: 375, height: 667 } });
	const phone = await phoneContext.newPage();
	await open(phone, '/');

	for (const view of [page, wide, phone]) {
		await expect(chipOf(view)).toHaveText('Angehalten · 0 wartend');
		await expect(view.getByRole('button', { name: 'Fortsetzen' })).toBeVisible();
	}

	await releaseViaCommand(page);

	for (const view of [page, wide, phone]) {
		await expect(chipOf(view)).toBeHidden();
	}
	await expect(page.getByText('Not-Aus gelöst')).toBeVisible();

	await wideContext.close();
	await phoneContext.close();
});
