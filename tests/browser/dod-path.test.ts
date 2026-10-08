/**
 * One continuous walk through the whole product with a scripted fake model instead of a real one, so a broken
 * view-to-view transition fails here instead of slipping through the per-feature tests that only check one step at
 * a time. Derived from the project's definition of done and its acceptance checklist, picked for what a keyboard-
 * or pointer-driven browser test can actually verify:
 *
 * 1. The overview page is the entry point: with no run active it says so.
 * 2. Create a project from the built-in column template; it opens straight into the project.
 * 3. Create the first ticket in that project.
 * 4. Choose an agent profile for a run.
 * 5. Start a run and watch its trace fill in live.
 * 6. A run that fails the very same call three times running gets a hint, twice; a third stall then hands off to
 *    a fresh run automatically — never a silent "done" with nothing changed.
 * 7. The overview page lists that outcome, linking back into the run that produced it.
 * 8. A run that asks the human a question shows up in the question queue; answering with a fixed option lets it
 *    continue.
 * 9. All runs pause on the kill switch and resume from it.
 * 10. The kill switch stops every run right away.
 *
 * Not covered here: a real model server, a permanent deployment and CI gates (none of them fit a browser test); and
 * the follow-up question for a run whose own fresh run is *also* exhausted — its fixed answer options are not built
 * yet, so today it only takes free text.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Locator, Page } from '@playwright/test';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { createProfile } from '../../src/lib/server/domain/runs.ts';
import type { FakeModel } from './fake-model.ts';
import { expect, open, sidewaysScrollers, test, type SeededTicket } from './fixtures.ts';

const HUMAN: Actor = { kind: 'user' };
// Always refused (there is no column -1), so three of these in a row trip the loop guard's "failing calls" rule.
const FAILING_CALL = { call: { name: 'move_ticket', args: { column_id: -1 } } } as const;
const QUESTION = 'Ship now or wait for review?';
// Measured 0.2–1.1 s for the live updates this walk waits for; well above that to stay clear of a loaded machine.
const LIVE = { timeout: 15_000 };

const spurOf = (page: Page) => page.getByRole('region', { name: 'Spur' });
const tabsOf = (page: Page) =>
	page.getByRole('navigation', { name: 'Runs dieses Tickets' }).getByRole('listitem');

/**
 * Once a ticket has run tabs, their own row is meant to scroll sideways inside itself rather than widen the page
 * (`RunControl.svelte`'s `.tabs { overflow-x: auto }`), so only the page itself must stay within the viewport here.
 */
function pageOverflowPx(page: Page): Promise<number> {
	return page.evaluate(() => document.querySelector('main')!.scrollWidth - innerWidth);
}

function uniqueKey(): string {
	return `D${randomUUID().slice(0, 6).toUpperCase()}`;
}

/** One profile on the fake model to run with, and a second one so picking it is a real choice. */
function seedProfiles(db: DatabaseSync, model: FakeModel) {
	const chosenName = `Fake model ${randomUUID().slice(0, 8)}`;
	createProfile(db, HUMAN, {
		name: `Other profile ${randomUUID().slice(0, 8)}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: 'http://127.0.0.1:1',
		model: 'fake'
	});
	const chosenId = createProfile(db, HUMAN, {
		name: chosenName,
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: model.baseUrl,
		model: 'fake'
	}).id;
	return { chosenId, chosenName };
}

function newestRunId(db: DatabaseSync, ticketId: number): number {
	return (
		db
			.prepare('SELECT id FROM runs WHERE ticket_id = ? ORDER BY id DESC LIMIT 1')
			.get(ticketId) as { id: number }
	).id;
}

/** Queues the calls of a run stuck on the same failing call: two hints, then a stall that hands off to a fresh run. */
function scriptStuckRun(model: FakeModel) {
	for (let round = 0; round < 3; round++) model.reply(FAILING_CALL, FAILING_CALL, FAILING_CALL);
}

/** Waits for the element to actually be there before acting on it, so a missing one fails fast instead of hanging. */
async function tapVisible(locator: Locator): Promise<void> {
	await expect(locator).toBeVisible();
	await locator.tap();
}

async function focusAndEnter(page: Page, locator: Locator): Promise<void> {
	await expect(locator).toBeVisible();
	await locator.focus();
	await page.keyboard.press('Enter');
}

/**
 * Clears the undo window the run an answered question queues would otherwise wait out, and wakes the runner. Scoped
 * to the one row resumed from `askingRunId` and still `queued`: the card hides optimistically before the answer's
 * POST resolves, so reading "the newest run" here instead would race that request.
 */
async function resumeAnsweredRun(page: Page, db: DatabaseSync, askingRunId: number) {
	const changes = db
		.prepare(`UPDATE runs SET not_before = NULL WHERE resumed_from_run_id = ? AND state = 'queued'`)
		.run(askingRunId).changes;
	expect(changes).toBe(1);
	expect((await page.request.delete('/api/halt')).ok()).toBe(true);
}

test('the whole product works keyboard-only end to end: a new project and ticket, a stuck run that recovers on its own, a question answered in the queue, and the kill switch', async ({
	page,
	db,
	fakeModel
}) => {
	const key = await enterAndCreateProject(page);
	const { chosenId, chosenName } = seedProfiles(db, fakeModel);
	const ticket = await createFirstTicket(page, key, db, () => page.keyboard.press('Enter'));
	await page.getByLabel('Agent-Profil').selectOption(String(chosenId));

	scriptStuckRun(fakeModel);
	fakeModel.reply({ text: 'Nothing changed yet; the ticket stays where it is.' });
	await runCommand(page, `Run starten mit „${chosenName}“`);
	await expectStuckRunRecovers(
		page,
		ticket,
		(locator) => focusAndEnter(page, locator),
		async () => {
			await page.keyboard.press('g');
			await page.keyboard.press('s');
		}
	);

	fakeModel.reply({
		call: { name: 'request_human', args: { question: QUESTION, options: [{ label: 'Jetzt' }] } }
	});
	await runCommand(page, `Run starten mit „${chosenName}“`);
	const askingRunId = await askAndAnswerQuestion(page, db, ticket, fakeModel);

	await page.goBack();
	await expect(page).toHaveURL(ticket.path);
	await expect(tabsOf(page).first()).toContainText('Fortsetzung nach deiner Antwort', LIVE);
	await resumeAnsweredRun(page, db, askingRunId);
	await expect(tabsOf(page).first()).toContainText('läuft', LIVE);

	await exerciseKillSwitch(page, fakeModel);
});

async function enterAndCreateProject(page: Page): Promise<string> {
	await open(page, '/');
	await expect(page.getByText('Kein Agent arbeitet.')).toBeVisible();
	await command(page, 'projekte');
	const key = uniqueKey();
	await page.getByLabel('Name', { exact: true }).fill(`Walkthrough ${key}`);
	await page.getByLabel('Key', { exact: true }).fill(key.toLowerCase());
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(`/p/${key}`);
	return key;
}

async function createFirstTicket(
	page: Page,
	key: string,
	db: DatabaseSync,
	submit: () => Promise<void>
): Promise<SeededTicket> {
	await page.getByLabel('Titel').fill('Walk the whole product end to end');
	await submit();
	const path = `/p/${key}/t/1`;
	await expect(page).toHaveURL(path);
	return { id: ticketIdOf(db, key), ref: `${key}-1`, path };
}

function ticketIdOf(db: DatabaseSync, key: string): number {
	return (
		db
			.prepare(
				`SELECT t.id AS id FROM tickets t JOIN projects p ON p.id = t.project_id
				 WHERE p.key = ? AND t.number = 1`
			)
			.get(key) as { id: number }
	).id;
}

async function runCommand(page: Page, expectedDetail: string) {
	await page.keyboard.press(':');
	await page.keyboard.type('run');
	const first = page.getByRole('listbox').getByRole('option').first();
	await expect(first).toContainText(expectedDetail);
	await page.keyboard.press('Enter');
	// requestSubmit() fires the enhanced form's fetch without waiting for it, so a step right after this one must
	// wait for visible proof the run exists instead of racing a DB read or a navigation against that fetch.
	await expect(tabsOf(page).first()).toContainText(/Run \d+/);
}

/**
 * Pinned to the stuck run itself (it stops being the newest once its fresh run exists): waits for the Run-Akte to
 * follow the fresh run and its finished report live, with no reload, then opens the stuck run's own tab for its
 * three stall entries, then follows the overview page's link back into it — the DoD path's own mutation probe
 * target. `activate` is how the current input mode follows a link; `goToOverview` how it reaches the overview page.
 */
async function expectStuckRunRecovers(
	page: Page,
	ticket: SeededTicket,
	activate: (locator: Locator) => Promise<void>,
	goToOverview: () => Promise<void>
) {
	const spur = spurOf(page);
	await expect(tabsOf(page).first()).toContainText(
		'frischer Run nach Stillstand oder Längenlimit',
		LIVE
	);
	await expect(spur.getByRole('heading', { name: 'Abschlussbericht' })).toBeVisible(LIVE);

	const stuckTab = tabsOf(page).nth(1).getByRole('link').first();
	await expect(stuckTab).toBeVisible();
	await activate(stuckTab);
	await expect(spur.getByText('Eingriff: Stillstand')).toHaveCount(3);

	await goToOverview();
	const row = page
		.getByRole('region', { name: 'Zuletzt beendet' })
		.getByRole('listitem')
		.filter({ hasText: ticket.ref });
	const link = row.getByRole('link', { name: ticket.ref });
	await expect(link).toBeVisible();
	await activate(link);
	await expect(page).toHaveURL(new RegExp(`${ticket.path}\\?run=\\d+$`));
	await expect(page.getByRole('button', { name: 'Run starten (:run)' })).toBeVisible();
}

/** Answers the queued question and returns the asking run's id, to target its resume row precisely afterwards. */
async function askAndAnswerQuestion(
	page: Page,
	db: DatabaseSync,
	ticket: SeededTicket,
	model: FakeModel
): Promise<number> {
	const spur = spurOf(page);
	await expect(spur).toContainText('wartet auf deine Antwort', LIVE);
	const askingRunId = newestRunId(db, ticket.id);
	await focusAndEnter(page, spur.getByRole('link', { name: /Takt/ }));
	await expect(page).toHaveURL('/takt');

	const card = page.getByRole('heading', { name: QUESTION });
	await expect(card).toBeVisible(LIVE);
	model.reply('hang'); // the run the answer resumes, once the undo window is skipped
	await page.keyboard.press('1');
	await expect(card).toBeHidden();
	await expect(page.getByText(`Antwort gesendet · ${ticket.ref} setzt in 10 s fort`)).toBeVisible();
	return askingRunId;
}

/**
 * The Run-Akte's own view binds `:anhalten` to pausing only its own run, so the kill switch is exercised from the
 * overview page instead, where that view command does not shadow it.
 */
async function exerciseKillSwitch(page: Page, model: FakeModel) {
	// A fresh load, not a client-side g s: the Run-Akte's own view command for :anhalten must not still be the one
	// the command line resolves to.
	await open(page, '/');
	await confirmCommand(page, 'anhalten', 'Alle Agents anhalten?');
	await expect(page.getByText('Angehalten · 1 pausiert', { exact: true })).toBeVisible();

	model.reply('hang'); // the run :fortsetzen all wakes
	await command(page, 'fortsetzen all');
	await expect(page.getByText(/^Angehalten · \d+ pausiert$/)).toBeHidden();

	await confirmCommand(page, 'stop', 'Alle Agents stoppen?');
	await expect(page.getByText(/^Gestoppt · \d+ wartend$/)).toBeVisible();

	await command(page, 'fortsetzen all'); // also proves resume works from a stop, not only from a pause
	await expect(page.getByText(/^Gestoppt · \d+ wartend$/)).toBeHidden();
}

async function command(page: Page, line: string) {
	await page.keyboard.press(':');
	await page.keyboard.type(line);
	await page.keyboard.press('Enter');
}

async function confirmCommand(page: Page, line: string, dialog: string) {
	await command(page, line);
	await expect(page.getByRole('dialog', { name: dialog })).toBeVisible();
	await page.keyboard.press('y');
}

// Whatever a test engaged (pause or stop) must not reach the next one; a no-op when nothing is set.
test.afterEach(async ({ page }) => {
	expect((await page.request.delete('/api/halt')).ok()).toBe(true);
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 375, height: 667 }, hasTouch: true });

	test('the same walkthrough works by pointer and tap at 375 px, with no view scrolling sideways', async ({
		page,
		db,
		fakeModel
	}) => {
		await open(page, '/');
		await expect(page.getByText('Kein Agent arbeitet.')).toBeVisible();
		expect(await sidewaysScrollers(page)).toEqual([]);

		const key = await createProjectByTap(page);
		expect(await sidewaysScrollers(page)).toEqual([]);
		const { chosenId } = seedProfiles(db, fakeModel);
		const ticket = await createFirstTicket(page, key, db, () =>
			tapVisible(page.getByRole('button', { name: 'Ticket anlegen' }))
		);
		expect(await sidewaysScrollers(page)).toEqual([]);
		await page.getByLabel('Agent-Profil').selectOption(String(chosenId));

		scriptStuckRun(fakeModel);
		fakeModel.reply({ text: 'Nothing changed yet; the ticket stays where it is.' });
		await tapVisible(page.getByRole('button', { name: 'Run starten (:run)' }));
		await expect(tabsOf(page).first()).toContainText(/Run \d+/);
		await expectStuckRunRecovers(page, ticket, tapVisible, async () => {
			await tapVisible(
				page.getByRole('navigation', { name: 'Ansichten' }).getByRole('link', { name: 'Stellwerk' })
			);
		});
		expect(await pageOverflowPx(page)).toBeLessThanOrEqual(0);

		const askingRunId = await askAndAnswerQuestionByTap(page, db, ticket, fakeModel);
		expect(await pageOverflowPx(page)).toBeLessThanOrEqual(0);

		await page.goBack();
		await expect(page).toHaveURL(ticket.path);
		await expect(tabsOf(page).first()).toContainText('Fortsetzung nach deiner Antwort', LIVE);
		await resumeAnsweredRun(page, db, askingRunId);
		await expect(tabsOf(page).first()).toContainText('läuft', LIVE);

		await exerciseKillSwitchByTap(page, fakeModel);
	});
});

async function createProjectByTap(page: Page): Promise<string> {
	await command(page, 'projekte');
	const key = uniqueKey();
	await page.getByLabel('Name', { exact: true }).fill(`Walkthrough ${key}`);
	await page.getByLabel('Key', { exact: true }).fill(key.toLowerCase());
	await tapVisible(page.getByRole('button', { name: 'Projekt anlegen' }));
	await expect(page).toHaveURL(`/p/${key}`);
	return key;
}

async function askAndAnswerQuestionByTap(
	page: Page,
	db: DatabaseSync,
	ticket: SeededTicket,
	model: FakeModel
): Promise<number> {
	model.reply({
		call: { name: 'request_human', args: { question: QUESTION, options: [{ label: 'Jetzt' }] } }
	});
	await tapVisible(page.getByRole('button', { name: 'Run starten (:run)' }));
	await expect(spurOf(page)).toContainText('wartet auf deine Antwort', LIVE);
	const askingRunId = newestRunId(db, ticket.id);

	await tapVisible(
		page.getByRole('navigation', { name: 'Ansichten' }).getByRole('link', { name: /Takt/ })
	);
	await expect(page).toHaveURL('/takt');
	const card = page.getByRole('heading', { name: QUESTION });
	await expect(card).toBeVisible(LIVE);
	model.reply('hang');
	await tapVisible(
		page.getByRole('group', { name: 'Antworten' }).getByRole('button', { name: /Jetzt/ })
	);
	await expect(card).toBeHidden();
	await expect(page.getByText(`Antwort gesendet · ${ticket.ref} setzt in 10 s fort`)).toBeVisible();
	return askingRunId;
}

async function exerciseKillSwitchByTap(page: Page, model: FakeModel) {
	const spur = spurOf(page);
	await tapVisible(tabsOf(page).getByRole('button', { name: 'Anhalten' }));
	await tapVisible(page.getByRole('button', { name: 'Anhalten (y)' }));
	await expect(spur).toContainText('angehalten — :fortsetzen setzt ihn fort');

	model.reply('hang'); // the run the per-tab Fortsetzen button wakes
	await tapVisible(tabsOf(page).getByRole('button', { name: 'Fortsetzen' }));
	await expect(spur).not.toContainText('angehalten');

	await confirmCommand(page, 'stop', 'Alle Agents stoppen?');
	await expect(page.getByText(/^Gestoppt · \d+ wartend$/)).toBeVisible();

	await tapVisible(page.getByRole('button', { name: 'Fortsetzen' })); // also proves resume works from a stop
	await expect(page.getByText(/^Gestoppt · \d+ wartend$/)).toBeHidden();
}
