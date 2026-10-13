import { resolveVersion } from '../../src/lib/version.ts';
import { expect, open, test } from './fixtures.ts';

const SOURCE = 'https://github.com/DerDaehne/kabai-studio';

test('settings › about names the project, author, licence, source and version', async ({
	page
}) => {
	await open(page, '/settings');
	const about = page.getByRole('region', { name: 'Über kabai studio' });
	await expect(about.getByRole('link', { name: 'kabai-studio' })).toHaveAttribute('href', SOURCE);
	await expect(about).toContainText('DerDaehne');
	await expect(about).toContainText('AGPL-3.0');
	await expect(about.getByRole('link', { name: /Lizenztext/ })).toHaveAttribute(
		'href',
		`${SOURCE}/blob/main/LICENSE`
	);
	await expect(about).toContainText(`Version ${resolveVersion()}`);
});

test(':info leads to settings › about', async ({ page }) => {
	await open(page, '/board');
	await page.keyboard.press(':');
	await page.keyboard.type('info');
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL('/settings#about');
	await expect(page.getByRole('heading', { name: 'Über kabai studio' })).toBeInViewport();
});
