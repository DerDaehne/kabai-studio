import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import * as board from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { expect, isLiveConnection, open, test } from './fixtures.ts';

const HUMAN: Actor = { kind: 'user' };

function reachableColumn(db: DatabaseSync, ticketId: number, name: string): number {
	const move = board.allowedMoves(db, ticketId, HUMAN).find((target) => target.name === name);
	if (!move) throw new Error(`The seeded ticket cannot move to "${name}".`);
	return move.columnId;
}

/** Moves a ticket through the board's real form action, so the running server emits the live event itself. */
async function moveTicketLive(page: Page, db: DatabaseSync, ticketId: number, column: string) {
	const response = await page.request.post('/board?/move', {
		form: { ticketId: String(ticketId), columnId: String(reachableColumn(db, ticketId, column)) },
		headers: { origin: new URL(page.url()).origin }
	});
	expect(response.ok()).toBe(true);
}

const pathOf = (url: string) => new URL(url).pathname;

/**
 * Holds the /takt data load open, presses `g` `t`, fires a live event from another ticket while that navigation is
 * in flight, then releases the held load — the race the bug report describes, from whatever page is open. Also
 * waits for the deferred reload that lands once the navigation settles.
 */
async function navigateToTaktDuringLiveEvent(page: Page, db: DatabaseSync, ticketId: number) {
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/takt/__data.json*', async (route) => {
		await held;
		await route.continue();
	});
	const requested = page.waitForRequest((request) => pathOf(request.url()) === '/takt/__data.json');
	await page.keyboard.press('g');
	await page.keyboard.press('t');
	await requested;
	await moveTicketLive(page, db, ticketId, 'Refine');
	await page.waitForTimeout(300); // time for the event to reach the page before the held load resolves

	const replayed = page.waitForRequest((request) => pathOf(request.url()) === '/takt/__data.json');
	release();
	await expect(page).toHaveURL('/takt', { timeout: 5000 });
	await replayed;
}

test('a live event from another ticket does not abort a keyboard navigation in flight, its deferred reload lands once the navigation finishes, and a later navigation replays nothing stale', async ({
	page,
	seedTicket,
	db
}) => {
	const ticket = seedTicket('Elsewhere while navigating');
	await open(page, '/');
	await navigateToTaktDuringLiveEvent(page, db, ticket.id);

	// A second, unrelated navigation must not replay the already-delivered reload a second time: exactly one
	// /board/__data.json request, the navigation's own, not two.
	const boardRequests: string[] = [];
	page.on('request', (request) => {
		if (pathOf(request.url()) === '/board/__data.json') boardRequests.push(request.url());
	});
	await page.keyboard.press('g');
	await page.keyboard.press('b');
	await expect(page).toHaveURL('/board');
	await page.waitForTimeout(300); // time for a stale replay to show up, if the pending set was not cleared
	expect(boardRequests).toHaveLength(1);
});

test('a live event reloads the page data after a return from the back/forward cache', async ({
	page,
	seedTicket,
	db
}) => {
	const ticket = seedTicket('Elsewhere after bfcache restore');
	await page.addInitScript(() =>
		addEventListener('pageshow', (event) => {
			document.documentElement.dataset.restoredFromCache = String(event.persisted);
		})
	);
	await open(page, '/');
	await open(page, '/takt');
	const reconnected = page.waitForResponse((response) => isLiveConnection(response.url()));
	await page.goBack({ waitUntil: 'commit' });
	await expect(page.locator('html')).toHaveAttribute('data-restored-from-cache', 'true');
	await reconnected;

	const reloaded = page.waitForRequest((request) => pathOf(request.url()) === '/__data.json', {
		timeout: 5000
	});
	await moveTicketLive(page, db, ticket.id, 'Refine');
	await reloaded;
});

test('a live event reloads the page data after a bfcache return, when the navigation away fell back to a full page load', async ({
	page,
	seedTicket,
	db
}) => {
	const ticket = seedTicket('Elsewhere after a fallback load');
	await page.addInitScript(() =>
		addEventListener('pageshow', (event) => {
			document.documentElement.dataset.restoredFromCache = String(event.persisted);
		})
	);
	await open(page, '/');

	// The client navigation's data request fails (offline, server restarting), so SvelteKit loads the page natively.
	await page.route('**/takt/__data.json*', (route) => route.abort('internetdisconnected'));
	const taktConnected = page.waitForResponse((response) => isLiveConnection(response.url()));
	await page.keyboard.press('g');
	await page.keyboard.press('t');
	await expect(page).toHaveURL('/takt');
	await taktConnected;
	await page.unroute('**/takt/__data.json*');

	const reconnected = page.waitForResponse((response) => isLiveConnection(response.url()));
	await page.goBack({ waitUntil: 'commit' });
	await expect(page.locator('html')).toHaveAttribute('data-restored-from-cache', 'true');
	await reconnected;

	const reloaded = page.waitForRequest((request) => pathOf(request.url()) === '/__data.json', {
		timeout: 5000
	});
	await moveTicketLive(page, db, ticket.id, 'Refine');
	await reloaded;
});

test('a live event does not abort a navigation away from the board', async ({
	page,
	seedTicket,
	db
}) => {
	const ticket = seedTicket('Elsewhere while leaving the board');
	await open(page, '/board');
	await navigateToTaktDuringLiveEvent(page, db, ticket.id);
});

test('a live event on the open ticket does not abort a navigation away from its page', async ({
	page,
	seedTicket,
	db
}) => {
	const ticket = seedTicket('Elsewhere while leaving its own page');
	await open(page, ticket.path);
	await navigateToTaktDuringLiveEvent(page, db, ticket.id);
});

test('a live event still reloads the ticket after its own form submit aborted a navigation in flight', async ({
	page,
	seedTicket,
	db
}) => {
	const ticket = seedTicket('Elsewhere after an enhance abort');
	await open(page, ticket.path);

	let releaseAction = () => {};
	const actionHeld = new Promise<void>((resolve) => (releaseAction = resolve));
	await page.route(
		(url) => url.search.includes('/addTask'),
		async (route) => {
			await actionHeld;
			await route.continue();
		}
	);
	let releaseTakt = () => {};
	const taktHeld = new Promise<void>((resolve) => (releaseTakt = resolve));
	await page.route('**/takt/__data.json*', async (route) => {
		await taktHeld;
		await route.continue();
	});

	const posted = page.waitForRequest((request) => request.url().includes('/addTask'));
	await page.getByLabel('Neuer Task').fill('Elsewhere task');
	await page.getByRole('button', { name: 'Anlegen (o)' }).click();
	await posted;
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

	const taktRequested = page.waitForRequest(
		(request) => pathOf(request.url()) === '/takt/__data.json'
	);
	await page.keyboard.press('g');
	await page.keyboard.press('t');
	await taktRequested;

	// The form action's own invalidateAll() wins the token race and aborts the g-t navigation, same as on main.
	const invalidatedAll = page.waitForResponse(
		(response) => pathOf(response.url()) === `${ticket.path}/__data.json`
	);
	releaseAction();
	await invalidatedAll;
	releaseTakt();
	await page.waitForTimeout(500);
	await expect(page).toHaveURL(ticket.path);

	const reloaded = page.waitForRequest(
		(request) => pathOf(request.url()) === `${ticket.path}/__data.json`,
		{ timeout: 5000 }
	);
	await moveTicketLive(page, db, ticket.id, 'Refine');
	await reloaded;
});

test('a live event does not abort a newer navigation that superseded the one the gate started on', async ({
	page,
	seedTicket,
	db
}) => {
	const ticket = seedTicket('Elsewhere while a newer navigation supersedes the first');
	await open(page, '/');

	let releaseTakt = () => {};
	const taktHeld = new Promise<void>((resolve) => (releaseTakt = resolve));
	await page.route('**/takt/__data.json*', async (route) => {
		await taktHeld;
		await route.continue();
	});
	let releaseBoard = () => {};
	const boardHeld = new Promise<void>((resolve) => (releaseBoard = resolve));
	await page.route('**/board/__data.json*', async (route) => {
		await boardHeld;
		await route.continue();
	});

	const taktRequested = page.waitForRequest(
		(request) => pathOf(request.url()) === '/takt/__data.json'
	);
	await page.keyboard.press('g');
	await page.keyboard.press('t');
	await taktRequested;

	// SvelteKit runs no beforeNavigate for this second keypress: g b supersedes the still-pending g t navigation.
	const boardRequested = page.waitForRequest(
		(request) => pathOf(request.url()) === '/board/__data.json'
	);
	await page.keyboard.press('g');
	await page.keyboard.press('b');
	await boardRequested;

	releaseTakt();
	await page.waitForTimeout(300); // time for the superseded navigation's rejection to be handled
	await moveTicketLive(page, db, ticket.id, 'Refine');
	await page.waitForTimeout(300); // time for the event to reach the page before the held load resolves
	releaseBoard();
	await expect(page).toHaveURL('/board', { timeout: 5000 });
});
