import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, open, test } from './fixtures.ts';
import { pageOverflowX, WIDTHS } from './widths.ts';

const [PHONE, DESKTOP, ULTRAWIDE] = WIDTHS;
const SHOWCASE = '[data-testid="pivot-showcase"]';
const NAMES = ['Fragen 2', 'Läuft 3', 'Angehalten 1', 'Fertig 40'];
const WIDTHS_PX = { fragen: 560, laeuft: 460, angehalten: 440, fertig: 480 };

const showcaseOf = (page: Page) => page.getByTestId('pivot-showcase');
const tabOf = (page: Page, name: string) =>
	showcaseOf(page).getByRole('tab', { name: new RegExp(`^${name}`) });

type Box = {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
};
type Titles = { row: Box; edge: number; tabs: Record<string, Box> };
type Facet = Box & { id: string; offsetLeft: number; scrollTop: number };
type Panorama = { scrollLeft: number; max: number; strip: Box; facets: Facet[] };

/** Where the title row and each of its titles are drawn right now, scaling included. */
function measureTitles(page: Page): Promise<Titles> {
	return page.evaluate((selector) => {
		const row = document.querySelector(`${selector} [role="tablist"]`)!;
		const box = (element: Element) => element.getBoundingClientRect().toJSON();
		const tabs = [...row.querySelectorAll('[role="tab"]')].map((tab) => [
			tab.id.split('-tab-')[1],
			box(tab)
		]);
		return {
			row: box(row),
			edge: row.getBoundingClientRect().left + parseFloat(getComputedStyle(row).paddingLeft),
			tabs: Object.fromEntries(tabs)
		};
	}, SHOWCASE);
}

function measurePanorama(page: Page): Promise<Panorama> {
	return page.evaluate((selector) => {
		const strip = document.querySelector<HTMLElement>(`${selector} .facets`)!;
		const facets = [...strip.querySelectorAll<HTMLElement>(':scope > section')].map((facet) => ({
			id: facet.id.split('-panel-')[1],
			offsetLeft: facet.offsetLeft,
			scrollTop: facet.scrollTop,
			...facet.getBoundingClientRect().toJSON()
		}));
		const max = strip.scrollWidth - strip.clientWidth;
		return {
			scrollLeft: strip.scrollLeft,
			max,
			strip: strip.getBoundingClientRect().toJSON(),
			facets
		};
	}, SHOWCASE);
}

const runningAnimations = (page: Page) =>
	page.evaluate(
		(selector) => document.querySelector(selector)!.getAnimations({ subtree: true }).length,
		SHOWCASE
	);
const panelAnimations = (page: Page) =>
	page.evaluate(
		(selector) =>
			document.querySelector(`${selector} [role="tabpanel"]:not([hidden])`)!.getAnimations().length,
		SHOWCASE
	);
const twoFrames = (page: Page) =>
	page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
const scrollY = (page: Page) => page.evaluate(() => window.scrollY);
const blur = (page: Page) =>
	page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** Waits until `facet` is selected, has glided to the left edge and every transition has ended. */
async function settledTitles(page: Page, facet: string): Promise<Titles> {
	await expect(showcaseOf(page).locator(`[id$="-tab-${facet}"]`)).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect
		.poll(async () => {
			const { tabs, edge } = await measureTitles(page);
			return Math.abs(tabs[facet].left - edge);
		})
		.toBeLessThanOrEqual(1);
	await expect.poll(() => runningAnimations(page)).toBe(0);
	return measureTitles(page);
}

/** Scrolls the window so the panorama starts right under the sticky head, as when a view opens on it. */
async function alignPanorama(page: Page): Promise<number> {
	await page.evaluate((selector) => {
		const strip = document.querySelector(`${selector} .facets`)!;
		const head = document.querySelector('header.head')!;
		window.scrollBy({
			top: strip.getBoundingClientRect().top - head.getBoundingClientRect().bottom,
			behavior: 'instant'
		});
	}, SHOWCASE);
	return scrollY(page);
}

/** The scroll position that brings facet `index` to the left edge, or as far as the panorama goes. */
async function revealedAt(page: Page, index: number): Promise<number> {
	const { max, facets } = await measurePanorama(page);
	return Math.min(max, facets[index].offsetLeft - facets[0].offsetLeft);
}

const setStripScroll = (page: Page, left: number) =>
	page.evaluate(
		({ selector, left }) =>
			document.querySelector(`${selector} .facets`)!.scrollTo({ left, behavior: 'instant' }),
		{ selector: SHOWCASE, left }
	);

async function pointAt(page: Page, box: Box, dx = 40, dy = 40) {
	await page.mouse.move(Math.max(box.left, 0) + dx, box.top + dy);
}

test('on a phone the pivot is a tab list: each title carries its count, one panel shows', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	await open(page, '/dev/ui');
	const pivot = showcaseOf(page);
	await expect(pivot.getByRole('tablist', { name: 'Takt-Facetten' })).toBeVisible();
	for (const name of NAMES)
		await expect(tabOf(page, name.split(' ')[0])).toHaveAccessibleName(name);
	await expect(pivot.getByRole('tabpanel')).toHaveCount(1);
	await expect(pivot.getByRole('tabpanel')).toHaveAccessibleName('Fragen 2');
	await expect(pivot.getByRole('region')).toHaveCount(0);
});

test('arrows and h/l switch facets round the end; focus inside the pivot follows the tab, focus outside stays', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	await open(page, '/dev/ui');
	await tabOf(page, 'Fragen').focus();
	await page.keyboard.press('ArrowRight');
	await expect(tabOf(page, 'Läuft')).toBeFocused();
	await expect(showcaseOf(page).getByRole('tabpanel')).toHaveAccessibleName('Läuft 3');
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('ArrowLeft');
	await expect(tabOf(page, 'Fertig')).toBeFocused();
	await page.keyboard.press('l');
	await expect(tabOf(page, 'Fragen')).toBeFocused();
	await page.keyboard.press('h');
	await expect(tabOf(page, 'Fertig')).toHaveAttribute('aria-selected', 'true');

	await blur(page);
	await page.keyboard.type('2l');
	await expect(tabOf(page, 'Läuft'), 'a count moves that many facets').toHaveAttribute(
		'aria-selected',
		'true'
	);
	expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('the active title stands large at the left edge, the one before it has scrolled out, the bar keeps its height', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	await open(page, '/dev/ui');
	await showcaseOf(page).scrollIntoViewIfNeeded();
	const start = await settledTitles(page, 'fragen');

	await tabOf(page, 'Angehalten').click();
	const after = await settledTitles(page, 'angehalten');
	expect(after.row.height).toBe(start.row.height);
	const active = after.tabs.angehalten;
	expect(active.top, 'the large title fits the bar').toBeGreaterThanOrEqual(after.row.top);
	expect(active.bottom).toBeLessThanOrEqual(after.row.bottom);
	expect(after.tabs.laeuft.right, 'the title before has scrolled out').toBeLessThanOrEqual(
		after.edge
	);
	expect(after.tabs.angehalten.height).toBeGreaterThan(start.tabs.angehalten.height * 1.3);
	expect(start.tabs.fragen.height).toBeGreaterThan(after.tabs.fragen.height * 1.3);
	for (const uninvolved of ['laeuft', 'fertig']) {
		expect(after.tabs[uninvolved].width, uninvolved).toBeCloseTo(start.tabs[uninvolved].width, 0);
		expect(after.tabs[uninvolved].height, uninvolved).toBeCloseTo(start.tabs[uninvolved].height, 0);
	}

	await tabOf(page, 'Fertig').click();
	expect(
		(await settledTitles(page, 'fertig')).row.height,
		'the last title reaches the edge too'
	).toBe(start.row.height);
	expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
});

test('a switch slides the panel in; with reduced motion title and panel jump without animation', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	await open(page, '/dev/ui');
	await tabOf(page, 'Läuft').click();
	expect(await panelAnimations(page), 'full motion slides the panel in').toBe(1);
	await settledTitles(page, 'laeuft');

	await page.emulateMedia({ reducedMotion: 'reduce' });
	await tabOf(page, 'Fertig').click();
	await twoFrames(page);
	const { tabs, edge } = await measureTitles(page);
	expect(Math.abs(tabs.fertig.left - edge), 'the title jumps to the edge').toBeLessThanOrEqual(1);
	expect(await panelAnimations(page), 'the panel does not slide').toBe(0);
	expect(await runningAnimations(page), 'nothing slides or scales over time').toBe(0);
});

test('setting the facet from outside switches it at once without reporting it back; a switch by hand is reported once', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	await open(page, '/dev/ui');
	const pivot = showcaseOf(page);
	const start = await settledTitles(page, 'fragen');
	await pivot.getByLabel('Facette von außen').selectOption('fertig');
	await twoFrames(page);
	await expect(pivot.getByRole('tabpanel'), 'never two panels at once').toHaveCount(1);
	await expect(pivot.getByRole('tabpanel')).toHaveAccessibleName('Fertig 40');
	expect((await settledTitles(page, 'fertig')).row.height).toBe(start.row.height);
	await expect(pivot.getByRole('status')).toHaveText('Gemeldete Wechsel: keine');

	await tabOf(page, 'Fragen').click();
	await tabOf(page, 'Fragen').click();
	await expect(pivot.getByRole('status')).toHaveText('Gemeldete Wechsel: fragen');
	await expect(pivot.getByLabel('Facette von außen')).toHaveValue('fragen');

	await page.setViewportSize(DESKTOP);
	await alignPanorama(page);
	await pivot.getByLabel('Facette von außen').selectOption('fertig');
	await expect
		.poll(
			async () => {
				const { scrollLeft } = await measurePanorama(page);
				return Math.abs(scrollLeft - (await revealedAt(page, 3)));
			},
			{ message: 'the panorama glides to a facet set from outside' }
		)
		.toBeLessThanOrEqual(1);
});

test('the focus rings of the active title and of a panorama facet stay inside the rows that clip them', async ({
	page
}) => {
	const ringInside = (target: string, clip: string) =>
		page.evaluate(
			({ target, clip }) => {
				const element = document.querySelector(target)!;
				const style = getComputedStyle(element);
				const ring =
					(parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)) *
					(parseFloat(style.scale) || 1);
				const box = element.getBoundingClientRect();
				const row = document.querySelector(clip)!.getBoundingClientRect();
				return [
					box.top - ring >= row.top,
					box.bottom + ring <= row.bottom,
					box.left - ring >= row.left
				];
			},
			{ target, clip }
		);
	await page.setViewportSize(PHONE);
	await open(page, '/dev/ui');
	await showcaseOf(page).getByLabel('Facette von außen').focus();
	await page.keyboard.press('Tab');
	await expect(tabOf(page, 'Fragen')).toBeFocused();
	expect(
		await ringInside(`${SHOWCASE} [aria-selected="true"]`, `${SHOWCASE} [role="tablist"]`)
	).toEqual([true, true, true]);

	await page.setViewportSize(DESKTOP);
	await showcaseOf(page).getByLabel('Facette von außen').focus();
	await page.keyboard.press('Tab');
	await expect(showcaseOf(page).getByRole('region', { name: 'Fragen 2' })).toBeFocused();
	expect(await ringInside(`${SHOWCASE} section:focus`, `${SHOWCASE} .facets`)).toEqual([
		true,
		true,
		true
	]);
});

test('the panorama starts at exactly 1300 px, in the styles and in the roles alike', async ({
	page
}) => {
	await page.setViewportSize({ width: 1299, height: 900 });
	await open(page, '/dev/ui');
	const pivot = showcaseOf(page);
	await expect(pivot.getByRole('tablist')).toBeVisible();
	await expect(pivot.getByRole('tabpanel')).toHaveCount(1);

	await page.setViewportSize({ width: 1300, height: 900 });
	await expect(pivot.getByRole('tablist')).toHaveCount(0);
	await expect(pivot.getByRole('tabpanel')).toHaveCount(0);
	for (const name of NAMES) await expect(pivot.getByRole('region', { name })).toBeVisible();
	await expect(pivot.getByRole('heading', { name: 'Fertig 40' })).toBeVisible();
});

for (const viewport of [DESKTOP, ULTRAWIDE]) {
	test(`at ${viewport.width} px the facets stand side by side at their own widths and fill the stage between head and app bar`, async ({
		page
	}) => {
		await page.setViewportSize(viewport);
		await open(page, '/dev/ui');
		await alignPanorama(page);
		const { strip, facets } = await measurePanorama(page);
		expect(facets.map((facet) => [facet.id, Math.round(facet.width)])).toEqual(
			Object.entries(WIDTHS_PX)
		);
		for (const [index, facet] of facets.slice(1).entries())
			expect(facet.left, facet.id).toBeGreaterThan(facets[index].right);

		const head = await page.locator('header.head').boundingBox();
		const bar = await page.getByRole('contentinfo', { name: 'App-Leiste' }).boundingBox();
		expect(
			Math.abs(strip.height - (viewport.height - head!.height - bar!.height))
		).toBeLessThanOrEqual(1);
		expect(Math.abs(strip.bottom - bar!.y), 'the panorama ends on the app bar').toBeLessThanOrEqual(
			1
		);
		expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
	});
}

test('on a desktop a vertical wheel moves the panorama sideways and leaves the page where it is; a sideways wheel stays native', async ({
	page
}) => {
	await page.setViewportSize(DESKTOP);
	await open(page, '/dev/ui');
	const top = await alignPanorama(page);
	await pointAt(page, (await measurePanorama(page)).facets[0]);
	await page.mouse.wheel(0, 300);
	await expect.poll(async () => (await measurePanorama(page)).scrollLeft).toBe(300);
	expect(await scrollY(page)).toBe(top);

	await page.mouse.wheel(100, 0);
	await expect.poll(async () => (await measurePanorama(page)).scrollLeft).toBe(400);
	expect(await scrollY(page)).toBe(top);
});

test('a long facet keeps the wheel while it can scroll; at the edge of the panorama the wheel falls through to the page', async ({
	page
}) => {
	await page.setViewportSize(DESKTOP);
	await open(page, '/dev/ui');
	const top = await alignPanorama(page);
	const { max } = await measurePanorama(page);
	await setStripScroll(page, max - 200);
	const fertig = (await measurePanorama(page)).facets[3];
	await pointAt(page, fertig, 40, 200);
	await page.mouse.wheel(0, 300);
	await expect.poll(async () => (await measurePanorama(page)).facets[3].scrollTop).toBe(300);
	expect((await measurePanorama(page)).scrollLeft).toBe(max - 200);
	expect(await scrollY(page)).toBe(top);

	await setStripScroll(page, max);
	await pointAt(page, (await measurePanorama(page)).facets[2]);
	await page.mouse.wheel(0, 300);
	await expect.poll(() => scrollY(page), { message: 'the page scrolls on' }).toBeGreaterThan(top);
	expect((await measurePanorama(page)).scrollLeft).toBe(max);
});

test('in the panorama h/l glide the next facet to the left edge; with reduced motion wheel and h/l jump', async ({
	page
}) => {
	await page.setViewportSize(DESKTOP);
	await open(page, '/dev/ui');
	await alignPanorama(page);
	await page.keyboard.press('l');
	await expect
		.poll(async () => (await measurePanorama(page)).scrollLeft)
		.toBe(await revealedAt(page, 1));

	await page.keyboard.press('h');
	await expect.poll(async () => (await measurePanorama(page)).scrollLeft).toBe(0);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await pointAt(page, (await measurePanorama(page)).facets[0]);
	await page.mouse.wheel(0, 300);
	expect((await measurePanorama(page)).scrollLeft, 'the wheel jumps at once').toBe(300);
	await page.keyboard.press('l');
	await twoFrames(page);
	expect((await measurePanorama(page)).scrollLeft, 'h/l jump').toBe(await revealedAt(page, 1));
});

test('on a phone the wheel scrolls the page down and nothing scrolls sideways', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	await open(page, '/dev/ui');
	await showcaseOf(page).getByRole('tablist').scrollIntoViewIfNeeded();
	const top = await scrollY(page);
	await pointAt(page, (await measurePanorama(page)).facets[0], 40, 20);
	await page.mouse.wheel(0, 300);
	await expect.poll(() => scrollY(page)).toBe(top + 300);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		PHONE.width
	);
	expect((await measurePanorama(page)).scrollLeft).toBe(0);
});

test('the pivot passes axe WCAG 2.1 A/AA as tab list on a phone and as panorama on an ultrawide screen', async ({
	page
}) => {
	for (const viewport of [PHONE, ULTRAWIDE]) {
		await page.setViewportSize(viewport);
		await open(page, '/dev/ui');
		const { violations } = await new AxeBuilder({ page })
			.include(SHOWCASE)
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((violation) =>
			violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`)
		);
		expect(found, `${viewport.width} px`).toEqual([]);
	}
});

test.describe('before hydration', () => {
	test.use({ javaScriptEnabled: false });

	test('the server-rendered page already lays the facets side by side from 1300 px', async ({
		page
	}) => {
		await page.setViewportSize(DESKTOP);
		await page.goto('/dev/ui');
		const { facets } = await measurePanorama(page);
		expect(facets.map((facet) => Math.round(facet.width))).toEqual(Object.values(WIDTHS_PX));
		for (const [index, facet] of facets.slice(1).entries())
			expect(facet.left, facet.id).toBeGreaterThan(facets[index].right);
	});
});
