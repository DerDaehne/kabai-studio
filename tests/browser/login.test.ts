import { expect, test } from './fixtures.ts';
import { OWNER } from './global-setup.ts';

test.use({ storageState: { cookies: [], origins: [] } });

test('signing in leads from the login form to the Stellwerk, after a wrong password shows its way out', async ({
	page
}) => {
	await page.goto('/');
	await expect(page).toHaveURL('/login');

	await page.getByLabel('Name').fill(OWNER.name);
	await page.getByLabel('Passwort').fill('not-the-owner-password');
	await page.getByRole('button', { name: 'Anmelden' }).click();
	await expect(page.getByRole('alert')).toContainText('npm run reset-password');

	await page.getByLabel('Passwort').fill(OWNER.password);
	await page.getByRole('button', { name: 'Anmelden' }).click();
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('link', { name: 'kabai studio', exact: true })).toHaveAttribute(
		'aria-current',
		'page'
	);
});
