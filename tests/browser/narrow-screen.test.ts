import { expect, open, sidewaysScrollers, test } from './fixtures.ts';
import { pageOverflowX, WIDTHS } from './widths.ts';

for (const viewport of WIDTHS) {
	test(`no view scrolls sideways at ${viewport.width} px`, async ({ page, seedTicket }) => {
		await page.setViewportSize(viewport);
		const ticket = seedTicket('A ticket whose rather long title has to wrap on a phone screen');
		const paths = [
			'/',
			'/takt',
			'/board',
			'/projects',
			'/p/WEB',
			'/settings',
			'/settings/profiles',
			ticket.path
		];

		for (const path of paths) {
			await open(page, path);
			expect(await sidewaysScrollers(page), path).toEqual([]);
			expect(await pageOverflowX(page), path).toBeLessThanOrEqual(0);
		}
	});
}
