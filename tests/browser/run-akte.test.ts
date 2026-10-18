import { ticket as ticketOf } from '../../src/lib/server/domain/board.ts';
import { expect, open, test } from './fixtures.ts';

test('o adds a task, and > and < step the ticket to the next and back to the previous column', async ({
	page,
	db,
	seedTicket
}) => {
	const ticket = seedTicket('Write the changelog', 'Präzisieren');
	const columnName = () => ticketOf(db, ticket.id).column_name;
	await open(page, ticket.path);

	await page.keyboard.press('o');
	await expect(page.getByLabel('Neuer Task')).toBeFocused();
	await page.keyboard.type('Draft the entry');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('checkbox', { name: 'Draft the entry' })).not.toBeChecked();
	await page.keyboard.press('Escape');

	const facts = page.getByTestId('facts');
	await expect(facts).toContainText('Umfang klären');
	await page.keyboard.press('>');
	await expect(facts).toContainText('Vorgehen festlegen');
	expect(columnName()).toBe('Planen');
	await page.keyboard.press('<');
	await expect(facts).toContainText('Umfang klären');
	expect(columnName()).toBe('Präzisieren');
});
