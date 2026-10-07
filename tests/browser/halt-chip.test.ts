import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { expect, open, queueRun, test } from './fixtures.ts';

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

const chipOf = (view: Page) =>
	view.getByText(/^(Gestoppt · \d+ wartend|Angehalten · \d+ pausiert)$/);
const agentsOf = (view: Page) => view.getByRole('list', { name: 'Agents' });

/** Expects exactly one toast with `text`, then closes it, so a later toast with the same text counts on its own. */
async function expectToast(page: Page, text: string) {
	const shown = page.locator('.toast', { hasText: text });
	await expect(shown).toHaveCount(1);
	await shown.getByRole('button', { name: 'Meldung schließen' }).click();
	await expect(shown).toHaveCount(0);
}

const runningRunOf = (db: DatabaseSync, ticketId: number) =>
	db.prepare("SELECT id FROM runs WHERE ticket_id = ? AND state = 'running'").get(ticketId)!
		.id as number;

test('the stop chip appears after :stop at every width and disappears with a toast after :fortsetzen all, live in a second tab', async ({
	page,
	browser,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Keep working while halted');
	fakeModel.reply('hang');

	const wideContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
	const wide = await wideContext.newPage();

	await open(page, '/'); // default viewport is 1280 px
	await open(wide, '/');

	await queueRun(db, page, ticket.id, fakeModel);
	await expect(page.getByText(/^Fake model/)).toBeVisible();

	await confirmCommand(page, 'stop', 'Alle Agents stoppen?');

	// A phone tab opened only after the halt: its layout load, not a live event, must carry the halted state.
	const phoneContext = await browser.newContext({ viewport: { width: 375, height: 667 } });
	const phone = await phoneContext.newPage();
	await open(phone, '/');

	for (const view of [page, wide, phone]) {
		await expect(chipOf(view)).toHaveText('Gestoppt · 0 wartend');
		await expect(view.getByRole('button', { name: 'Fortsetzen' })).toBeVisible();
	}

	await command(page, 'fortsetzen all');

	for (const view of [page, wide, phone]) {
		await expect(chipOf(view)).toBeHidden();
	}
	await expectToast(page, '0 Runs setzen fort. Not-Aus gelöst: wartende Runs starten wieder.');

	await wideContext.close();
	await phoneContext.close();
});

test('the pause chip counts the runs :anhalten paused, and its Fortsetzen resumes them as :fortsetzen all does, with a toast', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Pause everything');
	fakeModel.reply('hang', 'hang');
	await open(page, '/');
	await queueRun(db, page, ticket.id, fakeModel);
	await expect(agentsOf(page)).toContainText('arbeitet');

	await confirmCommand(page, 'anhalten', 'Alle Agents anhalten?');

	await expect(chipOf(page)).toHaveText('Angehalten · 1 pausiert');
	await expect(agentsOf(page)).not.toContainText('arbeitet');
	await expectToast(page, 'Angehalten: 1 Run pausiert. :fortsetzen all setzt fort.');

	await page.getByRole('button', { name: 'Fortsetzen' }).click();

	await expect(chipOf(page)).toBeHidden();
	await expectToast(page, '1 Run setzt fort. Wartende Runs starten wieder.');
	await expect(agentsOf(page)).toContainText('arbeitet');
});

test(':fortsetzen all reports a halted run whose profile is gone instead of leaving it or the halt stuck', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Resume with a deleted profile');
	fakeModel.reply('hang');
	await open(page, '/');
	await queueRun(db, page, ticket.id, fakeModel);
	await expect(agentsOf(page)).toContainText('arbeitet');
	const halted = runningRunOf(db, ticket.id);
	expect((await page.request.post(`/api/runs/${halted}/pause`)).ok()).toBe(true);
	// Simulates a profile deleted before the guard in deleteProfile existed: the run stays paused, forever waiting.
	db.prepare('UPDATE runs SET agent_profile_id = NULL WHERE id = ?').run(halted);

	await command(page, 'fortsetzen all');

	await expectToast(
		page,
		`0 Runs setzen fort. Run ${halted} übersprungen: Das Agent-Profil von Run ${halted} gibt es nicht mehr. Ausweg: Starte in der Run-Akte einen neuen Run mit einem anderen Profil (:run).`
	);
});

test(':fortsetzen alone names the way out and offers the halted runs; an unknown number gets a message with a way out, a halted one resumes', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Resume me by number');
	fakeModel.reply('hang', 'hang');
	await open(page, '/');
	await queueRun(db, page, ticket.id, fakeModel);
	await expect(agentsOf(page)).toContainText('arbeitet');
	const halted = runningRunOf(db, ticket.id);
	expect((await page.request.post(`/api/runs/${halted}/pause`)).ok()).toBe(true);
	await expect(agentsOf(page)).not.toContainText('arbeitet');

	await command(page, 'fortsetzen');

	// closing the toast would move the focus out of the command line, and its suggestions with it
	await expect(
		page.locator('.toast', {
			hasText: 'Welchen Run? :fortsetzen N setzt einen angehaltenen fort, :fortsetzen all alle.'
		})
	).toBeVisible();
	const offered = page.getByRole('listbox').getByRole('option', { name: `:fortsetzen ${halted}` });
	await expect(offered).toContainText(`Run ${halted} · ${ticket.ref} fortsetzen`);

	await page.keyboard.press('Escape'); // clears the line, which stays focused
	await page.keyboard.type(':fortsetzen 99999');
	await page.keyboard.press('Enter');
	await expectToast(
		page,
		'Run 99999 gibt es nicht. Ausweg: :fortsetzen zeigt die angehaltenen Runs; :fortsetzen all setzt alle fort.'
	);

	await command(page, `fortsetzen ${halted}`);
	await expectToast(page, '1 Run setzt fort.');
	await expect(agentsOf(page)).toContainText('arbeitet');
});
