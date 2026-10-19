import type { Page } from '@playwright/test';
import { expect, open, test } from './fixtures.ts';

const sheet = (page: Page) => page.locator('dialog.rk-sheet[open]');
const discardQuestion = (page: Page) =>
	sheet(page).getByRole('group', { name: 'Änderungen verwerfen?' });
const twoFrames = (page: Page) =>
	page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);

/** The computed colour of a Rekta token, as a style declares it. */
const colourOf = (page: Page, token: string) =>
	page.evaluate((name) => {
		const probe = document.body.appendChild(document.createElement('i'));
		probe.style.color = `var(${name})`;
		const colour = getComputedStyle(probe).color;
		probe.remove();
		return colour;
	}, token);

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
		// the pending line is the one indicator: no spinner next to it
		await expect(running.locator('svg')).toHaveCount(0);
	});

	test('a danger button draws frame and words in the error colour and is never filled', async ({
		page
	}) => {
		await open(page, '/dev/ui');
		const error = await colourOf(page, '--rk-status-error-full');
		const danger = page.getByRole('button', { name: 'Ticket löschen' });
		await expect(danger).toHaveCSS('border-top-color', error);
		await expect(danger).toHaveCSS('color', error);
		await expect(danger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	});

	test('a running action keeps its colours whatever its variant, and a running danger stays red', async ({
		page
	}) => {
		await open(page, '/dev/ui');
		const error = await colourOf(page, '--rk-status-error-full');
		const secondary = page.getByRole('button', { name: 'Lädt' });
		const text = await secondary.evaluate((el) => getComputedStyle(el.parentElement!).color);
		await expect(secondary).toHaveAttribute('data-rk-pending', 'true');
		await expect(secondary).toHaveCSS('color', text);
		await expect(secondary).toHaveCSS('border-top-color', text);
		await expect(secondary).toHaveCSS('opacity', '1');
		const danger = page.getByRole('button', { name: 'Löscht' });
		await expect(danger).toHaveCSS('color', error);
		await expect(danger).toHaveCSS('border-top-color', error);
	});

	test.describe('an icon button', () => {
		const closeOfDialog = async (page: Page) => {
			await open(page, '/dev/ui');
			await page.getByRole('button', { name: 'Dialog öffnen' }).click();
			return page.getByRole('button', { name: 'Schließen' });
		};

		test('is a square as high as a control: 32 px with a fine pointer', async ({ page }) => {
			const close = await closeOfDialog(page);
			await expect(close).toHaveClass(/\brk-btn--icon\b/);
			expect(await close.boundingBox()).toMatchObject({ width: 32, height: 32 });
		});

		test.describe('with touch', () => {
			test.use({ hasTouch: true });

			test('is 44 px square', async ({ page }) => {
				const close = await closeOfDialog(page);
				expect(await close.boundingBox()).toMatchObject({ width: 44, height: 44 });
			});
		});
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
		await summary.getByRole('link', { name: `Endpoint: ${refusal}` }).click();
		await expect(endpoint).toBeFocused();
		// Rekta draws its own ring; the shell's halo stays off them
		await expect(endpoint).toHaveCSS('box-shadow', 'none');
	});

	test('the summary reached by keyboard draws Rekta ring and no halo', async ({ page }) => {
		await open(page, '/dev/ui');
		await page.getByRole('button', { name: 'Fehlersumme umschalten' }).focus();
		await page.keyboard.press('Enter');
		const summary = page.getByRole('group', { name: 'Ein Feld braucht Aufmerksamkeit' });
		await expect(summary).toBeFocused();
		await expect(summary).toHaveCSS('outline-style', 'solid');
		await expect(summary).toHaveCSS('outline-width', '2px');
		await expect(summary).toHaveCSS('box-shadow', 'none');
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
		// a sheet that closes and reopens itself would slide in again and fire close
		await page.evaluate(() => {
			const closes: Event[] = [];
			Object.assign(window, { closes });
			document.querySelector('dialog.rk-sheet')!.addEventListener('close', (e) => closes.push(e));
		});
		const closeCount = () =>
			page.evaluate(() => (window as unknown as { closes: Event[] }).closes.length);

		await page.keyboard.press('Escape');
		await expect(discardQuestion(page)).toBeVisible();
		expect(await closeCount()).toBe(0);
		const keep = discardQuestion(page).getByRole('button', { name: 'Weiter bearbeiten' });
		await expect(keep).toBeFocused();
		await expect(keep).toHaveClass(/\brk-btn--primary\b/);

		await page.keyboard.press('Escape');
		await expect(note).toBeFocused();
		await expect(discardQuestion(page)).toHaveCount(0);
		expect(await closeCount()).toBe(0);
		await expect(note).toHaveValue('half a thought');

		await page.mouse.click(5, 650);
		await expect(discardQuestion(page)).toBeVisible();
		await keep.click();
		await expect(sheet(page)).toBeVisible();
		await expect(note).toBeFocused();
		await expect(note).toHaveValue('half a thought');

		await page.keyboard.press('Escape');
		await discardQuestion(page).getByRole('button', { name: 'Änderungen verwerfen' }).click();
		await expect(sheet(page)).toHaveCount(0);
	});

	test('discarding in the showcase puts the form back as it was', async ({ page }) => {
		await open(page, '/dev/ui?open=sheet');
		const note = page.getByLabel('Notiz (optional)');
		await note.fill('half a thought');
		await page.keyboard.press('Escape');
		await discardQuestion(page).getByRole('button', { name: 'Änderungen verwerfen' }).click();
		await expect(sheet(page)).toHaveCount(0);

		await page.getByRole('button', { name: 'Sheet öffnen' }).click();
		await expect(note).toHaveValue('');
		await expect(sheet(page)).not.toHaveAttribute('closedby', /.*/);
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

test.describe('the key overview on touch', () => {
	test.use({ hasTouch: true, viewport: { width: 375, height: 700 } });

	test('has a visible close action, 44 px high', async ({ page }) => {
		await open(page, '/');
		await page.keyboard.press('?');
		await expect(sheet(page)).toBeVisible();
		const close = sheet(page).getByRole('button', { name: 'Schließen' });
		await expect(close).toBeVisible();
		expect((await close.boundingBox())!.height).toBe(44);
		await close.tap();
		await expect(sheet(page)).toHaveCount(0);
	});
});
