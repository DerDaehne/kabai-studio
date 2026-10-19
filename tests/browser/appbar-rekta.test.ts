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
