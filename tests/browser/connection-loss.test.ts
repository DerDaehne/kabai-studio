import type { Page } from '@playwright/test';
import { expect, open, test } from './fixtures.ts';

const banner = (page: Page) => page.locator('.rk-banner');
const barWord = (page: Page) =>
	page.getByRole('contentinfo', { name: 'App-Leiste' }).locator('.rk-ab-k');

async function expectLost(page: Page) {
	await expect(banner(page).locator('[role="status"]')).toContainText('Getrennt');
	await expect(barWord(page)).toHaveText('getrennt');
}

async function expectConnected(page: Page) {
	await expect(banner(page).locator('[role="status"]')).toBeEmpty();
	await expect(barWord(page)).not.toHaveText('getrennt');
}

test('losing the network shows "Getrennt", and getting it back clears it and opens the stream again', async ({
	page,
	context
}) => {
	await open(page, '/');
	const streams: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/api/events')) streams.push(request.url());
	});
	await expectConnected(page);

	await context.setOffline(true);
	await expectLost(page);

	await context.setOffline(false);
	await expectConnected(page);
	await expect.poll(() => streams.length).toBeGreaterThan(0);
});

test('a stream that hangs without an error is lost once no data comes for longer than a heartbeat and its grace', async ({
	page
}) => {
	await page.clock.install();
	await open(page, '/');
	await expectConnected(page);
	await page.route('**/api/events**', () => {
		// never answers: the request stays pending like a connection the network dropped silently
	});
	await page.evaluate(() => {
		window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
		window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
	});
	await page.clock.runFor(20_000);
	await expectConnected(page);

	await page.clock.runFor(20_000);
	await expectLost(page);
});
