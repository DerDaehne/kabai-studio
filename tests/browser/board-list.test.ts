import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import * as board from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { expect, open, sidewaysScrollers, test } from './fixtures.ts';
import { PROJECT } from './global-setup.ts';

const HUMAN: Actor = { kind: 'user' };

const row = (page: Page, title: string) =>
	page.locator('[data-ticket]:not([inert])', { hasText: title });
const selected = (page: Page) => page.locator('[data-ticket][aria-current="true"]:not([inert])');
const group = (page: Page, column: string) =>
	page.getByRole('region', { name: new RegExp(`^${column} \\d+$`) });
/** A row in the group of `column`, leaving out the copy a row slides out of another column with. */
const rowIn = (page: Page, column: string, text: string) =>
	group(page, column).locator('[data-ticket]:not([inert])', { hasText: text });

async function press(page: Page, ...keys: string[]) {
	for (const key of keys) await page.keyboard.press(key);
}

/** The seeded project is the first, so the leader and its first letter focus it whatever else exists. */
async function focusSeededProject(page: Page) {
	await press(page, ' ', PROJECT.key[0].toLowerCase());
	await expect(page.getByRole('banner')).toContainText(`Fokus ${PROJECT.key}`);
}

/** Walks the selection down from the top with j until the row with `title` is selected. */
async function select(page: Page, title: string) {
	await press(page, 'g', 'g');
	for (let step = 0; step < 50; step++) {
		if ((await selected(page).textContent())?.includes(title)) return;
		await press(page, 'j');
	}
	throw new Error(`No row "${title}" to select.`);
}

/** Runs in the page: how many copies of a row move by transform right now, a slide rather than a focus ring fading. */
function slidingCopies(id: number): number {
	const rows = [...document.querySelectorAll(`[data-ticket="${id}"]`)];
	return rows.filter((row) =>
		row
			.getAnimations()
			.some((animation) =>
				(animation.effect as KeyframeEffect).getKeyframes().some((frame) => 'transform' in frame)
			)
	).length;
}

/** A ticket the test itself may delete, so the seedTicket clean-up must not delete it a second time. */
function ticketInColumn(db: DatabaseSync, title: string, column = 'Backlog') {
	const projectId = Number(process.env.STUDIO_BROWSER_PROJECT_ID);
	const columnId = db
		.prepare('SELECT id FROM columns WHERE project_id = ? AND name = ?')
		.get(projectId, column)!.id as number;
	const ticket = board.createTicket(db, HUMAN, projectId, { title, column_id: columnId });
	return { ...ticket, ref: `${PROJECT.key}-${ticket.number}` };
}

function deleteByTitle(db: DatabaseSync, title: string) {
	const rows = db.prepare('SELECT id FROM tickets WHERE title = ?').all(title);
	for (const { id } of rows) board.deleteTicket(db, HUMAN, id as number);
}

/** A second project with one ticket; projects cannot be deleted, so the clean-up archives it. */
function secondProject(db: DatabaseSync) {
	const suffix = randomUUID().slice(0, 4).toUpperCase();
	const project = board.createProject(db, HUMAN, {
		key: `B${suffix}`,
		name: `Zweitprojekt ${suffix}`
	});
	board.createTicket(db, HUMAN, project.id, { title: `Ticket im Zweitprojekt ${suffix}` });
	return {
		key: `B${suffix}`,
		name: `Zweitprojekt ${suffix}`,
		title: `Ticket im Zweitprojekt ${suffix}`,
		archive: () => db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(project.id)
	};
}

test('gb opens the board, which groups tickets by column and binds its keys to the selected row', async ({
	page,
	seedTicket
}) => {
	const first = seedTicket('Sketch the onboarding');
	const second = seedTicket('Write the release notes');
	const refined = seedTicket('Split the importer', 'Refine');
	await open(page, '/');
	await press(page, 'g', 'b');
	await expect(page).toHaveURL('/board');
	await focusSeededProject(page);

	const keyBar = page.getByRole('list', { name: 'Gültige Tasten' });
	for (const label of [
		'nächstes/voriges',
		'Anfang/Ende',
		'Gruppe bzw. Datei',
		'öffnen',
		'Spalte weiter/zurück',
		'neu darunter/darüber',
		'Text bearbeiten',
		'löschen',
		'ID/Pfad kopieren',
		'Fokus auf dieses Projekt'
	])
		await expect(keyBar).toContainText(label);
	expect(await sidewaysScrollers(page)).toEqual([]);

	await expect(group(page, 'Backlog')).toContainText('Start per :run');
	await expect(group(page, 'Backlog').locator('[data-ticket]')).toHaveText([
		new RegExp(`${PROJECT.key}\\s*${first.ref}\\s*Sketch the onboarding`),
		new RegExp(`${second.ref}\\s*Write the release notes`)
	]);
	await expect(group(page, 'Refine')).toContainText(`${refined.ref} Split the importer`);

	await press(page, 'g', 'g');
	await expect(selected(page)).toContainText(first.ref);
	await press(page, 'j');
	await expect(selected(page)).toContainText(second.ref);
	await expect(selected(page)).toBeFocused();
	await press(page, 'k');
	await expect(selected(page)).toContainText(first.ref);
	await press(page, 'G');
	await expect(selected(page)).toContainText(refined.ref);
	await press(page, '{');
	await expect(selected(page)).toContainText(first.ref);
	await press(page, '}');
	await expect(selected(page)).toContainText(refined.ref);

	await press(page, 'k', 'Enter');
	await expect(page).toHaveURL(second.path);
});

test('> moves the selected ticket one allowed column on and the row slides there; u moves it back', async ({
	page,
	seedTicket
}) => {
	const ticket = seedTicket('Review the copy');
	await open(page, '/board');
	await focusSeededProject(page);
	await select(page, ticket.ref);

	const slides = page.waitForFunction(slidingCopies, ticket.id);
	await press(page, '>');
	await slides;
	await expect(group(page, 'Refine')).toContainText(ticket.ref);
	await expect(page.getByText(`${ticket.ref} nach Refine`, { exact: true })).toBeVisible();
	await expect(selected(page)).toBeFocused();

	await press(page, 'u');
	await expect(rowIn(page, 'Backlog', ticket.ref)).toBeVisible();
	await expect(rowIn(page, 'Refine', ticket.ref)).toBeHidden();
	await expect(page.getByText(`Rückgängig: ${ticket.ref} nach Refine`)).toBeVisible();
});

test('another tab moving my selected ticket keeps its row focused once it lands', async ({
	page,
	browser,
	seedTicket
}) => {
	const ticket = seedTicket('Review the copy');
	const otherContext = await browser.newContext();
	const other = await otherContext.newPage();
	try {
		await open(page, '/board');
		await open(other, '/board');
		await focusSeededProject(page);
		await select(page, ticket.ref);
		await expect(selected(page)).toBeFocused();

		// This tab moves nothing itself: only the reload its live event triggers can bring the focus back.
		await focusSeededProject(other);
		await select(other, ticket.ref);
		await press(other, '>');

		await expect(group(page, 'Refine')).toContainText(ticket.ref);
		await expect(selected(page)).toBeFocused();
	} finally {
		await otherContext.close();
	}
});

test('a reload that lands after the focus left the list does not pull the focus back to the row', async ({
	page,
	seedTicket
}) => {
	const ticket = seedTicket('Review the copy');
	await open(page, '/board');
	await focusSeededProject(page);
	await select(page, ticket.ref);

	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/board/__data.json*', async (route) => {
		await held;
		await route.continue();
	});
	const reloading = page.waitForRequest((request) => request.url().includes('/board/__data.json'));
	await press(page, '>');
	await reloading;
	await press(page, ':');
	const commandLine = page.getByRole('combobox', { name: 'Befehlszeile' });
	await expect(commandLine).toBeFocused();

	release();
	await expect(rowIn(page, 'Refine', ticket.ref)).toBeVisible();
	await page.waitForTimeout(300); // time for a second reload, the live echo of the move, to land as well
	await expect(commandLine).toBeFocused();
});

test('a closed column refuses > with the reason and the way out, and the ticket stays', async ({
	page,
	db
}) => {
	const title = `Waiting for acceptance ${randomUUID()}`;
	const ticket = ticketInColumn(db, title, 'Abnahme');
	board.addTask(db, HUMAN, ticket.id, 'Check the numbers');
	try {
		await open(page, '/board');
		await focusSeededProject(page);
		await select(page, title);
		await press(page, '>');
		await expect(page.getByText(`${ticket.ref} hat 1 offene Tasks`)).toContainText(
			'Erledige die Tasks'
		);
		await expect(group(page, 'Abnahme')).toContainText(ticket.ref);
		// refused before anything happened, so there is nothing to take back
		await expect(page.getByRole('list', { name: 'Gültige Tasten' })).not.toContainText(
			'rückgängig'
		);
	} finally {
		deleteByTitle(db, title);
	}
});

test('with reduced motion a moved row shows up in its new column at once, without sliding', async ({
	page,
	seedTicket
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const ticket = seedTicket('Fix the typo');
	await open(page, '/board');
	await focusSeededProject(page);
	await select(page, ticket.ref);

	await press(page, '>');
	await expect(group(page, 'Refine')).toContainText(`${ticket.ref} Fix the typo`);
	expect(await page.locator(`[data-ticket="${ticket.id}"]`).count()).toBe(1);
	expect(await page.evaluate(slidingCopies, ticket.id)).toBe(0);
});

test('o creates a ticket in the column of the selected row, and a second tab shows it and its moves live', async ({
	page,
	browser,
	db,
	seedTicket
}) => {
	const title = `Quick ticket ${randomUUID()}`;
	const anchor = seedTicket('Plan the sprint', 'Refine');
	const otherContext = await browser.newContext();
	const other = await otherContext.newPage();
	try {
		await open(page, '/board');
		await open(other, '/board');
		await focusSeededProject(page);
		await select(page, anchor.ref);

		await press(page, 'o');
		const field = page.getByLabel(`Titel des neuen Tickets in ${PROJECT.name}`);
		await expect(field).toBeFocused();
		await field.fill(title);
		await press(page, 'Enter');
		await expect(page.getByText(new RegExp(`${PROJECT.key}-\\d+ angelegt`))).toBeVisible();
		await expect(rowIn(page, 'Refine', title)).toBeVisible();
		await expect(selected(page)).toContainText(title);
		await expect(rowIn(other, 'Refine', title)).toBeVisible();

		await press(page, '>');
		await expect(rowIn(other, 'Ready', title)).toBeVisible();
	} finally {
		await otherContext.close();
		deleteByTitle(db, title);
	}
});

test('i renames the selected ticket, yy copies its ID, and dd deletes it with an undo window', async ({
	page,
	context,
	db
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.clock.install();
	const title = `Draft the FAQ ${randomUUID()}`;
	const renamed = `Draft the help page ${randomUUID()}`;
	const ticket = ticketInColumn(db, title);
	const stored = (id: number) =>
		db.prepare('SELECT count(*) AS n FROM tickets WHERE id = ?').get(id)!.n;
	try {
		await open(page, '/board');
		await focusSeededProject(page);
		await select(page, title);

		await press(page, 'i');
		const field = page.getByLabel(`Neuer Titel für ${ticket.ref}`);
		await expect(field).toBeFocused();
		await expect(field).toHaveValue(title);
		await field.fill(renamed);
		await press(page, 'Enter');
		await expect(row(page, renamed)).toBeVisible();
		await expect(selected(page)).toBeFocused();

		await press(page, 'y', 'y');
		await expect(page.getByText(`${ticket.ref} kopiert`)).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ticket.ref);

		await press(page, 'd', 'd');
		await expect(row(page, renamed)).toBeHidden();
		await expect(page.getByText(`${ticket.ref} gelöscht`, { exact: true })).toBeVisible();
		await press(page, 'u');
		await expect(row(page, renamed)).toBeVisible();
		await page.clock.fastForward(10_500);
		await page.waitForTimeout(300); // time for a delete that should not happen to reach the server
		expect(stored(ticket.id)).toBe(1);

		await press(page, 'd', 'd');
		await expect(row(page, renamed)).toBeHidden();
		await page.clock.fastForward(10_500);
		await expect.poll(() => stored(ticket.id)).toBe(0);
	} finally {
		deleteByTitle(db, renamed);
		deleteByTitle(db, title);
	}
});

test('the project focus collapses other projects into one line; * focuses the row, the chips switch', async ({
	page,
	db,
	seedTicket
}) => {
	const ticket = seedTicket('Tidy the backlog');
	const second = secondProject(db);
	try {
		await open(page, '/board');
		await expect(row(page, second.title)).toBeVisible();
		await select(page, ticket.ref);

		await press(page, '*');
		await expect(page.getByRole('banner')).toContainText(`Fokus ${PROJECT.key}`);
		await expect(row(page, second.title)).toBeHidden();
		await expect(page.getByText(/^\d+ weitere in \d+ anderen Projekt(en)?$/)).toBeVisible();

		await page.getByRole('button', { name: `${second.key} ${second.name}` }).click();
		await expect(row(page, second.title)).toBeVisible();
		await expect(row(page, ticket.ref)).toBeHidden();

		await page.getByRole('button', { name: 'Alle', exact: true }).click();
		await expect(row(page, ticket.ref)).toBeVisible();
		await expect(row(page, second.title)).toBeVisible();
	} finally {
		deleteByTitle(db, second.title);
		second.archive();
	}
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 375, height: 667 }, hasTouch: true });

	test('shows the same list without sideways scrolling, and the project chips set the focus', async ({
		page,
		db,
		seedTicket
	}) => {
		const ticket = seedTicket('A ticket whose rather long title has to wrap on a phone screen');
		const second = secondProject(db);
		try {
			await open(page, '/board');
			await expect(row(page, ticket.ref)).toBeVisible();
			await expect(row(page, second.title)).toBeVisible();
			expect(await sidewaysScrollers(page)).toEqual([]);

			await page.getByRole('button', { name: `${second.key} ${second.name}` }).tap();
			await expect(row(page, ticket.ref)).toBeHidden();
			await expect(row(page, second.title)).toBeVisible();
			expect(await sidewaysScrollers(page)).toEqual([]);
		} finally {
			deleteByTitle(db, second.title);
			second.archive();
		}
	});
});
