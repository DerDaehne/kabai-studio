import type { Page } from '@playwright/test';
import { addTasks } from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { expect, open, test } from './fixtures.ts';
import { pageOverflowX } from './widths.ts';

const HUMAN: Actor = { kind: 'user' };
const PHONE = { width: 375, height: 667 };
const DESKTOP = { width: 1440, height: 900 };
const ULTRAWIDE = { width: 2560, height: 1440 };

const navOf = (page: Page) => page.getByRole('navigation', { name: 'Ansichten' });
const titleOf = (page: Page, name: string) =>
	navOf(page).getByRole('link', { name: new RegExp(`^${name}`, 'i') });
const appBarOf = (page: Page) => page.getByRole('contentinfo', { name: 'App-Leiste' });
const runnerOf = (page: Page) => appBarOf(page).locator('[data-tone]');

type Box = {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
};
type Head = { head: Box; navLeft: number; edge: number; titles: Record<string, Box> };

/** Where the head and each of its titles are drawn right now, scaling included. */
function measureHead(page: Page): Promise<Head> {
	return page.evaluate(() => {
		const nav = document.querySelector('nav[aria-label="Ansichten"]')!;
		const box = (element: Element) => element.getBoundingClientRect().toJSON();
		const titles = [...nav.querySelectorAll('a')].map((link) => [
			link.textContent!.replace(/\d+/g, '').trim().toLowerCase(),
			box(link)
		]);
		return {
			head: box(nav.closest('header')!),
			navLeft: nav.getBoundingClientRect().left,
			edge: nav.getBoundingClientRect().left + parseFloat(getComputedStyle(nav).paddingLeft),
			titles: Object.fromEntries(titles)
		};
	});
}

/** Waits until `active` is current, has glided to the left edge and every size transition has ended. */
async function settledHead(page: Page, active: string): Promise<Head> {
	await expect(titleOf(page, active)).toHaveAttribute('aria-current', 'page');
	await expect
		.poll(async () => {
			const { titles, edge } = await measureHead(page);
			return Math.abs(titles[active].left - edge);
		})
		.toBeLessThanOrEqual(1);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					document
						.querySelector('nav[aria-label="Ansichten"]')!
						.closest('header')!
						.getAnimations({ subtree: true }).length
			)
		)
		.toBe(0);
	return measureHead(page);
}

test('the head pivot keeps its order and height: the active title glides to the left edge, the ones before it scroll out of view, only the old and the new active title change size', async ({
	page
}) => {
	await page.setViewportSize(DESKTOP);
	await open(page, '/');
	const start = await settledHead(page, 'kabai studio');
	expect(start.navLeft, 'the title row reaches the screen edge, nothing clips it earlier').toBe(0);

	await titleOf(page, 'takt').click();
	await expect(page).toHaveURL('/takt');
	const takt = await settledHead(page, 'takt');

	expect(takt.head.height).toBe(start.head.height);
	const before = takt.titles['kabai studio'];
	expect(before.left, 'the title before the active one has scrolled out to the left').toBeLessThan(
		0
	);
	expect(before.right, '…but visibly, not cut off at the gutter').toBeGreaterThan(0);
	expect(takt.titles.takt.height).toBeGreaterThan(start.titles.takt.height * 1.5);
	expect(start.titles['kabai studio'].height).toBeGreaterThan(before.height * 1.5);
	for (const other of ['board', 'projekte', 'einstellungen']) {
		expect(takt.titles[other].width, other).toBeCloseTo(start.titles[other].width, 0);
		expect(takt.titles[other].height, other).toBeCloseTo(start.titles[other].height, 0);
	}

	await titleOf(page, 'einstellungen').click();
	await expect(page).toHaveURL('/settings');
	const last = await settledHead(page, 'einstellungen');
	expect(last.head.height).toBe(start.head.height);
	expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);

	await page.emulateMedia({ reducedMotion: 'reduce' });
	await titleOf(page, 'board').click();
	await expect(titleOf(page, 'board')).toHaveAttribute('aria-current', 'page');
	const twoFramesLater = await page
		.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		)
		.then(() => measureHead(page));
	expect(
		Math.abs(twoFramesLater.titles.board.left - twoFramesLater.edge),
		'with reduced motion the title jumps to the edge instead of gliding'
	).toBeLessThanOrEqual(1);
});

test('the focus ring of the active head title is not cut off by its row', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await open(page, '/');
	await settledHead(page, 'kabai studio');
	await page.keyboard.press('Tab'); // skip link
	await page.keyboard.press('Tab'); // first title, the active one
	await expect(titleOf(page, 'kabai studio')).toBeFocused();
	const clip = await page.evaluate(() => {
		const nav = document.querySelector('nav[aria-label="Ansichten"]')!;
		const link = nav.querySelector('[aria-current]')!;
		const style = getComputedStyle(link);
		const scale = parseFloat(style.scale) || 1;
		const ring = (parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)) * scale;
		const row = nav.getBoundingClientRect();
		const box = link.getBoundingClientRect();
		return {
			ringTop: box.top - ring,
			rowTop: row.top,
			ringBottom: box.bottom + ring,
			rowBottom: row.bottom
		};
	});
	expect(clip.ringTop, 'ring top inside the row').toBeGreaterThanOrEqual(clip.rowTop);
	expect(clip.ringBottom, 'ring bottom inside the row').toBeLessThanOrEqual(clip.rowBottom);
});

for (const [viewport, commands] of [
	[PHONE, ['zurück', 'anhalten', 'not-aus', 'befehl', 'tasten']],
	[DESKTOP, ['anhalten', 'not-aus', 'befehl', 'tasten']],
	[ULTRAWIDE, ['anhalten', 'not-aus', 'befehl', 'tasten']]
] as const) {
	test(`at ${viewport.width} px the app bar sits on the bottom edge with the runner state as a word and labelled commands that open the keys and the command line`, async ({
		page
	}) => {
		await page.setViewportSize(viewport);
		await open(page, '/');
		const bar = appBarOf(page);

		await expect(runnerOf(page)).toHaveText('frei');
		await expect(bar.getByRole('button')).toHaveText([...commands]);
		const barBox = (await bar.boundingBox())!;
		expect(Math.round(barBox.y + barBox.height)).toBe(viewport.height);
		for (const button of await bar.getByRole('button').all()) {
			const box = (await button.boundingBox())!;
			const name = await button.innerText();
			expect(Math.min(box.width, box.height), name).toBeGreaterThanOrEqual(44);
			// a fixed bar never widens the page, so a command cut off at the edge has to be caught here
			expect(box.x + box.width, `${name} lies within the screen`).toBeLessThanOrEqual(
				viewport.width
			);
		}
		expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);

		await bar.getByRole('button', { name: 'tasten' }).click();
		await expect(page.getByRole('dialog', { name: 'Alle Tasten' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Alle Tasten' })).toBeHidden();

		await bar.getByRole('button', { name: 'befehl' }).click();
		await expect(page.getByRole('combobox', { name: 'Befehlszeile' })).toBeFocused();
		const sheet = page.getByRole('dialog', { name: 'Befehlszeile' });
		await expect(sheet).toHaveJSProperty('open', true);
		await expect // the sheet rises into place, so it is measured once it stands still
			.poll(() => sheet.evaluate((dialog) => dialog.getAnimations().length))
			.toBe(0);
		const sheetBox = (await sheet.boundingBox())!;
		expect(sheetBox.y + sheetBox.height, 'the command sheet rests on the bar').toBeCloseTo(
			barBox.y,
			0
		);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Befehlszeile' })).toBeHidden();
	});
}

test('the command sheet closes when the browser goes back to another page', async ({ page }) => {
	await open(page, '/');
	await titleOf(page, 'takt').click();
	await expect(page).toHaveURL('/takt');
	await page.keyboard.press(':');
	const sheet = page.getByRole('dialog', { name: 'Befehlszeile' });
	await expect(sheet).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL('/');
	await expect(sheet).toBeHidden();
});

test('the keys sheet closes when the browser goes back to another page', async ({ page }) => {
	await open(page, '/');
	await titleOf(page, 'takt').click();
	await expect(page).toHaveURL('/takt');
	await page.keyboard.press('?');
	const sheet = page.getByRole('dialog', { name: 'Alle Tasten' });
	await expect(sheet).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL('/');
	await expect(sheet).toBeHidden();
});

test('the halt confirmation sheet closes when the browser goes back to another page', async ({
	page
}) => {
	await open(page, '/');
	await titleOf(page, 'takt').click();
	await expect(page).toHaveURL('/takt');
	await appBarOf(page).getByRole('button', { name: 'anhalten' }).click();
	const sheet = page.getByRole('dialog', { name: 'Alle Agents anhalten?' });
	await expect(sheet).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL('/');
	await expect(sheet).toBeHidden();
});

test('on a phone zurück is the first command and goes back to where you came from', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	await open(page, '/');
	await titleOf(page, 'takt').click();
	await expect(page).toHaveURL('/takt');
	await appBarOf(page).getByRole('button', { name: 'zurück' }).click();
	await expect(page).toHaveURL('/');
});

test.describe('halting from the app bar', () => {
	test.afterEach(async ({ page }) => {
		expect((await page.request.delete('/api/halt')).ok()).toBe(true);
	});

	test('anhalten and not-aus halt every run with one click and a confirmation; the banner names the halt in a word and its Fortsetzen resumes', async ({
		page
	}) => {
		await page.setViewportSize(DESKTOP);
		await open(page, '/');
		const bar = appBarOf(page);
		const banner = page.locator('.halt-banner');

		await bar.getByRole('button', { name: 'anhalten' }).click();
		await page.getByRole('button', { name: 'Anhalten (y)' }).click();
		await expect(banner).toHaveText(/Angehalten · 0 pausiert/);
		await expect(banner).toHaveAttribute('data-tone', 'warning');
		await expect(runnerOf(page)).toHaveText('angehalten');
		await banner.getByRole('button', { name: 'Fortsetzen' }).click();
		await expect(banner).toBeHidden();
		await expect(runnerOf(page)).toHaveText('frei');

		await bar.getByRole('button', { name: 'not-aus' }).click();
		await page.getByRole('button', { name: 'Stoppen (y)' }).click();
		await expect(banner).toHaveText(/Gestoppt · 0 wartend/);
		await expect(banner).toHaveAttribute('data-tone', 'error');
		await expect(runnerOf(page)).toHaveText('not-aus');

		await page.keyboard.press(':');
		await page.keyboard.type('fortsetzen all');
		await page.keyboard.press('Enter');
		await expect(banner).toBeHidden();
		await expect(runnerOf(page)).toHaveText('frei');
	});
});

/** Records the animations of every view transition the page starts, once its pseudo-elements exist. */
function recordViewTransitions() {
	const start = document.startViewTransition.bind(document);
	const seen: string[][] = [];
	Object.assign(window, { viewTransitions: seen });
	document.startViewTransition = (update) => {
		const transition = start(update);
		const record = () =>
			seen.push(
				document
					.getAnimations()
					.map((animation) => animation as CSSAnimation)
					.filter((animation) => animation.animationName)
					.map(
						(animation) => `${animation.animationName} ${animation.effect?.getTiming().duration}`
					)
			);
		transition.ready.then(record, () => seen.push(['skipped']));
		return transition;
	};
}

const viewTransitions = (page: Page) =>
	page.evaluate(() => (window as unknown as { viewTransitions: string[][] }).viewTransitions);

/** Follows a link client-side the way a click on one in the page would, without one having to be on screen. */
function followLink(page: Page, path: string) {
	return page.evaluate((href) => {
		const link = Object.assign(document.createElement('a'), { href });
		document.body.append(link);
		link.click();
		link.remove();
	}, path);
}

test('a change of place turns the page like a turnstile; a change within the same route and reduced motion do not', async ({
	page,
	seedTicket
}) => {
	const first = seedTicket('First of two neighbours');
	const second = seedTicket('Second of two neighbours');
	await page.addInitScript(recordViewTransitions);
	await open(page, '/');

	await titleOf(page, 'takt').click();
	await expect(page).toHaveURL('/takt');
	await expect.poll(() => viewTransitions(page)).toHaveLength(1);
	expect((await viewTransitions(page))[0]).toEqual(
		expect.arrayContaining(['turnstile-out 400', 'turnstile-in 400'])
	);

	await followLink(page, first.path);
	await expect(page).toHaveURL(first.path);
	await expect.poll(() => viewTransitions(page)).toHaveLength(2);
	await followLink(page, second.path);
	await expect(page).toHaveURL(second.path);
	await page.waitForTimeout(500); // long enough for a transition the same route must not start
	expect(await viewTransitions(page)).toHaveLength(2);

	await page.emulateMedia({ reducedMotion: 'reduce' });
	await titleOf(page, 'board').click();
	await expect(page).toHaveURL('/board');
	await page.waitForTimeout(500);
	expect(await viewTransitions(page)).toHaveLength(2);
});

/** Clicks the board title `delayMs` after the first view transition starts, so a navigation interrupts it. */
function interruptFirstViewTransition(delayMs: number) {
	const start = document.startViewTransition.bind(document);
	let interrupted = false;
	document.startViewTransition = (update) => {
		const transition = start(update);
		if (!interrupted) {
			interrupted = true;
			const board = 'nav[aria-label="Ansichten"] a[href="/board"]';
			setTimeout(() => document.querySelector<HTMLAnchorElement>(board)!.click(), delayMs);
		}
		return transition;
	};
}

for (const delayMs of [0, 100, 250]) {
	test(`a navigation ${delayMs} ms into the turnstile of another leaves no error in the console`, async ({
		page
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text());
		});
		await page.addInitScript(interruptFirstViewTransition, delayMs);
		await open(page, '/');

		await page.keyboard.press('g');
		await page.keyboard.press('t');
		await expect(page).toHaveURL('/board');
		await page.waitForTimeout(600); // the interrupted transition settles
		expect(errors).toEqual([]);
	});
}

test('a new place starts at the top, back restores the scroll position, also from the back/forward cache, with the head stuck to the top and the app bar to the bottom', async ({
	page,
	db,
	seedTicket
}) => {
	const ticket = seedTicket('A long ticket to scroll through');
	addTasks(
		db,
		HUMAN,
		ticket.id,
		Array.from({ length: 40 }, (_, index) => `Step ${index + 1}`)
	);
	await page.addInitScript(() =>
		addEventListener('pageshow', (event) => {
			document.documentElement.dataset.restoredFromCache = String(event.persisted);
		})
	);
	await page.setViewportSize({ width: 1440, height: 600 });
	await open(page, ticket.path);
	const scrollY = () => page.evaluate(() => scrollY);

	await page.evaluate(() => scrollTo(0, 500));
	await expect.poll(scrollY).toBe(500);
	expect((await page.getByRole('banner').boundingBox())!.y, 'the head sticks to the top').toBe(0);
	const bar = (await appBarOf(page).boundingBox())!;
	expect(Math.round(bar.y + bar.height), 'the app bar stays on the bottom edge').toBe(600);

	await titleOf(page, 'takt').click();
	await expect(page).toHaveURL('/takt');
	await expect.poll(scrollY).toBe(0);
	await page.goBack();
	await expect(page).toHaveURL(ticket.path);
	await expect.poll(scrollY).toBe(500);

	await open(page, '/board');
	await page.goBack({ waitUntil: 'commit' }); // a page from the cache fires no load event
	await expect(page).toHaveURL(ticket.path);
	await expect(page.locator('html')).toHaveAttribute('data-restored-from-cache', 'true');
	await expect.poll(scrollY).toBe(500);
});

test('every page shows the attribution and has the skip link as its first tab stop', async ({
	page,
	seedTicket
}) => {
	const ticket = seedTicket('Attribution everywhere');
	for (const path of ['/', '/takt', '/board', '/projects', '/settings', ticket.path]) {
		await open(page, path);
		await page.keyboard.press('Tab');
		await expect(page.getByRole('link', { name: 'Zum Inhalt springen' }), path).toBeFocused();
		await expect(page.getByRole('link', { name: 'kabai-studio' }), path).toBeVisible();
	}
});

test('the start view is called kabai studio everywhere, and g s still leads there', async ({
	page
}) => {
	await open(page, '/takt');
	await page.keyboard.press('g');
	await page.keyboard.press('s');
	await expect(page).toHaveURL('/');
	await expect(titleOf(page, 'kabai studio')).toHaveAttribute('aria-current', 'page');

	await page.goto('/no-such-page'); // not a `live`-signed-in page, so checked without the ? overview
	await expect(page.getByText(/Stellwerk/)).toHaveCount(0);
	await expect(page.locator('[aria-label*="Stellwerk"]')).toHaveCount(0);
});

test('no page of the shell shows Stellwerk or names it in an aria-label, the Run-Akte crumb and the key overview included', async ({
	page,
	seedTicket
}) => {
	const ticket = seedTicket('A ticket whose crumb leads home');
	for (const path of [
		'/',
		'/takt',
		'/board',
		'/projects',
		'/p/WEB',
		'/settings',
		'/settings/profiles',
		ticket.path
	]) {
		await open(page, path);
		await page.keyboard.press('?');
		await expect(page.getByRole('dialog', { name: 'Alle Tasten' })).toBeVisible();
		await expect(page.getByText(/Stellwerk/), path).toHaveCount(0);
		await expect(page.locator('[aria-label*="Stellwerk"]'), path).toHaveCount(0);
		await page.keyboard.press('Escape');
	}
});
