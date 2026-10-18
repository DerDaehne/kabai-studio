import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { latestOpenQuestion } from '../../src/lib/server/domain/questions.ts';
import { finishRun } from '../../src/lib/server/domain/runs.ts';
import { expect, open, queueRun, test, type SeededTicket } from './fixtures.ts';
import type { FakeModel } from './fake-model.ts';

const notice = (page: Page) => page.locator('.rk-toast', { hasText: 'Antwort gesendet' });
const count = (page: Page) => notice(page).locator('.rk-toast-count');

type Run = { id: number; state: string; not_before: string | null };
const followUp = (db: DatabaseSync, ticketId: number) =>
	db
		.prepare('SELECT id, state, not_before FROM runs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1')
		.get(ticketId) as Run;
const answerOf = (db: DatabaseSync, ticketId: number) =>
	(
		db.prepare('SELECT answer FROM questions WHERE ticket_id = ?').get(ticketId) as {
			answer: string | null;
		}
	).answer;

/** The hold beats the page has sent and the ones the server has answered; the fake clock must not jump over a beat in flight. */
function beatsOf(page: Page) {
	const beats = { sent: 0, answered: 0 };
	page.on('request', (request) => {
		if (request.url().includes('/takt?/hold')) beats.sent += 1;
	});
	page.on('requestfinished', (request) => {
		if (request.url().includes('/takt?/hold')) beats.answered += 1;
	});
	return beats;
}

/**
 * A real run asks, the human answers on `path`, and the notice stands open. The browser clock is paused so the test
 * decides when the notice's seconds pass; the server's clock runs on regardless.
 */
async function answered(
	page: Page,
	db: DatabaseSync,
	fakeModel: FakeModel,
	ticket: SeededTicket,
	path: '/' | '/takt'
) {
	fakeModel.reply(
		{
			call: {
				name: 'request_human',
				args: { question: 'Hold?', options: [{ label: 'Go' }, { label: 'Stop' }] }
			}
		},
		'hang'
	);
	await page.clock.install();
	await queueRun(db, page, ticket.id, fakeModel);
	await expect.poll(() => latestOpenQuestion(db, ticket.id)?.question).toBe('Hold?');
	await open(page, path);
	await page.clock.pauseAt(new Date(Date.now() + 1000));
	await page.keyboard.press('1');
	await expect(notice(page)).toBeVisible();
}

/** Holds the notice for twelve seconds of the browser's clock, one beat at once and one every five seconds. */
async function holdForTwelveSeconds(page: Page, beats: ReturnType<typeof beatsOf>) {
	await notice(page).hover();
	await expect.poll(() => beats.answered).toBe(1);
	await page.clock.runFor(5000);
	await expect.poll(() => beats.answered).toBe(2);
	await page.clock.runFor(7000);
	await expect.poll(() => beats.answered).toBe(3);
}

const inRealSeconds = (iso: string | null) => (Date.parse(iso!) - Date.now()) / 1000;

test.describe('holding the notice of an answer', () => {
	test('beats at once and every five seconds, outlives the first ten seconds, then runs down on the server rest and the window closes', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const ticket = seedTicket('Hold the notice');
		const beats = beatsOf(page);
		await answered(page, db, fakeModel, ticket, '/takt');

		await notice(page).hover();
		await expect.poll(() => beats.answered).toBe(1);
		await page.clock.runFor(5000);
		await expect.poll(() => beats.answered).toBe(2);
		await page.clock.runFor(7000);
		await expect.poll(() => beats.answered).toBe(3);
		await expect(notice(page)).toBeVisible();
		await expect(count(page)).toHaveText('10');
		expect(inRealSeconds(followUp(db, ticket.id).not_before)).toBeGreaterThan(8);

		await page.mouse.move(0, 0);
		await page.clock.runFor(4000);
		await expect(count(page)).toHaveText('6');
		await page.clock.runFor(6000);
		await expect(notice(page)).toBeHidden();
		await expect.poll(() => followUp(db, ticket.id).state, { timeout: 15_000 }).not.toBe('queued');
	});

	for (const [how, take] of [
		['the u key', (page: Page) => page.keyboard.press('u')],
		['Ctrl+Z', (page: Page) => page.keyboard.press('Control+z')],
		['Cmd+Z', (page: Page) => page.keyboard.press('Meta+z')],
		['the button', (page: Page) => notice(page).getByRole('button', { name: 'Rückgängig' }).click()]
	] as const) {
		test(`takes the answer back with ${how} after the first ten seconds of a hold`, async ({
			page,
			db,
			seedTicket,
			fakeModel
		}) => {
			const ticket = seedTicket('Undo in a hold');
			const beats = beatsOf(page);
			await answered(page, db, fakeModel, ticket, '/takt');
			await holdForTwelveSeconds(page, beats);
			await expect(notice(page)).toBeVisible();

			await take(page);

			await expect(page.getByTestId('decision')).toContainText('Hold?');
			expect(answerOf(db, ticket.id)).toBeNull();
			expect(followUp(db, ticket.id).state).toBe('cancelled');
		});
	}

	test('on the Start page a held notice also outlives ten seconds and the u key takes the answer back', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const ticket = seedTicket('Undo in a hold on Start');
		const beats = beatsOf(page);
		await answered(page, db, fakeModel, ticket, '/');
		await holdForTwelveSeconds(page, beats);
		await expect(notice(page)).toBeVisible();

		await page.keyboard.press('u');

		await expect(page.getByText('Hold?').first()).toBeVisible();
		expect(answerOf(db, ticket.id)).toBeNull();
		expect(followUp(db, ticket.id).state).toBe('cancelled');
	});

	test('says once that holding no longer extends the window, lets the hold go and closes with the server window', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const ticket = seedTicket('Hold up to the cap');
		await answered(page, db, fakeModel, ticket, '/takt');
		await page.evaluate(() => {
			const announced: string[] = [];
			(window as unknown as { announced: string[] }).announced = announced;
			new MutationObserver((records) => {
				for (const record of records)
					if (record.target.textContent?.includes('Halten verlängert nicht mehr'))
						announced.push(record.target.textContent);
			}).observe(document.querySelector('.rk-toasts')!, {
				childList: true,
				subtree: true,
				characterData: true
			});
		});
		db.prepare('UPDATE questions SET answered_at = ? WHERE ticket_id = ?').run(
			new Date(Date.now() - 119_000).toISOString(),
			ticket.id
		);

		const beats = beatsOf(page);
		await notice(page).hover();
		await expect.poll(() => beats.answered).toBe(1);
		db.prepare('UPDATE questions SET answered_at = ? WHERE ticket_id = ?').run(
			new Date(Date.now() - 125_000).toISOString(),
			ticket.id
		);
		await page.clock.runFor(5000);

		await expect(page.locator('.rk-toast')).toContainText(
			/Halten verlängert nicht mehr\. Noch \d+ s zum Rückgängigmachen\./
		);
		await page.clock.runFor(2000);
		const announced = await page.evaluate(
			() => (window as unknown as { announced: string[] }).announced
		);
		expect(announced).toHaveLength(1);
		const shown = Number(await page.locator('.rk-toast-count').textContent());
		await page.clock.runFor(1000);
		await expect(page.locator('.rk-toast-count')).toHaveText(String(shown - 1));
		await page.clock.runFor(12_000);
		await expect(page.locator('.rk-toast')).toBeHidden();
	});

	test('a lost network ends the hold at once: the notice runs down from the last server state and closes', async ({
		page,
		context,
		db,
		seedTicket,
		fakeModel
	}) => {
		const ticket = seedTicket('Hold, then offline');
		const beats = beatsOf(page);
		await answered(page, db, fakeModel, ticket, '/takt');
		await notice(page).getByRole('button', { name: 'Rückgängig' }).focus(); // focus, not the pointer: the banner's layout shift must not end the hold
		await expect.poll(() => beats.answered).toBe(1);

		await context.setOffline(true);
		await expect(page.locator('.rk-banner [role="status"]')).toContainText('Getrennt');
		await page.clock.runFor(4000);
		await expect(count(page)).toHaveText('6');
		await page.clock.runFor(6500);
		await expect(notice(page)).toBeHidden();
		await context.setOffline(false);
	});

	test('a beat the server does not answer within four seconds ends the hold', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const ticket = seedTicket('Hold, silent server');
		const beats = beatsOf(page);
		await answered(page, db, fakeModel, ticket, '/takt');
		await page.route('**/takt?/hold', () => {
			// never answers
		});
		await notice(page).hover();
		await expect.poll(() => beats.sent).toBe(1);

		await page.clock.runFor(3900);
		await expect(count(page)).toHaveText('10'); // still waiting for the beat: the notice stands
		await page.clock.runFor(100); // four seconds without an answer: the hold ends, the notice runs down
		await expect(count(page)).toHaveText('6');
		await page.clock.runFor(1000);
		await expect(count(page)).toHaveText('5');
		await page.clock.runFor(5000);
		await expect(notice(page)).toBeHidden();
	});

	test('with no waiting run the Start notice is not held: it runs out although the pointer rests on it', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const ticket = seedTicket('Hold, nothing to hold');
		const beats = beatsOf(page);
		await answered(page, db, fakeModel, ticket, '/');
		finishRun(db, { kind: 'system' }, followUp(db, ticket.id).id, { state: 'cancelled' });
		await notice(page).hover();
		await expect.poll(() => beats.answered).toBe(1);

		await page.clock.runFor(11_000);

		await expect(notice(page)).toBeHidden();
	});

	test('u after the notice has closed is refused once the run works with the answer, with a way out, and the answer stays', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const ticket = seedTicket('Undo too late');
		await answered(page, db, fakeModel, ticket, '/takt');
		await page.clock.runFor(11_000);
		await expect(notice(page)).toBeHidden();
		db.prepare("UPDATE runs SET not_before = NULL WHERE ticket_id = ? AND state = 'queued'").run(
			ticket.id
		);
		expect((await page.request.delete('/api/halt')).ok()).toBe(true);
		await expect.poll(() => followUp(db, ticket.id).state, { timeout: 15_000 }).toBe('running');

		await page.keyboard.press('u');

		await expect(
			page.locator('.rk-toast', { hasText: 'arbeitet schon mit der Antwort' })
		).toContainText('Korrektur schreibst du als Kommentar');
		expect(answerOf(db, ticket.id)).not.toBeNull();
	});
});
