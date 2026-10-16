import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import * as board from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { requestHuman } from '../../src/lib/server/domain/questions.ts';
import { createProfile, createRun, finishRun, startRun } from '../../src/lib/server/domain/runs.ts';
import {
	expect,
	intoWorkStep,
	open,
	queueRun,
	sidewaysScrollers,
	test,
	type SeededTicket
} from './fixtures.ts';
import { pageOverflowX, WIDTHS } from './widths.ts';

const HUMAN: Actor = { kind: 'user' };

/** A run that asked a question and paused, as the runner leaves it after request_human. */
function asked(db: DatabaseSync, ticket: SeededTicket, question: string, optionLabels: string[]) {
	const profile = createProfile(db, HUMAN, {
		name: `Asker ${randomUUID()}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: 'http://127.0.0.1:1',
		model: 'fake'
	}).id;
	intoWorkStep(db, ticket.id);
	const run = createRun(db, HUMAN, { ticketId: ticket.id, profileId: profile }).id;
	startRun(db, HUMAN, run);
	requestHuman(db, { kind: 'agent', runId: run }, ticket.id, {
		question,
		options: optionLabels.map((label) => ({ label }))
	});
	finishRun(db, { kind: 'system' }, run, { state: 'paused' });
	return run;
}

function failedRun(db: DatabaseSync, ticketId: number) {
	const profile = createProfile(db, HUMAN, {
		name: `Failing ${randomUUID()}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: 'http://127.0.0.1:1',
		model: 'fake'
	}).id;
	intoWorkStep(db, ticketId);
	const run = createRun(db, HUMAN, { ticketId, profileId: profile }).id;
	startRun(db, HUMAN, run);
	finishRun(db, HUMAN, run, {
		state: 'failed',
		error: '[provider_unreachable] the model server is down'
	});
}

const tab = (page: Page, name: string | RegExp) => page.getByRole('tab', { name });
const decision = (page: Page) => page.getByTestId('decision');
const storedAnswer = (db: DatabaseSync, ticketId: number) =>
	db.prepare('SELECT answer FROM questions WHERE ticket_id = ?').get(ticketId) as {
		answer: string | null;
	};

test.describe('below 1300 px', () => {
	test.use({ viewport: { width: 1100, height: 800 } });

	test('the pivot offers fragen, läuft, angehalten and fertig with counts, and h, l and the arrows switch', async ({
		page,
		db,
		seedTicket
	}) => {
		asked(db, seedTicket('Pivot question'), 'Which pivot question?', ['Yes']);
		await open(page, '/takt');

		const names = await page.getByRole('tab').allTextContents();
		expect(names.map((name) => name.replace(/\s+/g, ' ').trim().replace(/ \d+$/, ''))).toEqual([
			'fragen',
			'läuft',
			'angehalten',
			'fertig'
		]);
		await expect(tab(page, /^fragen/)).toHaveAttribute('aria-selected', 'true');
		await expect(tab(page, /^fragen/)).toContainText('1');

		await page.keyboard.press('l');
		await expect(tab(page, /^läuft/)).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('l');
		await expect(tab(page, /^angehalten/)).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('h');
		await expect(tab(page, /^läuft/)).toHaveAttribute('aria-selected', 'true');
		await tab(page, /^läuft/).focus();
		await page.keyboard.press('ArrowRight');
		await expect(tab(page, /^angehalten/)).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('ArrowLeft');
		await expect(tab(page, /^läuft/)).toHaveAttribute('aria-selected', 'true');
	});

	test('the live content stands in the facet läuft below 1300 px', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const ticket = seedTicket('A working run');
		fakeModel.reply('hang');
		await open(page, '/takt');
		await queueRun(db, page, ticket.id, fakeModel);

		await expect(page.getByTestId('live-column')).toBeHidden();
		await tab(page, /^läuft/).click();
		const row = page.getByTestId('live-column').locator('li', { hasText: ticket.ref });
		await expect(row).toBeVisible();
		await expect(row).toContainText('Tokens je Minute');
	});

	test('the facet angehalten lists paused runs, resumes one by its button and all by the button above', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const first = seedTicket('First paused');
		const second = seedTicket('Second paused');
		fakeModel.reply('hang', 'hang');
		await open(page, '/takt');
		await queueRun(db, page, first.id, fakeModel);
		const firstRun = await runWorking(db, first.id);
		const { profileId } = db
			.prepare('SELECT agent_profile_id AS profileId FROM runs WHERE id = ?')
			.get(firstRun) as { profileId: number };
		intoWorkStep(db, second.id);
		createRun(db, HUMAN, { ticketId: second.id, profileId });
		expect((await page.request.post(`/api/runs/${firstRun}/pause`)).ok()).toBe(true);
		const secondRun = await runWorking(db, second.id);
		expect((await page.request.post(`/api/runs/${secondRun}/pause`)).ok()).toBe(true);

		await tab(page, /^angehalten/).click();
		const rows = page.getByTestId('paused-runs').locator('li');
		await expect(rows).toHaveCount(2);

		await page.getByRole('button', { name: `${first.ref} fortsetzen` }).click();
		await expect(rows).toHaveCount(1);
		await expect(rows.first()).toContainText(second.ref);

		await page.getByRole('button', { name: 'Alle fortsetzen' }).click();
		await expect(page.getByTestId('paused-runs')).toBeHidden();
		await expect(page.getByText('Kein Run ist angehalten.')).toBeVisible();
	});

	test('the facet fertig shows ended runs with their state and the way out of a failure', async ({
		page,
		db,
		seedTicket
	}) => {
		const ticket = seedTicket('Ended badly');
		failedRun(db, ticket.id);
		await open(page, '/takt');

		await tab(page, /^fertig/).click();
		const row = page.getByTestId('finished-runs').locator('li', { hasText: ticket.ref });
		await expect(row).toContainText('fehlgeschlagen');
		await expect(row).toContainText('the model server is down');
	});
});

test('a question is answered with i as free text and s moves it behind the next, u takes the answer back', async ({
	page,
	db,
	seedTicket
}) => {
	const first = seedTicket('Older question');
	const second = seedTicket('Newer question');
	asked(db, first, 'Which one comes first?', ['A', 'B', 'C']);
	asked(db, second, 'Which one comes second?', ['A']);
	await open(page, '/takt');
	await expect(decision(page)).toContainText('Which one comes first?');

	await page.keyboard.press('s');
	await expect(decision(page)).toContainText('Which one comes second?');

	await page.keyboard.press('i');
	await page.keyboard.type('my own words');
	await page.keyboard.press('Enter');
	await expect(page.getByText(`Antwort gesendet · ${second.ref}`)).toBeVisible();
	expect(JSON.parse(storedAnswer(db, second.id).answer!)).toEqual({ text: 'my own words' });

	await page.keyboard.press('u');
	await expect(decision(page)).toContainText('Which one comes second?');
	expect(storedAnswer(db, second.id).answer).toBeNull();

	await page.keyboard.press('s');
	await expect(decision(page)).toContainText('Which one comes first?');
	await page.keyboard.press('2');
	await expect(page.getByText(`Antwort gesendet · ${first.ref}`)).toBeVisible();
	expect(JSON.parse(storedAnswer(db, first.id).answer!)).toEqual({ option: 2 });
	await page.keyboard.press('u');
	await expect(decision(page)).toContainText('Which one comes first?');
});

test('the next card slides in, without a tilt, and with reduced motion nothing moves', async ({
	page,
	db,
	seedTicket
}) => {
	asked(db, seedTicket('Slide one'), 'Slide first?', ['A']);
	asked(db, seedTicket('Slide two'), 'Slide second?', ['A']);
	await open(page, '/takt');
	await page.keyboard.press('s');
	await expect(decision(page)).toContainText('Slide second?');
	expect(await decision(page).evaluate((card) => card.getAnimations().length)).toBeGreaterThan(0);
	expect(await decision(page).evaluate((card) => getComputedStyle(card).transform)).toBe('none');

	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.keyboard.press('s');
	await expect(decision(page)).toContainText('Slide first?');
	await page.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
	);
	expect(await decision(page).evaluate((card) => card.getAnimations().length)).toBe(0);
});

test.describe('from 1300 px', () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test('a card sliding in gives no facet a sideways scrollbar', async ({
		page,
		db,
		seedTicket
	}) => {
		asked(db, seedTicket('Clip one'), 'Clip first?', ['A']);
		asked(db, seedTicket('Clip two'), 'Clip second?', ['A']);
		await open(page, '/takt');
		await page.keyboard.press('s');

		expect(await decision(page).evaluate((card) => card.getAnimations().length)).toBeGreaterThan(0);
		expect(await sidewaysScrollers(page)).toEqual([]);
	});

	test('the live column stands beside the question with running runs, their ticker line and sparkline', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const ticket = seedTicket('A run at work');
		asked(db, seedTicket('Beside the column'), 'Is the column beside me?', ['Yes']);
		fakeModel.reply('hang');
		await open(page, '/takt');
		await queueRun(db, page, ticket.id, fakeModel);

		await expect(page.getByRole('tab')).toHaveCount(0);
		await expect(decision(page)).toBeVisible();
		const row = page.getByTestId('live-column').locator('li', { hasText: ticket.ref });
		await expect(row).toBeVisible();
		await expect(row).toContainText('Tokens je Minute');
		const [question, column] = await Promise.all([
			decision(page).boundingBox(),
			page.getByTestId('live-column').boundingBox()
		]);
		expect(column!.x).toBeGreaterThan(question!.x + question!.width - 1);
	});
});

test('on a phone one decision stands alone: tap to answer, undo from the notice, back from the app bar', async ({
	page,
	db,
	seedTicket
}) => {
	await page.setViewportSize({ width: 375, height: 667 });
	asked(db, seedTicket('Phone one'), 'Phone first?', ['Go', 'Stop']);
	asked(db, seedTicket('Phone two'), 'Phone second?', ['Go']);
	await open(page, '/');
	await page.goto('/takt');

	await expect(page.getByTestId('decision')).toHaveCount(1);
	await expect(decision(page)).toContainText('Phone first?');
	await page.getByRole('button', { name: /Go/ }).click();
	await expect(decision(page)).toContainText('Phone second?');
	const notice = page.locator('.rk-toast', { hasText: 'Antwort gesendet' });
	await expect(notice).toBeVisible();
	await expect(page.locator('.rk-toast')).toHaveCount(1);
	expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
	expect(await sidewaysScrollers(page)).toEqual([]);

	await notice.getByRole('button', { name: 'Rückgängig' }).click();
	await expect(decision(page)).toContainText('Phone first?');

	await page.getByRole('button', { name: 'zurück' }).click();
	await expect(page).toHaveURL('/');
});

for (const viewport of WIDTHS) {
	test(`the Takt fits ${viewport.width} px and scrolls sideways only inside its panorama`, async ({
		page,
		db,
		seedTicket
	}) => {
		await page.setViewportSize(viewport);
		asked(db, seedTicket('A question with a rather long title that has to wrap'), 'Does it fit?', [
			'A fairly long option label that wraps on a phone screen'
		]);
		await open(page, '/takt');
		await expect(decision(page)).toBeVisible();

		expect(await sidewaysScrollers(page)).toEqual([]);
		expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
	});
}

/** The id of the ticket's run once the runner has started it. */
async function runWorking(db: DatabaseSync, ticketId: number): Promise<number> {
	const state = () =>
		db
			.prepare("SELECT id FROM runs WHERE ticket_id = ? AND state = 'running' ORDER BY id DESC")
			.get(ticketId) as { id: number } | undefined;
	await expect.poll(() => state()?.id).toBeDefined();
	return state()!.id;
}
