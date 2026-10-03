import { expect, open, test } from './fixtures.ts';

test('? opens the overview of all keys and Escape closes it again', async ({ page }) => {
	await open(page, '/');
	const overview = page.getByRole('dialog', { name: 'Alle Tasten' });

	await page.keyboard.press('?');
	await expect(overview).toBeVisible();
	await expect(overview.getByRole('region', { name: 'Bearbeiten' })).toContainText(
		'Spalte weiter/zurück'
	);

	await page.keyboard.press('Escape');
	await expect(overview).toBeHidden();
});

test('g-prefixed keys switch views, and the key bar shows the pending prefix until it completes', async ({
	page
}) => {
	await open(page, '/');
	const keyBar = page.getByRole('list', { name: 'Gültige Tasten' });

	await page.keyboard.press('g');
	await expect(keyBar).toContainText('abbrechen');
	await expect(keyBar).not.toContainText('Suche');
	await page.keyboard.press('t');
	await expect(page).toHaveURL('/takt');
	await expect(keyBar).not.toContainText('abbrechen');
	await expect(keyBar).toContainText('Suche');

	await page.keyboard.press('g');
	await page.keyboard.press('b');
	await expect(page).toHaveURL('/board');

	await page.keyboard.press('g');
	await page.keyboard.press('s');
	await expect(page).toHaveURL('/');
});
