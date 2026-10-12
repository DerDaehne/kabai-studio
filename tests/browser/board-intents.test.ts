import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import * as board from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { createProfile } from '../../src/lib/server/domain/runs.ts';
import { expect, open, test } from './fixtures.ts';
import { PROJECT } from './global-setup.ts';

const HUMAN: Actor = { kind: 'user' };

const group = (page: Page, name: string) =>
	page.getByRole('region', { name: new RegExp(`^${name} \\d+$`) });
const rowIn = (page: Page, name: string, text: string) =>
	group(page, name).locator('[data-ticket]:not([inert])', { hasText: text });
const selected = (page: Page) => page.locator('[data-ticket][aria-current="true"]:not([inert])');

async function press(page: Page, ...keys: string[]) {
	for (const key of keys) await page.keyboard.press(key);
}

async function openBoardAt(page: Page, title: string) {
	await open(page, '/board');
	await press(page, ' ', PROJECT.key[0].toLowerCase());
	await expect(page.getByRole('main')).toContainText(`Fokus ${PROJECT.key}`);
	await press(page, 'g', 'g');
	for (let step = 0; step < 50; step++) {
		if ((await selected(page).textContent())?.includes(title)) return;
		await press(page, 'j');
	}
	throw new Error(`No row "${title}" to select.`);
}

function ticketIn(db: DatabaseSync, title: string, column: string) {
	const projectId = Number(process.env.STUDIO_BROWSER_PROJECT_ID);
	const columnId = db
		.prepare('SELECT id FROM columns WHERE project_id = ? AND name = ?')
		.get(projectId, column)!.id as number;
	const ticket = board.createTicket(db, HUMAN, projectId, { title, column_id: columnId });
	return { ...ticket, ref: `${PROJECT.key}-${ticket.number}` };
}

const runsOf = (db: DatabaseSync, ticketId: number) =>
	(db.prepare('SELECT count(*) AS n FROM runs WHERE ticket_id = ?').get(ticketId)!.n as number) ??
	0;

function cleanUp(db: DatabaseSync, title: string) {
	for (const { id } of db.prepare('SELECT id FROM tickets WHERE title = ?').all(title))
		board.deleteTicket(db, HUMAN, id as number);
}

function anyProfile(db: DatabaseSync) {
	createProfile(db, HUMAN, {
		name: `Intent agent ${randomUUID().slice(0, 8)}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'none'
	});
}

test('s starts the selected ticket, the row leaves Offen and a run is queued; the button does the same', async ({
	page,
	db
}) => {
	anyProfile(db);
	const byKey = `Start by key ${randomUUID()}`;
	const byButton = `Start by button ${randomUUID()}`;
	const first = ticketIn(db, byKey, 'Backlog');
	const second = ticketIn(db, byButton, 'Backlog');
	try {
		await openBoardAt(page, byKey);
		await press(page, 's');
		await expect(page.getByText(`${first.ref} gestartet`)).toBeVisible();
		await expect(rowIn(page, 'Offen', byKey)).toHaveCount(0);
		expect(runsOf(db, first.id)).toBe(1);

		await rowIn(page, 'Offen', byButton).getByRole('button', { name: /^Los/ }).click();
		await expect(page.getByText(`${second.ref} gestartet`)).toBeVisible();
		await expect(rowIn(page, 'Offen', byButton)).toHaveCount(0);
		expect(runsOf(db, second.id)).toBe(1);
	} finally {
		cleanUp(db, byKey);
		cleanUp(db, byButton);
	}
});

test('a accepts a ticket in the acceptance and it moves to Fertig; the row keeps a visible focus', async ({
	page,
	db
}) => {
	const title = `Accept by key ${randomUUID()}`;
	const ticket = ticketIn(db, title, 'Abnahme');
	try {
		await openBoardAt(page, title);
		await press(page, 'a');
		await expect(page.getByText(`${ticket.ref} abgenommen`)).toBeVisible();
		await expect(rowIn(page, 'Fertig', title)).toHaveCount(1);
		await expect(selected(page)).toBeFocused();
		expect(await selected(page).evaluate((li) => getComputedStyle(li).outlineStyle)).toBe('solid');
	} finally {
		cleanUp(db, title);
	}
});

test('the Abnehmen button accepts with the pointer', async ({ page, db }) => {
	const title = `Accept by button ${randomUUID()}`;
	ticketIn(db, title, 'Abnahme');
	try {
		await open(page, '/board');
		await rowIn(page, 'Zur Abnahme', title)
			.getByRole('button', { name: /^Abnehmen/ })
			.click();
		await expect(rowIn(page, 'Fertig', title)).toHaveCount(1);
	} finally {
		cleanUp(db, title);
	}
});

test('accepting with an open task shows the refusal and its way out at the row', async ({
	page,
	db
}) => {
	const title = `Accept with task ${randomUUID()}`;
	const ticket = ticketIn(db, title, 'Abnahme');
	board.addTask(db, HUMAN, ticket.id, 'Check the numbers');
	try {
		await openBoardAt(page, title);
		await press(page, 'a');
		const refusal = rowIn(page, 'Zur Abnahme', title).getByRole('alert');
		await expect(refusal).toContainText(`${ticket.ref} hat 1 offene Tasks`);
		await expect(refusal).toContainText('Erledige die Tasks');
		await expect(rowIn(page, 'Fertig', title)).toHaveCount(0);
	} finally {
		cleanUp(db, title);
	}
});

test('r asks for a comment, refuses an empty one with the way out, and returns the ticket with it', async ({
	page,
	db
}) => {
	anyProfile(db);
	const title = `Give back ${randomUUID()}`;
	const ticket = ticketIn(db, title, 'Abnahme');
	try {
		await openBoardAt(page, title);
		await press(page, 'r');
		const comment = page.getByLabel(`Kommentar zum Zurückgeben von ${ticket.ref}`);
		await expect(comment).toBeFocused();

		await press(page, 'Enter');
		const refusal = rowIn(page, 'Zur Abnahme', title).getByRole('alert');
		await expect(refusal).toContainText('Zurückgeben geht nur mit Kommentar');
		await expect(refusal).toContainText('Schreib, was fehlt');
		await expect(comment).toBeVisible();

		await comment.fill('The totals are wrong');
		await press(page, 'Enter');
		await expect(page.getByText(`${ticket.ref} zurückgegeben`)).toBeVisible();
		await expect(rowIn(page, 'Zur Abnahme', title)).toHaveCount(0);
		expect(runsOf(db, ticket.id)).toBe(1);
		const texts = db.prepare('SELECT body FROM comments WHERE ticket_id = ?').all(ticket.id);
		expect(texts.map((row) => row.body)).toContain('The totals are wrong');
		await expect(selected(page)).toBeFocused();
	} finally {
		cleanUp(db, title);
	}
});

test('Escape leaves the return comment without returning, and the Zurückgeben button opens it', async ({
	page,
	db
}) => {
	const title = `Give back cancelled ${randomUUID()}`;
	const ticket = ticketIn(db, title, 'Abnahme');
	try {
		await open(page, '/board');
		await rowIn(page, 'Zur Abnahme', title)
			.getByRole('button', { name: /^Zurückgeben/ })
			.click();
		await expect(page.getByLabel(`Kommentar zum Zurückgeben von ${ticket.ref}`)).toBeFocused();
		await press(page, 'Escape');
		await expect(rowIn(page, 'Zur Abnahme', title)).toHaveCount(1);
		await expect(page.getByLabel(`Kommentar zum Zurückgeben von ${ticket.ref}`)).toHaveCount(0);
		await expect(selected(page)).toBeFocused();
	} finally {
		cleanUp(db, title);
	}
});

test('Enter opens the Run-Akte of the selected ticket', async ({ page, db }) => {
	const title = `Open file ${randomUUID()}`;
	const ticket = ticketIn(db, title, 'Backlog');
	try {
		await openBoardAt(page, title);
		await press(page, 'Enter');
		await expect(page).toHaveURL(new RegExp(`/p/${PROJECT.key}/t/${ticket.number}$`, 'i'));
	} finally {
		cleanUp(db, title);
	}
});

test('the overview lists the intent keys of the board', async ({ page, db }) => {
	const title = `Keys ${randomUUID()}`;
	ticketIn(db, title, 'Backlog');
	try {
		await openBoardAt(page, title);
		await press(page, '?');
		const keyBar = page.getByRole('list', { name: 'Gültige Tasten' });
		for (const label of ['los', 'abnehmen', 'zurückgeben'])
			await expect(keyBar).toContainText(label);
		await page.keyboard.press('Escape');
	} finally {
		cleanUp(db, title);
	}
});
