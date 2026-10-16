import type { Page } from '@playwright/test';
import { expect, open, test } from './fixtures.ts';
import { pageOverflowX } from './widths.ts';

const PHONE = { width: 375, height: 667 };
const DESKTOP = { width: 1440, height: 900 };

const barOf = (page: Page) => page.getByRole('contentinfo', { name: 'App-Leiste' });
const banner = (page: Page) => page.locator('.rk-banner');
const toastOf = (page: Page) => page.locator('.rk-toast');

async function command(page: Page, line: string, dialog: string) {
	await page.keyboard.press(':');
	await page.keyboard.type(line);
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: dialog })).toBeVisible();
	await page.keyboard.press('y');
}

const bannerHeight = (page: Page) =>
	page.evaluate(() =>
		parseFloat(document.documentElement.style.getPropertyValue('--rk-banner-h') || '0')
	);

test('the shell root carries the Rekta classes and the product sets the toast window to 10 s', async ({
	page
}) => {
	await open(page, '/');
	await expect(page.locator('.rk #main')).toHaveCount(1);
	const window = await page.evaluate(() =>
		getComputedStyle(document.documentElement).getPropertyValue('--rk-duration-toast')
	);
	expect(window.trim()).toMatch(/^(10000ms|10s)$/);
	await expect(barOf(page)).toHaveClass(/\brk-appbar\b/);
});

for (const viewport of [PHONE, DESKTOP]) {
	test(`at ${viewport.width} px the app bar is 56 px high, never scrolls sideways and moves what does not fit into "mehr"`, async ({
		page
	}) => {
		await page.setViewportSize(viewport);
		await open(page, '/');
		const bar = barOf(page);
		const narrow = viewport.width === PHONE.width;

		expect((await bar.boundingBox())!.height).toBe(56);
		expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
		expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
		await expect(bar.getByRole('button', { name: 'befehl' })).toBeVisible();
		await expect(bar.locator('.rk-ab-status')).toBeVisible();

		const more = bar.getByRole('button', { name: 'mehr' });
		if (!narrow) {
			await expect(more).toBeHidden();
			await expect(bar.locator('[data-rk-overflow]')).toHaveCount(0);
			return;
		}
		await expect(bar.getByRole('button', { name: 'zurück' })).toBeVisible();
		await expect(bar.getByRole('button', { name: 'anhalten' })).toBeHidden();
		await expect(bar.locator('[data-rk-overflow]')).toHaveCount(3);

		await more.click();
		const menu = page.getByRole('menu');
		await expect(menu.getByRole('menuitem')).toHaveText(['anhalten', 'not-aus', 'tasten']);
		await page.keyboard.press('ArrowDown');
		await expect(menu.getByRole('menuitem').first()).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(menu).toBeHidden();
		await expect(more).toBeFocused();

		await more.click();
		await menu.getByRole('menuitem', { name: 'tasten' }).click();
		await expect(page.getByRole('dialog', { name: 'Alle Tasten' })).toBeVisible();
	});
}

test('a pause shows in the banner as a polite status, a stop as an alert; the bar follows and --rk-banner-h is published', async ({
	page
}) => {
	await page.setViewportSize(DESKTOP);
	await open(page, '/');
	const bar = barOf(page);
	expect(await bannerHeight(page)).toBe(0);

	await bar.getByRole('button', { name: 'anhalten' }).click();
	await page.getByRole('button', { name: 'Anhalten (y)' }).click();
	await expect(banner(page).locator('[role="status"]')).toContainText('Angehalten');
	await expect(banner(page).locator('[role="alert"]')).toBeEmpty();
	await expect(bar).toHaveAttribute('data-rk-state', 'paused');
	await expect.poll(() => bannerHeight(page)).toBeGreaterThan(0);

	await banner(page).getByRole('button', { name: 'Fortsetzen' }).click();
	await expect(bar).not.toHaveAttribute('data-rk-state', /./);
	await expect.poll(() => bannerHeight(page)).toBe(0);

	await bar.getByRole('button', { name: 'not-aus' }).click();
	await page.getByRole('button', { name: 'Stoppen (y)' }).click();
	await expect(banner(page).locator('[role="alert"]')).toContainText('Gestoppt');
	await expect(banner(page).locator('[role="status"]')).toBeEmpty();
	await expect(bar).toHaveAttribute('data-rk-state', 'halted');
	// the sticky head sits under the banner, not behind it
	const head = (await page.getByRole('banner').first().boundingBox())!;
	expect(head.y).toBeGreaterThanOrEqual(await bannerHeight(page));

	await page.keyboard.press(':');
	await page.keyboard.type('fortsetzen all');
	await page.keyboard.press('Enter');
	await expect(banner(page)).toHaveAttribute('data-rk-phase', 'clear');
});

test.describe('the toast', () => {
	test.beforeEach(async ({ page }) => {
		await page.clock.install();
		await open(page, '/dev/ui');
	});

	const undoDemo = (page: Page) => page.getByRole('button', { name: 'Rückgängig-Meldung' });
	const count = (page: Page) => toastOf(page).locator('.rk-toast-count');

	test('shows one at a time, counts a 10 s undo window down in view and holds it while the pointer rests on it', async ({
		page
	}) => {
		await undoDemo(page).click();
		await expect(count(page)).toHaveText('10');
		await page.clock.runFor(3_000);
		await expect(count(page)).toHaveText('7');

		await toastOf(page).hover();
		await page.clock.runFor(30_000);
		await expect(count(page)).toHaveText('7');

		await page.mouse.move(0, 0);
		await page.clock.runFor(8_000);
		await expect(toastOf(page)).toHaveCount(0);

		await undoDemo(page).click();
		await page.getByRole('button', { name: 'Info-Meldung' }).click();
		await expect(toastOf(page)).toHaveCount(1);
		await expect(toastOf(page)).toContainText('Run STU-41 gestartet');
	});

	test('an error goes after the same window instead of staying for good', async ({ page }) => {
		await page.getByRole('button', { name: 'Fehler', exact: true }).click();
		await expect(toastOf(page)).toHaveAttribute('data-tone', 'error');
		await page.clock.runFor(9_500);
		await expect(toastOf(page)).toHaveCount(1);
		await page.clock.runFor(1_000);
		await expect(toastOf(page)).toHaveCount(0);
	});

	test('Ctrl+Z takes back while the window is open, but not inside a text field', async ({
		page
	}) => {
		await undoDemo(page).click();
		await page.evaluate(() => {
			const field = Object.assign(document.createElement('input'), { id: 'probe' });
			document.body.append(field);
			field.focus();
		});
		await page.keyboard.press('Control+z');
		await expect(toastOf(page)).toContainText('Ticket STU-12 gelöscht');

		await page.locator('#probe').blur();
		await page.keyboard.press('Control+z');
		await expect(toastOf(page)).toContainText('STU-12 zurückgeholt');
	});

	test('Escape closes a toast that has focus and hands the focus back to the page', async ({
		page
	}) => {
		await undoDemo(page).click();
		await toastOf(page)
			.getByRole('button', { name: /Rückgängig/ })
			.focus();
		await page.keyboard.press('Escape');
		await expect(toastOf(page)).toHaveCount(0);
		await expect(page.locator('#main')).toBeFocused();
	});

	test('stands still under reduced motion: no animation runs in the toast or the bar', async ({
		page
	}) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await undoDemo(page).click();
		await expect(toastOf(page)).toHaveCount(1);
		const running = await page.evaluate(() =>
			document
				.getAnimations()
				.filter((animation) => animation.playState === 'running')
				.filter((animation) => Number(animation.effect?.getComputedTiming().duration) > 1)
				.map((animation) => (animation.effect as KeyframeEffect).target)
				.filter((target) => target?.closest('.rk-toasts, .rk-appbar, .rk-banner'))
				.map((target) => target!.className)
		);
		expect(running).toEqual([]);
	});
});

test.describe('the crumb', () => {
	const crumb = (page: Page) => page.locator('.rk-crumb');

	for (const [path, parent, label] of [
		['/p/__KEY__', '/projects', 'Alle Projekte'],
		['/p/__KEY__/t/__NUMBER__', '/board', 'Board'],
		['/settings/profiles', '/settings', 'Einstellungen'],
		['/settings/profiles/new', '/settings/profiles', 'Agent-Profile'],
		['/settings/secrets', '/settings', 'Einstellungen']
	] as const) {
		test(`${path} starts with a crumb to ${label}`, async ({ page, seedTicket }) => {
			const ticket = seedTicket('A ticket with a crumb');
			const [, , key, , number] = ticket.path.split('/');
			await open(page, path.replace('__KEY__', key).replace('__NUMBER__', number));
			await expect(crumb(page)).toHaveCount(1);
			await expect(crumb(page)).toHaveAttribute('href', parent);
			await expect(crumb(page)).toHaveText(label);
		});
	}

	test('goes back when the parent is the previous entry and forward when it is not', async ({
		page,
		seedTicket
	}) => {
		const ticket = seedTicket('Where the crumb leads');
		const entries = () => page.evaluate(() => history.length);

		await open(page, '/board');
		await page.evaluate((path) => {
			const link = Object.assign(document.createElement('a'), { href: path });
			document.body.append(link);
			link.click();
		}, ticket.path);
		await expect(page).toHaveURL(ticket.path);
		const before = await entries();
		await page.locator('.rk-crumb').click();
		await expect(page).toHaveURL('/board');
		expect(await entries(), 'back adds no entry').toBe(before);

		await open(page, ticket.path); // a cold entry: the board is not below it
		const cold = await entries();
		await page.locator('.rk-crumb').click();
		await expect(page).toHaveURL('/board');
		expect(await entries(), 'forward adds an entry').toBe(cold + 1);
	});
});
