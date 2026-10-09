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

test("the loop-guard escalation's three fixed options answer with 1, and its Run-Akte link opens the asking run's own trace", async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const question = 'Wie soll es weitergehen?';
	const options = [
		{ label: 'Neuer Versuch mit frischem Kontext und meinem Hinweis' },
		{ label: 'Aufgabe verkleinern: nur den nächsten prüfbaren Schritt' },
		{ label: 'Aufhören: Stand als Kommentar festhalten, Ticket bleibt beim Menschen' }
	];
	fakeModel.reply({ call: { name: 'request_human', args: { question, options } } });
	const ticket = seedTicket('Escalate after the recovery chain is used up');
	await open(page, '/takt');

	await queueRun(db, page, ticket.id, fakeModel);
	const card = page.getByRole('heading', { name: question });
	await expect(card).toBeVisible();
	for (const option of options) await expect(page.getByText(option.label)).toBeVisible();

	const runId = (
		db
			.prepare('SELECT id FROM runs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1')
			.get(ticket.id) as {
			id: number;
		}
	).id;
	const runAkte = page.getByRole('link', { name: 'Run-Akte' });
	await expect(runAkte).toHaveAttribute('href', `${ticket.path}?run=${runId}`);
	await runAkte.click();
	await expect(page.locator('a.tab', { hasText: `Run ${runId}` })).toHaveAttribute(
		'aria-current',
		'page'
	);

	await open(page, '/takt');
	await expect(page.getByRole('heading', { name: question })).toBeVisible();
	await page.keyboard.press('1');
	await expect(page.getByText(`Antwort gesendet · ${ticket.ref}`)).toBeVisible();
});
