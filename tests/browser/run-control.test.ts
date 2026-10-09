import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { createProfile, createRun, finishRun } from '../../src/lib/server/domain/runs.ts';
import type { FakeModel } from './fake-model.ts';
import { expect, open, test, type SeededTicket } from './fixtures.ts';

const HUMAN: Actor = { kind: 'user' };

const tabsOf = (view: Page) =>
	view.getByRole('navigation', { name: 'Runs dieses Tickets' }).getByRole('listitem');
const confirmationOf = (page: Page) => page.getByRole('dialog', { name: /^Run \d+ abbrechen\?$/ });
const appBarOf = (page: Page) => page.getByRole('contentinfo', { name: 'App-Leiste' });

/**
 * Two profiles on the fake model in a pool of their own (one run at a time), and an ended run of the ticket with the
 * second one: it is the profile the project used last, so the start form must choose it over the first by name.
 */
function seedProfiles(db: DatabaseSync, model: FakeModel, ticket: SeededTicket) {
	const suffix = randomUUID().slice(0, 8);
	const pool = `browser-${suffix}`;
	const profile = (name: string) =>
		createProfile(db, HUMAN, {
			name,
			executor: 'builtin',
			provider: 'openai-compatible',
			base_url: model.baseUrl,
			model: 'fake',
			pool
		}).id;
	const other = { name: `Anderes ${suffix}` };
	profile(other.name);
	const lastUsed = { name: `Zuletzt ${suffix}`, id: profile(`Zuletzt ${suffix}`) };
	const earlier = createRun(db, HUMAN, { ticketId: ticket.id, profileId: lastUsed.id }).id;
	finishRun(db, HUMAN, earlier, { state: 'cancelled' });
	return { pool, lastUsed, other };
}

async function runCommand(page: Page, expectedDetail: string) {
	await page.keyboard.press(':');
	await page.keyboard.type('run');
	const first = page.getByRole('listbox').getByRole('option').first();
	await expect(first).toContainText(expectedDetail);
	await expect(first).not.toContainText('folgt');
	await page.keyboard.press('Enter');
}

async function stopWithConfirmation(page: Page) {
	const tabs = tabsOf(page);
	await page.keyboard.press('x');
	await expect(confirmationOf(page)).toContainText('lässt sich nicht rückgängig machen');
	await page.keyboard.press('Escape');
	await expect(confirmationOf(page)).toBeHidden();
	await expect(tabs.first()).toContainText('wartet auf Start');
	// x targets the run the trace shows (the waiting one), then the newest one still active
	for (const stopped of [tabs.nth(0), tabs.nth(1)]) {
		await page.keyboard.press('x');
		await expect(confirmationOf(page)).toBeVisible();
		await page.keyboard.press('y');
		await expect(stopped).toContainText('abgebrochen');
	}
}

async function expectFinished(view: Page, profile: string) {
	const newest = tabsOf(view).first();
	await expect(newest).toContainText(/Run \d+\s*fertig/);
	await expect(newest).toContainText(`${profile} · `);
	await expect(newest).toContainText(/Tokens 100 ein · 10 aus · 0,00\s\$/);
}

test('a run starts from the Run-Akte with the preselected profile, waits for its pool, is cancelled only after x y, and its tab shows the result live', async ({
	page,
	browser,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Build the export');
	const { pool, lastUsed } = seedProfiles(db, fakeModel, ticket);
	const phoneContext = await browser.newContext({ viewport: { width: 375, height: 667 } });
	const phone = await phoneContext.newPage();
	await open(phone, ticket.path);
	await open(page, ticket.path);
	await expect(page.getByLabel('Agent-Profil')).toHaveValue(String(lastUsed.id));

	fakeModel.reply('hang');
	await runCommand(page, `Run starten mit „${lastUsed.name}“`);
	await expect(tabsOf(page).first()).toContainText(/Run \d+\s*läuft/);
	await expect(tabsOf(phone).first()).toContainText(/Run \d+\s*läuft/);
	await page.getByRole('button', { name: 'Run starten (:run)' }).click();
	await expect(tabsOf(page).first()).toContainText(
		`wartet: Pool „${pool}“ ist voll (1 von 1 aktiv).`
	);

	await stopWithConfirmation(page);
	await expect(tabsOf(phone).nth(1)).toContainText('abgebrochen');

	fakeModel.reply({ text: 'Export gebaut.' });
	await runCommand(page, ':run');
	await expectFinished(page, lastUsed.name);
	await expectFinished(phone, lastUsed.name);
	await expect(page.getByRole('heading', { name: 'Abschlussbericht' })).toBeVisible();
	const sideways = () => document.querySelector('main')!.scrollWidth - innerWidth;
	expect(
		await phone.evaluate(sideways),
		'the tab row scrolls on its own, not the page'
	).toBeLessThanOrEqual(0);
	await page.keyboard.press('?');
	await expect(page.getByRole('list', { name: 'Gültige Tasten' })).not.toContainText(
		'Run abbrechen'
	);
	await page.keyboard.press('Escape');

	const firstStopped = tabsOf(page).nth(2).getByRole('link').first();
	await firstStopped.click();
	await expect(firstStopped).toHaveAttribute('aria-current', 'page');
	await expect(page).toHaveURL(/\?run=\d+$/);
	await phoneContext.close();
});

/** Expects exactly one toast with `text`, then closes it, so a later toast with the same text counts on its own. */
async function expectToast(page: Page, text: string) {
	const shown = page.locator('.toast', { hasText: text });
	await expect(shown).toHaveCount(1);
	await shown.getByRole('button', { name: 'Meldung schließen' }).click();
	await expect(shown).toHaveCount(0);
}

/** A run of the ticket on the fake model, in a pool of its own so that runs of other tickets work alongside. */
async function workingRun(db: DatabaseSync, page: Page, model: FakeModel, ticket: SeededTicket) {
	const suffix = randomUUID().slice(0, 8);
	const profileId = createProfile(db, HUMAN, {
		name: `Agent ${suffix}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: model.baseUrl,
		model: 'fake',
		pool: `browser-${suffix}`
	}).id;
	createRun(db, HUMAN, { ticketId: ticket.id, profileId });
	// the server's runner wakes only on events of its own process; releasing the (unset) halt wakes it
	expect((await page.request.delete('/api/halt')).ok()).toBe(true);
	return `Agent ${suffix}`;
}

test('a run halts in its Run-Akte while the run of another ticket keeps working, and resumes from its tab or with :fortsetzen, each time with a toast', async ({
	page,
	browser,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Halt here');
	const other = seedTicket('Keep going');
	fakeModel.reply('hang', 'hang', 'hang', 'hang');
	await open(page, ticket.path);
	await workingRun(db, page, fakeModel, ticket);
	await workingRun(db, page, fakeModel, other);
	const tabs = tabsOf(page);
	await expect(tabs.first()).toContainText(/Run \d+\s*läuft/);
	const halted = /Run \d+/.exec((await tabs.first().textContent()) ?? '')![0];

	await page.keyboard.press(':');
	await page.keyboard.type('anhalten');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: `${halted} anhalten?` })).toContainText(
		'andere Runs laufen weiter'
	);
	await page.keyboard.press('y');

	await expectToast(page, `${halted} angehalten. :fortsetzen setzt ihn fort.`);
	await expect(tabs.first()).toContainText(`${halted} angehalten`);
	await expect(page.getByText('angehalten — :fortsetzen setzt ihn fort')).toBeVisible();
	// the run of the other ticket is the one agent still at work
	await expect(appBarOf(page).getByText('arbeitet', { exact: true })).toBeVisible();
	const phoneContext = await browser.newContext({ viewport: { width: 320, height: 640 } });
	const phone = await phoneContext.newPage();
	await open(phone, ticket.path);
	await expect(tabsOf(phone).first().getByRole('button', { name: 'Fortsetzen' })).toBeVisible();
	const sideways = () => document.documentElement.scrollWidth - innerWidth;
	expect(await phone.evaluate(sideways), 'a halted tab fits a phone').toBeLessThanOrEqual(0);
	await phoneContext.close();

	await tabs.first().getByRole('button', { name: 'Fortsetzen' }).click();
	await expectToast(page, '1 Run setzt fort.');
	await expect(tabs.first()).toContainText(/läuft/);
	await expect(tabs.first()).toContainText(`Fortsetzung nach Anhalten · aus ${halted}`);
	await expect(tabs.nth(1).getByRole('button', { name: 'Fortsetzen' })).toHaveCount(0);

	await tabs.first().getByRole('button', { name: 'Anhalten' }).click();
	await page.keyboard.press('y');
	await expect(tabs.first()).toContainText('angehalten');
	await page.keyboard.press(':');
	await page.keyboard.type('fortsetzen');
	await expect(page.getByRole('listbox').getByRole('option').first()).toContainText(
		/:fortsetzen\s*Run \d+ fortsetzen/
	);
	await page.keyboard.press('Enter');
	await expectToast(page, '1 Run setzt fort.');
	await expect(tabs).toHaveCount(3);
	await expect(tabs.first()).toContainText(/läuft/);
	// the run of the other ticket is the one agent still at work
	await expect(appBarOf(page).getByText('arbeitet', { exact: true })).toBeVisible();
});

test('a command the Run-Akte binds with bindCommands appears in the command line there and is gone once the view is left', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Bind a view command');
	const { other } = seedProfiles(db, fakeModel, ticket);
	await open(page, ticket.path);

	// ":run <other profile>" is bound by this very Run-Akte; its unique profile name proves it is THIS view's own entry
	const otherProfileRun = page.getByRole('option', { name: `:run ${other.name}` });

	await page.keyboard.press(':');
	await page.keyboard.type('run');
	await expect(otherProfileRun).toBeVisible();
	// the command sheet is modal: the first Escape clears the line, the second closes the sheet
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');

	await page
		.getByRole('navigation', { name: 'Ansichten' })
		.getByRole('link', { name: 'kabai studio' })
		.click();
	await expect(page).toHaveURL('/');

	await page.keyboard.press(':');
	await page.keyboard.type('run');
	await expect(otherProfileRun).toHaveCount(0);
});
