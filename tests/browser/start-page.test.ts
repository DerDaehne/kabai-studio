import { randomUUID } from 'node:crypto';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { createProfile, createRun, finishRun, startRun } from '../../src/lib/server/domain/runs.ts';
import { expect, open, queueRun, test } from './fixtures.ts';

const HUMAN: Actor = { kind: 'user' };

test('without an active run the Stellwerk says no agent is at work and leads to the board', async ({
	page
}) => {
	await open(page, '/');
	await expect(page.getByText('Kein Agent arbeitet.')).toBeVisible();

	await page.getByRole('link', { name: 'Zum Board' }).click();
	await expect(page).toHaveURL('/board');
});

test('an active run that asks a question shows up live, holding, and the open-question count follows it to Takt', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const question = 'Deploy now or wait for the next window?';
	fakeModel.reply({
		call: { name: 'request_human', args: { question, options: [{ label: 'Jetzt' }] } }
	});
	const ticket = seedTicket('Decide the deploy window');
	await open(page, '/');
	// Scoped to its own section: the nav's Takt link also names its open-question count.
	const questionLink = page.getByRole('region', { name: 'Offene Fragen' }).getByRole('link');
	const before = await questionLink.textContent();

	await queueRun(db, page, ticket.id, fakeModel);

	const row = page.getByRole('listitem').filter({ hasText: ticket.ref });
	await expect(row).toContainText('hält');
	await expect(row.getByRole('link', { name: ticket.ref })).toHaveAttribute('href', ticket.path);
	await expect(questionLink).not.toHaveText(before ?? '');

	await questionLink.click();
	await expect(page).toHaveURL('/takt');
});

test('a finished run shows its outcome under "Zuletzt beendet" and links to the Run-Akte', async ({
	page,
	db,
	seedTicket
}) => {
	const profile = createProfile(db, HUMAN, {
		name: `Fake ${randomUUID()}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: 'http://127.0.0.1:1',
		model: 'fake'
	});
	const ticket = seedTicket('A ticket whose run will fail');
	const run = createRun(db, HUMAN, { ticketId: ticket.id, profileId: profile.id }).id;
	startRun(db, HUMAN, run); // a run only fails from "running" — finishRun rejects "queued" -> "failed" directly
	finishRun(db, HUMAN, run, { state: 'failed', error: 'Timeout talking to the model' });

	await open(page, '/');
	const row = page.getByRole('listitem').filter({ hasText: ticket.ref });
	await expect(row).toContainText('fehlgeschlagen');
	await expect(row).toContainText('Timeout talking to the model');
	await expect(row.getByRole('link', { name: ticket.ref })).toHaveAttribute('href', ticket.path);
});
