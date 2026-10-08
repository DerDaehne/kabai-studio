import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, open, sidewaysScrollers, test } from './fixtures.ts';

const SHOWCASE = '[data-testid="rekta-showcase"]';
const tones = ['neutral', 'info', 'success', 'warning', 'error'];

async function setTheme(page: Page, theme: 'light' | 'dark') {
	await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
}

/** The weights of the Barlow faces the page has actually loaded. */
function loadedBarlowWeights(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		await document.fonts.ready;
		return [...document.fonts]
			.filter((face) => face.family.replaceAll('"', '') === 'Barlow' && face.status === 'loaded')
			.map((face) => face.weight);
	});
}

test('the start page and /dev/ui render in the bundled Barlow and ask no other origin for anything', async ({
	page,
	baseURL
}) => {
	const requests: string[] = [];
	page.on('request', (request) => requests.push(request.url()));

	for (const path of ['/', '/dev/ui']) {
		await open(page, path);
		const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
		expect(bodyFont, path).toMatch(/^"?Barlow"?,/);
		expect(await loadedBarlowWeights(page), path).toContain('400');
	}

	const web = requests.filter((url) => /^https?:/.test(url));
	expect(web.filter((url) => new URL(url).origin !== new URL(baseURL!).origin)).toEqual([]);
	expect(web.some((url) => url.endsWith('/fonts/barlow/barlow-latin-400-normal.woff2'))).toBe(true);
});

for (const width of [375, 1440, 2560]) {
	test(`neither the start page nor the tile showcase scrolls sideways at ${width} px`, async ({
		page
	}) => {
		await page.setViewportSize({ width, height: 900 });
		await open(page, '/');
		expect(await sidewaysScrollers(page), '/').toEqual([]);

		await open(page, '/dev/ui');
		const overflow = await page.evaluate((selector) => {
			const showcase = document.querySelector(selector)!;
			const right = document.documentElement.clientWidth;
			return {
				pageScrolls: document.documentElement.scrollWidth > right,
				outside: [...showcase.querySelectorAll('*')]
					.filter((element) => element.getBoundingClientRect().right > right + 0.5)
					.map((element) => element.className)
			};
		}, SHOWCASE);
		expect(overflow).toEqual({ pageScrolls: false, outside: [] });
	});
}

test('every tile tone takes its Rekta fill, in light and in dark', async ({ page }) => {
	await open(page, '/dev/ui');
	for (const theme of ['light', 'dark'] as const) {
		await setTheme(page, theme);
		const mismatches = await page.evaluate(
			({ selector, tones }) => {
				const probe = document.createElement('span');
				document.body.append(probe);
				const resolve = (value: string) => {
					probe.style.color = value;
					return getComputedStyle(probe).color;
				};
				const wrong = tones.filter((tone) => {
					const tile = document.querySelector(`${selector} a.tile[data-tone="${tone}"]`)!;
					return getComputedStyle(tile).backgroundColor !== resolve(`var(--tile-${tone})`);
				});
				probe.remove();
				return wrong;
			},
			{ selector: SHOWCASE, tones }
		);
		expect(mismatches, theme).toEqual([]);
		const infoFill = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue('--rekta-color-status-info-tile')
		);
		expect(infoFill, theme).toBe(theme === 'light' ? '#7da1f4' : '#244592');
	}
});

test('the in-app reduced motion setting stops the Rekta durations as well', async ({ page }) => {
	await open(page, '/dev/ui');
	// The minified CSS writes durations either way, "250ms" or ".25s"
	const shortSeconds = async () => {
		const value = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue('--motion-short')
		);
		return value.endsWith('ms') ? parseFloat(value) / 1000 : parseFloat(value);
	};
	expect(await shortSeconds()).toBe(0.25);
	await page.evaluate(() => (document.documentElement.dataset.motion = 'reduced'));
	expect(await shortSeconds()).toBe(0);
});

test('the tile showcase passes axe WCAG 2.1 A/AA in light and dark, on a phone and on a desktop', async ({
	page
}) => {
	await open(page, '/dev/ui');
	for (const width of [375, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		for (const theme of ['light', 'dark'] as const) {
			await setTheme(page, theme);
			const { violations } = await new AxeBuilder({ page })
				.include(SHOWCASE)
				.withTags(['wcag2a', 'wcag2aa'])
				.analyze();
			const found = violations.flatMap((violation) =>
				violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`)
			);
			expect(found, `${theme}, ${width} px`).toEqual([]);
		}
	}
});
