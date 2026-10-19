import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { latestOpenQuestion } from '../../src/lib/server/domain/questions.ts';
import { expect, open, queueRun, test, type SeededTicket } from './fixtures.ts';
import type { FakeModel } from './fake-model.ts';

const notice = (page: Page) => page.locator('.rk-toast', { hasText: 'Antwort gesendet' });
const count = (page: Page) => notice(page).locator('.rk-toast-count');

/** A real run asks on /takt; the browser clock is left to the caller. */
async function asked(db: DatabaseSync, page: Page, fakeModel: FakeModel, ticket: SeededTicket) {
	fakeModel.reply(
		{
			call: {
				name: 'request_human',
				args: { question: 'Clock?', options: [{ label: 'Go' }, { label: 'Stop' }] }
			}
		},
		'hang'
	);
	await queueRun(db, page, ticket.id, fakeModel);
	await expect.poll(() => latestOpenQuestion(db, ticket.id)?.question).toBe('Clock?');
	await open(page, '/takt');
}

const blockMainThread = (page: Page, ms: number) =>
	page.evaluate((ms) => {
		const until = performance.now() + ms;
		while (performance.now() < until);
	}, ms);

test.describe('the countdown of a toast follows the wall clock', () => {
	test('a main thread blocked for 2.5 s costs the toast 2.5 s of its window, not one step', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		await asked(db, page, fakeModel, seedTicket('Stalled main thread'));
		await page.keyboard.press('1');
		await expect(count(page)).toHaveText('10');

		await blockMainThread(page, 2500);

		await page.waitForTimeout(300); // the late timer has run; the next step is a second away
		expect(await count(page).textContent()).toMatch(/^[78]$/); // 7.5 s are left; counting steps would show 9
	});

	test('timers that fire late after a long throttle close the toast at once, with no undo left', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		await page.clock.install();
		await asked(db, page, fakeModel, seedTicket('Throttled timers'));
		await page.clock.pauseAt(new Date(Date.now() + 1000));
		await page.keyboard.press('1');
		await expect(notice(page).getByRole('button', { name: 'Rückgängig' })).toBeVisible();

		await page.clock.fastForward(12_000); // fires each due timer once, as a throttled tab does

		await expect(notice(page)).toBeHidden();
	});
});
