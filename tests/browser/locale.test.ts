import { expect, test } from './fixtures.ts';
import { OWNER } from './global-setup.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const LANGUAGES = [
	{
		acceptLanguage: 'en',
		lang: 'en',
		heading: 'kabai studio — Sign in',
		password: 'Password',
		submit: 'Sign in',
		wrongPassword: 'Wrong name or password.',
		attribution: 'Free software'
	},
	{
		acceptLanguage: 'de',
		lang: 'de',
		heading: 'kabai studio — Anmelden',
		password: 'Passwort',
		submit: 'Anmelden',
		wrongPassword: 'Name oder Passwort falsch.',
		attribution: 'Freie Software'
	}
];

for (const language of LANGUAGES) {
	test.describe(`with Accept-Language: ${language.acceptLanguage}`, () => {
		// The browser language is what Chromium sends as Accept-Language.
		test.use({ locale: language.acceptLanguage });

		test('the server renders the login page and its errors in that language, with a matching <html lang>', async ({
			page
		}) => {
			const response = await page.goto('/login');
			const html = await response!.text();
			expect(html).toContain(`<html lang="${language.lang}">`);
			expect(html).toContain(language.heading);
			await expect(page.locator('html')).toHaveAttribute('lang', language.lang);
			await expect(page.getByRole('heading', { level: 1 })).toHaveText(language.heading);
			await expect(page.getByText(language.attribution)).toBeVisible();

			await page.getByLabel('Name').fill(OWNER.name);
			await page.getByLabel(language.password).fill('not-the-owner-password');
			await page.getByRole('button', { name: language.submit }).click();
			await expect(page.getByRole('alert')).toContainText(language.wrongPassword);
		});
	});
}
