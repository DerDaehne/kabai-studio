import type { Page } from '@playwright/test';

/** The width steps every view is designed for: a phone, a desktop and an ultrawide screen. */
export const WIDTHS = [
	{ width: 375, height: 667 },
	{ width: 1440, height: 900 },
	{ width: 2560, height: 1440 }
] as const;

/** How far the page itself scrolls sideways at the current viewport; zero or less means it fits. */
export function pageOverflowX(page: Page): Promise<number> {
	return page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
}
