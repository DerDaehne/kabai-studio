import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import * as board from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { createProfile, createRun, finishRun, startRun } from '../../src/lib/server/domain/runs.ts';
import { STEP_LABELS, VARIANTS, type Variant } from '../../src/lib/server/domain/variants.ts';
import { expect, open, sidewaysScrollers, test } from './fixtures.ts';
import { PROJECT } from './global-setup.ts';

const HUMAN: Actor = { kind: 'user' };

const LAGEN = ['Wartet auf dich', 'In Arbeit', 'Offen', 'Zur Abnahme', 'Fertig'];
const COLUMNS = ['Backlog', 'Präzisieren', 'Planen', 'Umsetzen', 'Kritik', 'Abnahme', 'Fertig'];
/** Column names that are no Lage as well; the default view must not show one. */
const ONLY_COLUMN_NAMES = ['Backlog', 'Präzisieren', 'Planen', 'Umsetzen', 'Kritik'];

const row = (page: Page, title: string) =>
	page.locator('[data-ticket]:not([inert])', { hasText: title });
const selected = (page: Page) => page.locator('[data-ticket][aria-current="true"]:not([inert])');
const group = (page: Page, name: string) =>
	page.getByRole('region', { name: new RegExp(`^${name} \\d+$`) });
const headings = (page: Page) => page.locator('[data-panorama] > section > h2');
const named = (names: string[]) => names.map((name) => new RegExp(`^${name} \\d+$`));
/** A row in the group `name`, leaving out the copy a row slides out of another group with. */
const rowIn = (page: Page, name: string, text: string) =>
	group(page, name).locator('[data-ticket]:not([inert])', { hasText: text });

async function press(page: Page, ...keys: string[]) {
	for (const key of keys) await page.keyboard.press(key);
}

/** The seeded project is the first, so the leader and its first letter focus it whatever else exists. */
async function focusSeededProject(page: Page) {
	await press(page, ' ', PROJECT.key[0].toLowerCase());
	await expect(page.getByRole('main')).toContainText(`Fokus ${PROJECT.key}`);
}

/** The expert view with the columns of the flow, through its key. */
async function showFlow(page: Page) {
	await press(page, ' ', 'g');
	await expect(headings(page)).toHaveText(named(COLUMNS));
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

/** A run of the ticket that works right now, or that failed; returns the name of its profile. */
function runOn(db: DatabaseSync, ticketId: number, outcome: 'running' | 'failed'): string {
	const name = `Board agent ${randomUUID().slice(0, 8)}`;
	const profile = createProfile(db, HUMAN, {
		name,
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'none'
	});
	const run = createRun(db, HUMAN, { ticketId, profileId: profile.id }).id;
	startRun(db, HUMAN, run);
	if (outcome === 'failed')
		finishRun(db, HUMAN, run, { state: 'failed', error: '[provider_unreachable] Timeout' });
	return name;
}

/** A second project with one ticket; projects cannot be deleted, so the clean-up archives it. */
function secondProject(db: DatabaseSync, variant: Variant = 'software') {
	// 10 hex characters (hyphens stripped first) keep collisions astronomically unlikely (16^10 possibilities).
	const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
	const project = board.createProject(
		db,
		HUMAN,
		{ key: `B${suffix}`, name: `Zweitprojekt ${suffix}` },
		variant
	);
	board.createTicket(db, HUMAN, project.id, { title: `Ticket im Zweitprojekt ${suffix}` });
	return {
		key: `B${suffix}`,
		name: `Zweitprojekt ${suffix}`,
		title: `Ticket im Zweitprojekt ${suffix}`,
		archive: () => db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(project.id)
	};
}

test('the board shows the five Lagen side by side, what waits for you first, and no column name', async ({
	page,
	seedTicket
}) => {
	seedTicket('Sketch the onboarding');
	await open(page, '/board');
	await focusSeededProject(page);

	await expect(headings(page)).toHaveText(named(LAGEN));
	for (const name of ONLY_COLUMN_NAMES)
		await expect(page.locator('.board')).not.toContainText(name);

	const [first, second] = await headings(page).evaluateAll((titles) =>
		titles.map((title) => title.getBoundingClientRect())
	);
	expect(second.x).toBeGreaterThan(first.x);
	expect(second.y).toBe(first.y);
	expect(await sidewaysScrollers(page)).toEqual([]);
});

test('each row shows its progress track in everyday words, an open one why it waits, a waiting one what it needs', async ({
	page,
	db,
	seedTicket
}) => {
	const failed = seedTicket('Lage: the run failed', 'Umsetzen');
	const working = seedTicket('Lage: an agent works', 'Umsetzen');
	const predecessor = seedTicket('Lage: the predecessor');
	const blocked = seedTicket('Lage: waits for its predecessor', 'Umsetzen');
	board.linkRelation(db, HUMAN, predecessor.id, blocked.id, 'blocks');
	seedTicket('Lage: ready for acceptance', 'Abnahme');
	seedTicket('Lage: finished', 'Fertig');
	runOn(db, failed.id, 'failed');
	runOn(db, working.id, 'running');
	await open(page, '/board');
	await focusSeededProject(page);

	const waiting = rowIn(page, 'Wartet auf dich', 'Lage: the run failed');
	await expect(waiting).toContainText('Umsetzung');
	await expect(waiting).toContainText('Run fehlgeschlagen');
	await expect(waiting.getByRole('img', { name: 'Schritt 3 von 5' })).toBeVisible();
	await expect(rowIn(page, 'In Arbeit', 'Lage: an agent works')).toContainText(
		'wird gerade umgesetzt'
	);
	await expect(rowIn(page, 'Offen', 'Lage: waits for its predecessor')).toContainText(
		`Wartet auf ${predecessor.ref}`
	);
	const backlog = rowIn(page, 'Offen', 'Lage: the predecessor');
	await expect(backlog).toContainText('noch nicht eingeplant');
	await expect(backlog).toContainText('Noch nicht priorisiert');
	await expect(backlog.getByRole('img', { name: 'Schritt 0 von 5' })).toBeVisible();
	const acceptance = rowIn(page, 'Zur Abnahme', 'Lage: ready for acceptance');
	await expect(acceptance).toContainText('bereit für deine Abnahme');
	await expect(acceptance.getByRole('img', { name: 'Schritt 5 von 5' })).toBeVisible();
	await expect(rowIn(page, 'Fertig', 'Lage: finished')).toContainText('abgeschlossen');
});

test('h, l and the arrows move between the Lagen, the focused row shows its ring, and the keys of the view head the overview', async ({
	page,
	seedTicket
}) => {
	seedTicket('Walk: first open one');
	seedTicket('Walk: second open one');
	seedTicket('Walk: waits for acceptance', 'Abnahme');
	await open(page, '/board');
	await focusSeededProject(page);

	await press(page, '?');
	const keyBar = page.getByRole('list', { name: 'Gültige Tasten' });
	for (const label of ['nächstes/voriges', 'links/rechts', 'Ablauf zeigen/verbergen', 'öffnen'])
		await expect(keyBar).toContainText(label);
	await expect(keyBar).not.toContainText('Spalte weiter/zurück');
	await page.keyboard.press('Escape');

	await select(page, 'Walk: second open one');
	const selectedIn = (name: string) => group(page, name).locator('[aria-current="true"]');
	await press(page, 'l');
	await expect(selectedIn('Zur Abnahme')).toHaveCount(1);
	await expect(selected(page)).toBeFocused();
	expect(await selected(page).evaluate((li) => getComputedStyle(li).outlineStyle)).toBe('solid');
	await press(page, 'h');
	await expect(selectedIn('Offen')).toHaveCount(1);
	await press(page, 'ArrowRight');
	await expect(selectedIn('Zur Abnahme')).toHaveCount(1);
	await press(page, 'ArrowLeft');
	await expect(selectedIn('Offen')).toHaveCount(1);
});

test('␣g and :ablauf switch to the flow with its columns, run state and profile, and the browser keeps the choice', async ({
	page,
	db,
	seedTicket
}) => {
	const working = seedTicket('Flow: an agent works', 'Umsetzen');
	const profile = runOn(db, working.id, 'running');
	await open(page, '/board');
	await focusSeededProject(page);
	await expect(page.getByRole('button', { name: 'Ablauf zeigen' })).toHaveAttribute(
		'aria-pressed',
		'false'
	);

	await showFlow(page);
	await expect(rowIn(page, 'Umsetzen', 'Flow: an agent works')).toContainText(
		`arbeitet · ${profile}`
	);
	await expect(rowIn(page, 'Umsetzen', 'Flow: an agent works')).toContainText('In Arbeit');
	await expect(page.getByRole('button', { name: 'Ablauf zeigen' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);

	await open(page, '/board');
	await expect(headings(page)).toHaveText(named(COLUMNS));

	await press(page, ':');
	await page.keyboard.type('ablauf');
	await press(page, 'Enter');
	await expect(headings(page)).toHaveText(named(LAGEN));
	await open(page, '/board');
	await expect(headings(page)).toHaveText(named(LAGEN));
});

test('in the flow the keys move along the columns and the overview offers > and <', async ({
	page,
	seedTicket
}) => {
	const first = seedTicket('Sketch the onboarding');
	const second = seedTicket('Write the release notes');
	const refined = seedTicket('Split the importer', 'Präzisieren');
	await open(page, '/board');
	await focusSeededProject(page);
	await showFlow(page);

	await press(page, '?');
	await expect(page.getByRole('list', { name: 'Gültige Tasten' })).toContainText(
		'Spalte weiter/zurück'
	);
	await page.keyboard.press('Escape');

	await expect(group(page, 'Backlog').locator('[data-ticket]')).toHaveText([
		new RegExp(`${PROJECT.key}\\s*${first.ref}\\s*Sketch the onboarding`),
		new RegExp(`${second.ref}\\s*Write the release notes`)
	]);
	await expect(group(page, 'Präzisieren')).toContainText(`${refined.ref} Split the importer`);

	await press(page, 'g', 'g');
	await expect(selected(page)).toContainText(first.ref);
	await press(page, 'j');
	await expect(selected(page)).toContainText(second.ref);
	await expect(selected(page)).toBeFocused();
	await press(page, 'G');
	await expect(selected(page)).toContainText(refined.ref);
	await press(page, '{');
	await expect(selected(page)).toContainText(first.ref);
	await press(page, '}');
	await expect(selected(page)).toContainText(refined.ref);

	await press(page, 'k', 'Enter');
	await expect(page).toHaveURL(second.path);
});

test('> moves the selected ticket one column on and the row slides there; u moves it back', async ({
	page,
	seedTicket
}) => {
	const ticket = seedTicket('Review the copy');
	await open(page, '/board');
	await focusSeededProject(page);
	await showFlow(page);
	await select(page, ticket.ref);

	const slides = page.waitForFunction(slidingCopies, ticket.id);
	await press(page, '>');
	await slides;
	await expect(group(page, 'Präzisieren')).toContainText(ticket.ref);
	await expect(page.getByText(`${ticket.ref} nach Präzisieren`, { exact: true })).toBeVisible();
	await expect(selected(page)).toBeFocused();

	await press(page, 'u');
	await expect(rowIn(page, 'Backlog', ticket.ref)).toBeVisible();
	await expect(rowIn(page, 'Präzisieren', ticket.ref)).toBeHidden();
	await expect(page.getByText(`Rückgängig: ${ticket.ref} nach Präzisieren`)).toBeVisible();
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
		await showFlow(page);
		await select(page, ticket.ref);
		await expect(selected(page)).toBeFocused();

		// This tab moves nothing itself: only the reload its live event triggers can bring the focus back.
		await focusSeededProject(other);
		await showFlow(other);
		await select(other, ticket.ref);
		await press(other, '>');

		await expect(group(page, 'Präzisieren')).toContainText(ticket.ref);
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
	await showFlow(page);
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
	await expect(rowIn(page, 'Präzisieren', ticket.ref)).toBeVisible();
	await page.waitForTimeout(300); // time for a second reload, the live echo of the move, to land as well
	await expect(commandLine).toBeFocused();
});

test('moving into done with an open task shows the refusal with the way out at the row, and the ticket stays', async ({
	page,
	db
}) => {
	const title = `Waiting for acceptance ${randomUUID()}`;
	const ticket = ticketInColumn(db, title, 'Abnahme');
	board.addTask(db, HUMAN, ticket.id, 'Check the numbers');
	try {
		await open(page, '/board');
		await focusSeededProject(page);
		await showFlow(page);
		await select(page, title);
		await press(page, '>');
		const refusal = rowIn(page, 'Abnahme', title).getByRole('alert');
		await expect(refusal).toContainText(`${ticket.ref} hat 1 offene Tasks`);
		await expect(refusal).toContainText('Hake die offenen Tasks ab oder lösche sie');
		await expect(refusal).not.toContainText('completeTask');
		await expect(group(page, 'Fertig')).not.toContainText(ticket.ref);
		// refused, so there is nothing to take back
		await press(page, '?');
		await expect(page.getByRole('list', { name: 'Gültige Tasten' })).not.toContainText(
			'rückgängig'
		);
		await page.keyboard.press('Escape');
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
	await showFlow(page);
	await select(page, ticket.ref);

	await press(page, '>');
	await expect(group(page, 'Präzisieren')).toContainText(`${ticket.ref} Fix the typo`);
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
	const anchor = seedTicket('Plan the sprint', 'Präzisieren');
	const otherContext = await browser.newContext();
	const other = await otherContext.newPage();
	try {
		await open(page, '/board');
		await open(other, '/board');
		await focusSeededProject(page);
		await showFlow(page);
		await focusSeededProject(other);
		await showFlow(other);
		await select(page, anchor.ref);

		await press(page, 'o');
		const field = page.getByLabel(`Titel des neuen Tickets in ${PROJECT.name}`);
		await expect(field).toBeFocused();
		await field.fill(title);
		await press(page, 'Enter');
		await expect(page.getByText(new RegExp(`${PROJECT.key}-\\d+ angelegt`))).toBeVisible();
		await expect(rowIn(page, 'Präzisieren', title)).toBeVisible();
		await expect(selected(page)).toContainText(title);
		await expect(rowIn(other, 'Präzisieren', title)).toBeVisible();

		await press(page, '>');
		await expect(rowIn(other, 'Planen', title)).toBeVisible();
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
		await expect(page.getByRole('main')).toContainText(`Fokus ${PROJECT.key}`);
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

	test('stacks the Lagen and the flow, only vertically, and the project chips set the focus', async ({
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
			const [first, next] = await headings(page).evaluateAll((titles) =>
				titles.map((title) => title.getBoundingClientRect())
			);
			expect(next.y).toBeGreaterThan(first.y);
			expect(next.x).toBe(first.x);

			const reason = row(page, ticket.ref).locator('.reason');
			await reason.evaluate((el) => (el.textContent = 'a very long waiting reason '.repeat(8)));
			expect(await sidewaysScrollers(page)).toEqual([]);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				375
			);

			await page.getByRole('button', { name: `${second.key} ${second.name}` }).tap();
			await expect(row(page, ticket.ref)).toBeHidden();
			await expect(row(page, second.title)).toBeVisible();

			await page.getByRole('button', { name: 'Ablauf zeigen' }).tap();
			await expect(headings(page)).toHaveText(named(COLUMNS));
			expect(await sidewaysScrollers(page)).toEqual([]);
		} finally {
			deleteByTitle(db, second.title);
			second.archive();
		}
	});
});

const stepNames = (variant: Variant) => VARIANTS[variant].map((step) => STEP_LABELS[step]);

/** The variant name above each column and the column's name, in the order shown. */
const columns = (page: Page) =>
	page.locator('[data-panorama] > section').evaluateAll((sections) =>
		sections.map((section) => ({
			variant: section.querySelector('.variant-name')?.textContent?.trim() ?? '',
			step: section.querySelector('h2')?.firstChild?.textContent?.trim() ?? ''
		}))
	);

const stepsOf = (shown: { variant: string; step: string }[], variant: string) =>
	shown.filter((column) => column.variant === variant).map((column) => column.step);

test('the flow shows one named block per variant without a focus and only the focused variant with one', async ({
	page,
	db,
	seedTicket
}) => {
	seedTicket('Flow: software ticket');
	const knowledge = secondProject(db, 'knowledge');
	try {
		await open(page, '/board');
		await press(page, ' ', 'g');
		await expect
			.poll(async () => stepsOf(await columns(page), 'Wissen'))
			.toEqual(stepNames('knowledge'));
		const shown = await columns(page);
		expect(stepsOf(shown, 'Software')).toEqual(stepNames('software'));
		const blocks = shown.map((column) => column.variant);
		const blockOrder = blocks.filter((name, at) => name !== blocks[at - 1]);
		expect(new Set(blockOrder).size).toBe(blockOrder.length);

		await page.getByRole('button', { name: `${knowledge.key} ${knowledge.name}` }).click();
		await expect(headings(page)).toHaveText(named(stepNames('knowledge')));
		await expect(page.locator('.variant-name')).toHaveCount(0);

		await page.getByRole('button', { name: `${PROJECT.key} ${PROJECT.name}` }).click();
		await expect(headings(page)).toHaveText(named(stepNames('software')));
	} finally {
		deleteByTitle(db, knowledge.title);
		knowledge.archive();
	}
});

test('> and < move a ticket only along the steps of its own variant', async ({ page, db }) => {
	const knowledge = secondProject(db, 'knowledge');
	try {
		await open(page, '/board');
		await press(page, ' ', 'g');
		await page.getByRole('button', { name: `${knowledge.key} ${knowledge.name}` }).click();
		await select(page, knowledge.title);
		await press(page, '>');
		await expect(rowIn(page, 'Recherchieren', knowledge.title)).toBeVisible();
		await press(page, '<');
		await expect(rowIn(page, 'Backlog', knowledge.title)).toBeVisible();
		await press(page, '<');
		await expect(rowIn(page, 'Backlog', knowledge.title)).toBeVisible();
	} finally {
		deleteByTitle(db, knowledge.title);
		knowledge.archive();
	}
});
