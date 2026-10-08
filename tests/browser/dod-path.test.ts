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
import type { Page } from '@playwright/test';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { createProfile } from '../../src/lib/server/domain/runs.ts';
import type { FakeModel } from './fake-model.ts';
import { expect, open, sidewaysScrollers, test } from './fixtures.ts';

const HUMAN: Actor = { kind: 'user' };
// Always refused (there is no column -1), so three of these in a row trip the loop guard's "failing calls" rule.
const FAILING_CALL = { call: { name: 'move_ticket', args: { column_id: -1 } } } as const;
type NewTicket = { id: number; ref: string; path: string };

const spurOf = (page: Page) => page.getByRole('region', { name: 'Spur' });
const tabsOf = (page: Page) =>
	page.getByRole('navigation', { name: 'Runs dieses Tickets' }).getByRole('listitem');

/**
 * Once a ticket has run tabs, their own row is meant to scroll sideways inside itself rather than widen the page
 * (`RunControl.svelte`'s `.tabs { overflow-x: auto }`), so only the page itself must stay within the viewport here.
 */
function pageFitsWidth(page: Page): Promise<number> {
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

function latestRunId(db: DatabaseSync, ticketId: number): number {
	return runId(db, ticketId, 'DESC');
}

// The ticket's very first run: its fresh run may already exist by the time this reads the database, so "latest"
// would race against the recovery it just triggered.
function firstRunId(db: DatabaseSync, ticketId: number): number {
	return runId(db, ticketId, 'ASC');
}

function runId(db: DatabaseSync, ticketId: number, order: 'ASC' | 'DESC'): number {
	return (
		db
			.prepare(`SELECT id FROM runs WHERE ticket_id = ? ORDER BY id ${order} LIMIT 1`)
			.get(ticketId) as { id: number }
	).id;
}

/**
 * Polls the database for the run's own state instead of the page: the live view can take much longer than the
 * underlying change to reflect it, while the row itself flips the moment the server commits it.
 */
async function waitForRunState(
	db: DatabaseSync,
	runId: number,
	state: string,
	timeoutMs = 120_000
) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const row = db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: string };
		if (row.state === state) return;
		if (Date.now() > deadline)
			throw new Error(`Run ${runId} did not reach state "${state}" within ${timeoutMs}ms.`);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

/** Queues the calls of a run stuck on the same failing call: two hints, then a stall that hands off to a fresh run. */
function scriptStuckRun(model: FakeModel) {
	for (let round = 0; round < 3; round++) model.reply(FAILING_CALL, FAILING_CALL, FAILING_CALL);
}

/** Lets the run an answered question queues start right away, instead of waiting out the undo window. */
async function skipAnswerUndo(page: Page, db: DatabaseSync, ticketId: number) {
	const queued = latestRunId(db, ticketId);
	db.prepare('UPDATE runs SET not_before = NULL WHERE id = ?').run(queued);
	expect((await page.request.delete('/api/halt')).ok()).toBe(true);
}

test('the whole product works keyboard-only end to end: a new project and ticket, a stuck run that recovers on its own, a question answered in the queue, and the kill switch', async ({
	page,
	db,
	fakeModel
}) => {
	// Nine scripted calls through the loop guard, each a real model request plus a real studio tool call, run
	// noticeably slower than the rest of the path.
	test.setTimeout(300_000);
	const key = await enterAndCreateProject(page);
	const { chosenId, chosenName } = seedProfiles(db, fakeModel);
	const ticket = await createFirstTicket(page, key, db);
	await page.getByLabel('Agent-Profil').selectOption(String(chosenId));

	scriptStuckRun(fakeModel);
	fakeModel.reply({ text: 'Nothing changed yet; the ticket stays where it is.' });
	await runCommand(page, `Run starten mit „${chosenName}“`);
	await expectStuckRunRecovers(page, db, ticket);

	fakeModel.reply({
		call: {
			name: 'request_human',
			args: { question: 'Ship now or wait for review?', options: [{ label: 'Jetzt' }] }
		}
	});
	await runCommand(page, `Run starten mit „${chosenName}“`);
	await askAndAnswerQuestion(page, db, ticket.id, fakeModel, 'Ship now or wait for review?');

	// the runner still has to claim the queued follow-up run; polling the row is the stable signal
	await waitForRunState(db, latestRunId(db, ticket.id), 'running');
	await open(page, ticket.path);
	const resumed = tabsOf(page).first();
	await expect(resumed).toContainText('Fortsetzung nach deiner Antwort');
	await expect(resumed).toContainText('läuft');
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

async function createFirstTicket(page: Page, key: string, db: DatabaseSync): Promise<NewTicket> {
	await page.getByLabel('Titel').fill('Walk the whole product end to end');
	await page.keyboard.press('Enter');
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
 * Pinned to the stuck run itself (it stops being the newest once its fresh run exists), this follows that run's own
 * "continues as" link, then the overview page's link back into it — the DoD path's own mutation probe target.
 */
async function expectStuckRunRecovers(page: Page, db: DatabaseSync, ticket: NewTicket) {
	const run1 = firstRunId(db, ticket.id);
	// Polling the row sidesteps how much longer the live view can take to reflect the chain's end than the chain
	// itself takes to run.
	await waitForRunState(db, run1, 'paused');
	await open(page, `${ticket.path}?run=${run1}`); // a fresh, complete snapshot of the settled run
	const spur = spurOf(page);
	await expect(spur.getByText('Eingriff: Stillstand')).toHaveCount(3);

	const continued = spur.getByRole('link', { name: /^setzt fort in Run/ });
	await continued.focus();
	await page.keyboard.press('Enter');
	await expect(tabsOf(page).first()).toContainText('frischer Run nach Stillstand oder Längenlimit');
	await expect(spur.getByRole('heading', { name: 'Abschlussbericht' })).toBeVisible();

	await page.keyboard.press('g');
	await page.keyboard.press('s');
	const row = page
		.getByRole('region', { name: 'Zuletzt beendet' })
		.getByRole('listitem')
		.filter({ hasText: ticket.ref });
	const link = row.getByRole('link', { name: ticket.ref });
	await link.focus();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(new RegExp(`${ticket.path}\\?run=\\d+$`));
	// This navigation lands back on the ticket page; the next command needs its view commands mounted first.
	await expect(page.getByRole('button', { name: 'Run starten (:run)' })).toBeVisible();
}

async function askAndAnswerQuestion(
	page: Page,
	db: DatabaseSync,
	ticketId: number,
	model: FakeModel,
	question: string
) {
	const spur = spurOf(page);
	await expect(spur).toContainText('wartet auf deine Antwort');
	const toQueue = spur.getByRole('link', { name: /Takt/ });
	await toQueue.focus();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL('/takt');

	const card = page.getByRole('heading', { name: question });
	await expect(card).toBeVisible();
	model.reply('hang'); // the run that continues once the undo window is skipped below
	await page.keyboard.press('1');
	await expect(card).toBeHidden();
	await skipAnswerUndo(page, db, ticketId);
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
	await expect(page.getByText(/^Angehalten · \d+ pausiert$/)).toBeVisible();

	model.reply('hang'); // the run :fortsetzen all wakes
	await command(page, 'fortsetzen all');
	await expect(page.getByText(/^Angehalten · \d+ pausiert$/)).toBeHidden();

	await confirmCommand(page, 'stop', 'Alle Agents stoppen?');
	await expect(page.getByText(/^Gestoppt · \d+ wartend$/)).toBeVisible();

	// Releases the kill switch again: this server stays up for the rest of the suite, and a later test's run must
	// not start into a stop that this one left engaged.
	await command(page, 'fortsetzen all');
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

test.describe('on a phone', () => {
	test.use({ viewport: { width: 375, height: 667 }, hasTouch: true });

	test('the same walkthrough works by pointer and tap at 375 px, with no view scrolling sideways', async ({
		page,
		db,
		fakeModel
	}) => {
		// Nine scripted calls through the loop guard, each a real model request plus a real studio tool call, run
		// noticeably slower than the rest of the path.
		test.setTimeout(300_000);
		await open(page, '/');
		await expect(page.getByText('Kein Agent arbeitet.')).toBeVisible();
		expect(await sidewaysScrollers(page)).toEqual([]);

		const key = await createProjectByTap(page);
		expect(await sidewaysScrollers(page)).toEqual([]);
		const { chosenId } = seedProfiles(db, fakeModel);
		const ticket = await createFirstTicketByTap(page, key, db);
		expect(await sidewaysScrollers(page)).toEqual([]);
		await page.getByLabel('Agent-Profil').selectOption(String(chosenId));

		scriptStuckRun(fakeModel);
		fakeModel.reply({ text: 'Nothing changed yet; the ticket stays where it is.' });
		await page.getByRole('button', { name: 'Run starten (:run)' }).tap();
		await expect(tabsOf(page).first()).toContainText(/Run \d+/);
		await expectStuckRunRecoversByTap(page, db, ticket);
		expect(await pageFitsWidth(page)).toBeLessThanOrEqual(0);

		await askAndAnswerQuestionByTap(page, db, ticket.id, fakeModel);
		expect(await pageFitsWidth(page)).toBeLessThanOrEqual(0);
		await exerciseKillSwitchByTap(page, db, fakeModel, ticket);
	});
});

async function createProjectByTap(page: Page): Promise<string> {
	await command(page, 'projekte');
	const key = uniqueKey();
	await page.getByLabel('Name', { exact: true }).fill(`Walkthrough ${key}`);
	await page.getByLabel('Key', { exact: true }).fill(key.toLowerCase());
	await page.getByRole('button', { name: 'Projekt anlegen' }).tap();
	await expect(page).toHaveURL(`/p/${key}`);
	return key;
}

async function createFirstTicketByTap(
	page: Page,
	key: string,
	db: DatabaseSync
): Promise<NewTicket> {
	await page.getByLabel('Titel').fill('Walk the whole product end to end');
	await page.getByRole('button', { name: 'Ticket anlegen' }).tap();
	const path = `/p/${key}/t/1`;
	await expect(page).toHaveURL(path);
	return { id: ticketIdOf(db, key), ref: `${key}-1`, path };
}

async function expectStuckRunRecoversByTap(page: Page, db: DatabaseSync, ticket: NewTicket) {
	const run1 = firstRunId(db, ticket.id);
	// Polling the row sidesteps how much longer the live view can take to reflect the chain's end than the chain
	// itself takes to run.
	await waitForRunState(db, run1, 'paused');
	await open(page, `${ticket.path}?run=${run1}`); // a fresh, complete snapshot of the settled run
	const spur = spurOf(page);
	await expect(spur.getByText('Eingriff: Stillstand')).toHaveCount(3);

	await spur.getByRole('link', { name: /^setzt fort in Run/ }).tap();
	await expect(tabsOf(page).first()).toContainText('frischer Run nach Stillstand oder Längenlimit');
	await expect(spur.getByRole('heading', { name: 'Abschlussbericht' })).toBeVisible();

	await page
		.getByRole('navigation', { name: 'Ansichten' })
		.getByRole('link', { name: 'Stellwerk' })
		.tap();
	const row = page
		.getByRole('region', { name: 'Zuletzt beendet' })
		.getByRole('listitem')
		.filter({ hasText: ticket.ref });
	await row.getByRole('link', { name: ticket.ref }).tap();
	await expect(page).toHaveURL(new RegExp(`${ticket.path}\\?run=\\d+$`));
	// This navigation lands back on the ticket page; the next action needs its controls mounted first.
	await expect(page.getByRole('button', { name: 'Run starten (:run)' })).toBeVisible();
}

async function askAndAnswerQuestionByTap(
	page: Page,
	db: DatabaseSync,
	ticketId: number,
	model: FakeModel
) {
	const question = 'Ship now or wait for review?';
	model.reply({
		call: { name: 'request_human', args: { question, options: [{ label: 'Jetzt' }] } }
	});
	await page.getByRole('button', { name: 'Run starten (:run)' }).tap();
	await expect(spurOf(page)).toContainText('wartet auf deine Antwort');

	await page
		.getByRole('navigation', { name: 'Ansichten' })
		.getByRole('link', { name: /Takt/ })
		.tap();
	await expect(page).toHaveURL('/takt');
	const card = page.getByRole('heading', { name: question });
	await expect(card).toBeVisible();
	model.reply('hang');
	await page.getByRole('group', { name: 'Antworten' }).getByRole('button', { name: /Jetzt/ }).tap();
	await expect(card).toBeHidden();
	await skipAnswerUndo(page, db, ticketId);
}

async function exerciseKillSwitchByTap(
	page: Page,
	db: DatabaseSync,
	model: FakeModel,
	ticket: NewTicket
) {
	// the runner still has to claim the queued follow-up run; polling the row is the stable signal
	await waitForRunState(db, latestRunId(db, ticket.id), 'running');
	await open(page, ticket.path);
	const spur = spurOf(page);
	const resumed = tabsOf(page).first();
	await expect(resumed).toContainText('Fortsetzung nach deiner Antwort');
	await expect(resumed).toContainText('läuft');

	await tabsOf(page).getByRole('button', { name: 'Anhalten' }).tap();
	await page.getByRole('button', { name: 'Anhalten (y)' }).tap();
	await expect(spur).toContainText('angehalten — :fortsetzen setzt ihn fort');

	model.reply('hang'); // the run the per-tab Fortsetzen button wakes
	await tabsOf(page).getByRole('button', { name: 'Fortsetzen' }).tap();
	await expect(spur).not.toContainText('angehalten');

	await confirmCommand(page, 'stop', 'Alle Agents stoppen?');
	await expect(page.getByText(/^Gestoppt · \d+ wartend$/)).toBeVisible();

	// Releases the kill switch again: this server stays up for the rest of the suite, and a later test's run must
	// not start into a stop that this one left engaged.
	await page.getByRole('button', { name: 'Fortsetzen' }).tap();
	await expect(page.getByText(/^Gestoppt · \d+ wartend$/)).toBeHidden();
}
