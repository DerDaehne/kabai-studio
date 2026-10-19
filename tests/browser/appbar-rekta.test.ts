import type { Page } from '@playwright/test';
import { expect, open, test } from './fixtures.ts';

const barOf = (page: Page) => page.getByRole('contentinfo', { name: 'App-Leiste' });

test('befehl is pinned: it stays in the bar at widths where everything else has moved into "mehr"', async ({
	page
}) => {
	await open(page, '/');
	const bar = barOf(page);
	await expect(bar.getByRole('button', { name: 'befehl' })).toHaveAttribute(
		'data-rk-priority',
		'pinned'
	);
	for (const width of [375, 320]) {
		await page.setViewportSize({ width, height: 667 });
		await expect(bar.getByRole('button', { name: 'mehr' })).toBeVisible();
		await expect(bar.getByRole('button', { name: 'befehl' })).toBeVisible();
		await expect(bar.getByRole('button', { name: 'befehl' })).not.toHaveAttribute(
			'data-rk-overflow'
		);
	}
});

test('a runner word that grows makes the bar move controls into "mehr" without a resize', async ({
	page
}) => {
	await open(page, '/');
	const bar = barOf(page);
	const moved = bar.locator('[data-rk-overflow]');
	// Narrowest width at which "frei" still fits without moving anything (the bar re-measures on resize)
	const movesAt = async (width: number) => {
		await page.setViewportSize({ width, height: 700 });
		await page.waitForTimeout(80);
		return (await moved.count()) > 0;
	};
	let [tooNarrow, fits] = [375, 1440];
	while (fits - tooNarrow > 1) {
		const middle = Math.floor((tooNarrow + fits) / 2);
		if (await movesAt(middle)) tooNarrow = middle;
		else fits = middle;
	}
	await page.setViewportSize({ width: fits, height: 700 });
	await expect(moved).toHaveCount(0);

	await bar.getByRole('button', { name: 'anhalten' }).click();
	await page.getByRole('button', { name: 'Anhalten (y)' }).click();
	await expect(bar.locator('.rk-ab-k')).toHaveText('angehalten');
	await expect(moved).not.toHaveCount(0);
	await expect(bar.getByRole('button', { name: 'mehr' })).toBeVisible();
});

/** Holds every Barlow file until `release()`, so the bar is first measured with the fallback font. */
async function holdFonts(page: Page) {
	const held: (() => Promise<void>)[] = [];
	await page.route('**/fonts/barlow/*.woff2', (route) => void held.push(() => route.continue()));
	return async () => {
		for (const continueRoute of held.splice(0)) await continueRoute();
	};
}

const movedControls = (page: Page) => barOf(page).locator('[data-rk-overflow]');

/** Narrowest width at which nothing moves into "mehr"; the bar re-measures on every resize. */
async function narrowestWithoutOverflow(page: Page) {
	let [tooNarrow, fits] = [375, 1440];
	while (fits - tooNarrow > 1) {
		const middle = Math.floor((tooNarrow + fits) / 2);
		await page.setViewportSize({ width: middle, height: 700 });
		await page.waitForTimeout(80);
		if ((await movedControls(page).count()) > 0) tooNarrow = middle;
		else fits = middle;
	}
	return fits;
}

test('the overflow is measured again once the font has loaded', async ({ page, context }) => {
	const probe = await context.newPage();
	await holdFonts(probe);
	await probe.goto('/', { waitUntil: 'commit' }); // a held font keeps the load event back
	await expect(barOf(probe)).toBeVisible();
	const fallbackFits = await narrowestWithoutOverflow(probe);
	await probe.close();
	await open(page, '/');
	const barlowFits = await narrowestWithoutOverflow(page);
	expect(fallbackFits, 'the fallback font is wider than Barlow').toBeGreaterThan(barlowFits);

	const width = Math.floor((fallbackFits + barlowFits) / 2);
	const late = await context.newPage();
	const releaseFonts = await holdFonts(late);
	await late.setViewportSize({ width, height: 700 });
	await late.goto('/', { waitUntil: 'commit' });
	await expect(barOf(late)).toBeVisible();
	await expect(movedControls(late)).not.toHaveCount(0);
	await releaseFonts();
	await expect(movedControls(late)).toHaveCount(0);
});

test('a bar that is gone before the fonts are ready is not measured again', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
	await page.addInitScript(() => {
		const measured = { count: 0 };
		Object.assign(window, { measured });
		const querySelectorAll = Element.prototype.querySelectorAll;
		Element.prototype.querySelectorAll = function (selector: string) {
			if (selector === ':scope > [data-rk-overflow]') measured.count++;
			return querySelectorAll.call(this, selector);
		};
		let fontsReady!: () => void;
		const ready = new Promise<void>((resolve) => (fontsReady = resolve));
		Object.defineProperty(document, 'fonts', { value: { ready } });
		Object.assign(window, { fontsReady });
	});
	await open(page, '/');
	await expect(barOf(page)).toBeVisible();
	// without a session the next navigation ends on the login page, which has no bar
	await page.context().clearCookies();
	await page.evaluate(() => {
		const link = document.createElement('a');
		link.href = '/board';
		document.body.append(link);
		link.click();
	});
	await expect(barOf(page)).toHaveCount(0);
	const before = await page.evaluate(() => (window as any).measured.count as number);
	await page.evaluate(() => (window as any).fontsReady());
	await page.waitForTimeout(200);
	expect(await page.evaluate(() => (window as any).measured.count as number)).toBe(before);
	expect(errors).toEqual([]);
});
