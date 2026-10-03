import { latestOpenQuestion } from '../../src/lib/server/domain/questions.ts';
import { expect, open, queueRun, test } from './fixtures.ts';

test('an agent question arrives live in Takt, 1 answers it and u takes the answer back', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const question = 'Should the export write CSV or JSON?';
	fakeModel.reply({
		call: {
			name: 'request_human',
			args: { question, options: [{ label: 'CSV' }, { label: 'JSON' }] }
		}
	});
	const ticket = seedTicket('Choose the export format');
	await open(page, '/takt');

	await queueRun(db, page, ticket.id, fakeModel);
	const card = page.getByRole('heading', { name: question });
	await expect(card).toBeVisible();

	await page.keyboard.press('1');
	await expect(page.getByText(`Antwort gesendet · ${ticket.ref}`)).toBeVisible();
	await expect(card).toBeHidden();

	await page.keyboard.press('u');
	await expect(card).toBeVisible();
	expect(latestOpenQuestion(db, ticket.id)).toMatchObject({ question, answer: null });
});
