import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import {
	createProfile,
	createRun,
	finishRun,
	startRun,
	type RunEnd
} from '../../src/lib/server/domain/runs.ts';
import { expect, open, queueRun, sidewaysScrollers, test } from './fixtures.ts';

const HUMAN: Actor = { kind: 'user' };

/** Seeds a run of `ticketId` that already ended with `end`, via a throwaway profile on an unreachable host. */
function finishedRun(db: DatabaseSync, ticketId: number, end: RunEnd): number {
	const profile = createProfile(db, HUMAN, {
		name: `Fake ${randomUUID()}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: 'http://127.0.0.1:1',
		model: 'fake'
	});
	const run = createRun(db, HUMAN, { ticketId, profileId: profile.id }).id;
	startRun(db, HUMAN, run); // a run only ends from "running" — finishRun rejects "queued" -> "failed"/"succeeded" directly
	finishRun(db, HUMAN, run, end);
	return run;
}

const finishedSection = (page: import('@playwright/test').Page) =>
	page.getByRole('region', { name: 'Zuletzt beendet' });

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
	const runId = (
		db.prepare('SELECT id FROM runs WHERE ticket_id = ?').get(ticket.id) as { id: number }
	).id;

	const row = page.getByRole('listitem').filter({ hasText: ticket.ref });
	await expect(row).toContainText('hält');
	await expect(row).toContainText('Fake model'); // the profile
	await expect(row.locator('.tag')).toHaveText('WEB'); // the project tag; the ticket ref alone already contains it
	await expect(row.getByRole('link', { name: ticket.ref })).toHaveAttribute(
		'href',
		`${ticket.path}?run=${runId}`
	);
	await expect(questionLink).not.toHaveText(before ?? '');

	await questionLink.click();
	await expect(page).toHaveURL('/takt');
});

test('a finished run shows its outcome under "Zuletzt beendet" and links to the Run-Akte', async ({
	page,
	db,
	seedTicket
}) => {
	const ticket = seedTicket('A ticket whose run will fail');
	const run = finishedRun(db, ticket.id, {
		state: 'failed',
		error: 'Timeout talking to the model'
	});

	await open(page, '/');
	const row = page.getByRole('listitem').filter({ hasText: ticket.ref });
	await expect(row).toContainText('fehlgeschlagen');
	await expect(row).toContainText('Timeout talking to the model');
	await expect(row.getByRole('link', { name: ticket.ref })).toHaveAttribute(
		'href',
		`${ticket.path}?run=${run}`
	);
});

test('the link of a finished run opens that run in the Run-Akte, even when its ticket has a newer run', async ({
	page,
	db,
	seedTicket
}) => {
	const ticket = seedTicket('A ticket retried after a failure');
	finishedRun(db, ticket.id, { state: 'failed', error: 'Timeout talking to the model' });
	finishedRun(db, ticket.id, { state: 'cancelled' });

	await open(page, '/');
	const failedRow = finishedSection(page)
		.getByRole('listitem')
		.filter({ hasText: 'fehlgeschlagen' });
	await failedRow.getByRole('link', { name: ticket.ref }).click();

	await expect(page.locator('.failure')).toContainText('Timeout talking to the model');
});

test('a run that finishes while the Stellwerk is open moves into "Zuletzt beendet" live', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	fakeModel.reply({ text: 'Erledigt.' });
	const ticket = seedTicket('Finish while watched');
	await open(page, '/');
	await expect(finishedSection(page)).not.toContainText(ticket.ref);

	await queueRun(db, page, ticket.id, fakeModel);

	await expect(
		finishedSection(page).getByRole('listitem').filter({ hasText: ticket.ref })
	).toContainText('fertig');
});

test('the finished-run link is reachable by keyboard and opens with Enter', async ({
	page,
	db,
	seedTicket
}) => {
	const ticket = seedTicket('Reach me by keyboard');
	finishedRun(db, ticket.id, { state: 'succeeded' });
	await open(page, '/');
	const link = finishedSection(page).getByRole('link', { name: ticket.ref });

	for (let i = 0; i < 60 && !(await link.evaluate((el) => el === document.activeElement)); i++)
		await page.keyboard.press('Tab');
	await expect(link).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(new RegExp(ticket.path));
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test('a long unbroken error line and a long profile name wrap instead of scrolling sideways', async ({
		page,
		db,
		seedTicket
	}) => {
		const ticket = seedTicket('A ticket with a long error');
		finishedRun(db, ticket.id, {
			state: 'failed',
			error: `[provider_unreachable] ${'https://example.invalid/'.repeat(12)}`
		});
		await open(page, '/');
		await expect(finishedSection(page)).toContainText('provider_unreachable');
		expect(await sidewaysScrollers(page)).toEqual([]);
	});
});
