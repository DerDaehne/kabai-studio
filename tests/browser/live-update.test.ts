import { expect, open, test } from './fixtures.ts';

test('a task added in one browser appears in a second browser on the same ticket without a reload', async ({
	page,
	browser,
	seedTicket
}) => {
	const ticket = seedTicket('Plan the release');
	const otherContext = await browser.newContext();
	const other = await otherContext.newPage();
	await open(page, ticket.path);
	await open(other, ticket.path);

	await page.getByLabel('Neuer Task').fill('Tag the build');
	await page.getByRole('button', { name: 'Anlegen (o)' }).click();

	await expect(other.getByRole('button', { name: '[ ] Tag the build' })).toBeVisible();
	await otherContext.close();
});
