import { expect, open, sidewaysScrollers, test } from './fixtures.ts';

test.use({ viewport: { width: 375, height: 667 } });

test('no view scrolls sideways on a 375 px wide phone screen', async ({ page, seedTicket }) => {
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
	}
});
