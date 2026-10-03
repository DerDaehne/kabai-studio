import type { Page } from '@playwright/test';
import { expect, open, test } from './fixtures.ts';

test.use({ viewport: { width: 375, height: 667 } });

/** What a user could scroll sideways: the page itself, or a scroll container whose content is wider than its box. */
function sidewaysScrollers(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const root = document.documentElement;
		const scrolls = (element: Element) =>
			element === root || /auto|scroll/.test(getComputedStyle(element).overflowX);
		return [root, ...document.body.querySelectorAll('*')]
			.filter((element) => element.scrollWidth > element.clientWidth && scrolls(element))
			.map((element) => [element.tagName.toLowerCase(), ...element.classList].join('.'));
	});
}

test('no view scrolls sideways on a 375 px wide phone screen', async ({ page, seedTicket }) => {
	const ticket = seedTicket('A ticket whose rather long title has to wrap on a phone screen');
	const paths = ['/', '/takt', '/board', '/settings', '/settings/profiles', ticket.path];

	for (const path of paths) {
		await open(page, path);
		expect(await sidewaysScrollers(page), path).toEqual([]);
	}
});
