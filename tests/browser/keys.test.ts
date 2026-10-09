import { expect, open, test } from './fixtures.ts';

test('? opens the overview of all keys with the ones valid here first, and Escape closes it again', async ({
	page
}) => {
	await open(page, '/');
	const overview = page.getByRole('dialog', { name: 'Alle Tasten' });

	await page.keyboard.press('?');
	await expect(overview).toBeVisible();
	await expect(overview.getByRole('list', { name: 'Gültige Tasten' })).toContainText('Suche');
	await expect(overview.getByRole('region', { name: 'Bearbeiten' })).toContainText(
		'Spalte weiter/zurück'
	);

	await page.keyboard.press('Escape');
	await expect(overview).toBeHidden();
});

test('g-prefixed keys switch views, and the app bar shows the pending prefix until it completes', async ({
	page
}) => {
	await open(page, '/');
	const appBar = page.getByRole('contentinfo', { name: 'App-Leiste' });

	await page.keyboard.press('g');
	await expect(appBar).toContainText('abbrechen');
	await page.keyboard.press('t');
	await expect(page).toHaveURL('/takt');
	await expect(appBar).not.toContainText('abbrechen');

	await page.keyboard.press('g');
	await page.keyboard.press('b');
	await expect(page).toHaveURL('/board');

	await page.keyboard.press('g');
	await page.keyboard.press('s');
	await expect(page).toHaveURL('/');
});
