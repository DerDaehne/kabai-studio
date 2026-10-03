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
const confirmationOf = (page: Page) => page.getByRole('dialog', { name: /^Run \d+ stoppen\?$/ });

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
	profile(`Anderes ${suffix}`);
	const lastUsed = { name: `Zuletzt ${suffix}`, id: profile(`Zuletzt ${suffix}`) };
	const earlier = createRun(db, HUMAN, { ticketId: ticket.id, profileId: lastUsed.id }).id;
	finishRun(db, HUMAN, earlier, { state: 'cancelled' });
	return { pool, lastUsed };
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
		await expect(stopped).toContainText('gestoppt');
	}
}

async function expectFinished(view: Page, profile: string) {
	const newest = tabsOf(view).first();
	await expect(newest).toContainText(/Run \d+\s*fertig/);
	await expect(newest).toContainText(`${profile} · `);
	await expect(newest).toContainText(/Tokens 100 ein · 10 aus · 0,00\s\$/);
}

test('a run starts from the Run-Akte with the preselected profile, waits for its pool, stops only after x y, and its tab shows the result live', async ({
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
	await expect(tabsOf(phone).nth(1)).toContainText('gestoppt');

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
	await expect(page.getByRole('list', { name: 'Gültige Tasten' })).not.toContainText('Run stoppen');

	const firstStopped = tabsOf(page).nth(2).getByRole('link').first();
	await firstStopped.click();
	await expect(firstStopped).toHaveAttribute('aria-current', 'page');
	await expect(page).toHaveURL(/\?run=\d+$/);
	await phoneContext.close();
});
