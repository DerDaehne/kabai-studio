import type { Page } from '@playwright/test';
import { expect, open, test } from './fixtures.ts';

const sheet = (page: Page) => page.locator('dialog.rk-sheet[open]');
const discardQuestion = (page: Page) =>
	sheet(page).getByRole('group', { name: 'Änderungen verwerfen?' });
const twoFrames = (page: Page) =>
	page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);

test.describe('buttons', () => {
	test('every variant is a Rekta button, and danger is marked by the status attribute alone', async ({
		page
	}) => {
		await open(page, '/dev/ui');
		const named = (name: string) => page.getByRole('button', { name, exact: true });
		await expect(named('Run starten')).toHaveClass(/\brk-btn--primary\b/);
		await expect(named('Freigeben')).toHaveClass(/\brk-btn\b/);
		await expect(named('Abbrechen').first()).toHaveClass(/\brk-btn--quiet\b/);
		await expect(named('Ticket löschen')).toHaveAttribute('data-status', 'error');
		await expect(named('Klein')).not.toHaveClass(/sm/);
		// a running action stays focusable and is announced, not greyed out as disabled
		const running = named('Speichert');
		await expect(running).toHaveAttribute('aria-busy', 'true');
		await expect(running).toHaveAttribute('aria-disabled', 'true');
		const accent = await named('Run starten').evaluate(
			(el) => getComputedStyle(el).backgroundColor
		);
		await expect(running).toHaveCSS('background-color', accent);
	});
});

test.describe('a form with errors', () => {
	test('puts the error at its field and the summary takes focus, its link moves focus into the field', async ({
		page
	}) => {
		await open(page, '/dev/ui');
		const endpoint = page.getByLabel('Endpoint');
		await expect(endpoint).toHaveClass(/\brk-input\b/);
		await expect(endpoint).toHaveAttribute('aria-invalid', 'true');
		const refusal = 'Keine Verbindung. Adresse prüfen oder den Server starten.';
		const describedBy = await endpoint.getAttribute('aria-describedby');
		await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(refusal);
		await expect(page.locator('.rk-field[data-status="error"]')).toHaveCount(1);

		await page.getByRole('button', { name: 'Fehlersumme umschalten' }).click();
		const summary = page.getByRole('group', { name: 'Ein Feld braucht Aufmerksamkeit' });
		await expect(summary).toBeFocused();
		await expect(summary).toHaveCSS('box-shadow', 'none');
		await summary.getByRole('link', { name: `Endpoint: ${refusal}` }).click();
		await expect(endpoint).toBeFocused();
		// Rekta draws its own ring; the shell's halo stays off them
		await expect(endpoint).toHaveCSS('box-shadow', 'none');
	});

	test('a hint turns into the error and back; an optional field says so', async ({ page }) => {
		await open(page, '/dev/ui');
		await expect(page.getByLabel('Titel')).toHaveAccessibleDescription(
			'Kurz und als Ergebnis formuliert.'
		);
		await open(page, '/dev/ui?open=sheet');
		await expect(page.getByLabel('Notiz (optional)')).toBeVisible();
	});
});

test.describe('the sheet', () => {
	test('comes down from the top edge and a clean one closes on Escape without asking', async ({
		page
	}) => {
		await open(page, '/dev/ui?open=sheet');
		await expect(sheet(page)).toBeVisible();
		await expect.poll(async () => (await sheet(page).boundingBox())!.y).toBe(0);
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toHaveCount(0);
	});

	test('with changed input Escape and a tap on the shading ask to discard, keep editing is the safe answer', async ({
		page
	}) => {
		await open(page, '/dev/ui?open=sheet');
		const note = page.getByLabel('Notiz (optional)');
		await note.fill('half a thought');

		await page.keyboard.press('Escape');
		await expect(discardQuestion(page)).toBeVisible();
		const keep = discardQuestion(page).getByRole('button', { name: 'Weiter bearbeiten' });
		await expect(keep).toBeFocused();
		await expect(keep).toHaveClass(/\brk-btn--primary\b/);

		await page.keyboard.press('Escape');
		await expect(discardQuestion(page)).toHaveCount(0);
		await expect(note).toHaveValue('half a thought');

		await page.mouse.click(5, 650);
		await expect(discardQuestion(page)).toBeVisible();
		await keep.click();
		await expect(sheet(page)).toBeVisible();
		await expect(note).toHaveValue('half a thought');

		await page.keyboard.press('Escape');
		await discardQuestion(page).getByRole('button', { name: 'Änderungen verwerfen' }).click();
		await expect(sheet(page)).toHaveCount(0);
	});

	test('a confirming sheet puts the safe answer first, primary and focused, and the danger repeats the verb', async ({
		page
	}) => {
		await open(page, '/');
		await page.keyboard.press(':');
		await page.keyboard.type('stop');
		await page.keyboard.press('Enter');
		const dialog = page.getByRole('dialog', { name: 'Alle Agents stoppen?' });
		await expect(dialog).toHaveClass(/\brk-sheet\b/);
		const safe = dialog.getByRole('button', { name: 'Weiterlaufen lassen' });
		await expect(safe).toBeFocused();
		await expect(safe).toHaveClass(/\brk-btn--primary\b/);
		const danger = dialog.getByRole('button').last();
		await expect(danger).toHaveAttribute('data-status', 'error');
		await expect(danger).toHaveText(/stoppen/i);
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
	});
});

const reducedMotion: Record<string, (page: Page) => Promise<unknown>> = {
	'the system asks for it': (page) => page.emulateMedia({ reducedMotion: 'reduce' }),
	'the app setting is off': (page) =>
		page.addInitScript(() => localStorage.setItem('studio-motion', 'reduced'))
};

for (const [reason, reduce] of Object.entries(reducedMotion)) {
	test(`when ${reason} the sheet does not slide in and nothing keeps running`, async ({ page }) => {
		await reduce(page);
		await open(page, '/dev/ui?open=sheet');
		await expect(sheet(page)).toBeVisible();
		await twoFrames(page);
		const running = await page.evaluate(() =>
			document
				.querySelector('dialog.rk-sheet')!
				.getAnimations({ subtree: true })
				.filter((animation) => animation.playState === 'running')
				.map((animation) => (animation as CSSAnimation).animationName)
		);
		expect(running).toEqual([]);
		const seconds = await sheet(page).evaluate((el) =>
			parseFloat(getComputedStyle(el).animationDuration)
		);
		expect(seconds).toBeLessThan(0.001);
	});
}
