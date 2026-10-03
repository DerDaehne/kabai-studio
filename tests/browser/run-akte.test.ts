import { expect, open, test } from './fixtures.ts';

test('o adds a task, and > and < step the ticket to the next and back to the previous column', async ({
	page,
	seedTicket
}) => {
	const ticket = seedTicket('Write the changelog', 'Refine');
	await open(page, ticket.path);
	const ticketHead = page.locator('header', { has: page.getByRole('heading', { level: 1 }) });
	await expect(ticketHead).toContainText('Refine');

	await page.keyboard.press('o');
	await expect(page.getByLabel('Neuer Task')).toBeFocused();
	await page.keyboard.type('Draft the entry');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('button', { name: '[ ] Draft the entry' })).toBeVisible();
	await page.keyboard.press('Escape');

	await page.keyboard.press('>');
	await expect(ticketHead).toContainText('Ready');
	await page.keyboard.press('<');
	await expect(ticketHead).toContainText('Refine');
});
