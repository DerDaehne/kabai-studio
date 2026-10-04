import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import * as board from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { expect, open, test } from './fixtures.ts';

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

const isTaktData = (url: string) => new URL(url).pathname === '/takt/__data.json';

test('a live event from another ticket does not abort a keyboard navigation in flight, and its deferred reload lands once the navigation finishes', async ({
	page,
	seedTicket,
	db
}) => {
	const ticket = seedTicket('Elsewhere while navigating');
	await open(page, '/');

	// Holds the destination's data load open, so the navigation to /takt is still in flight when the live event
	// below arrives — the race the bug report describes.
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/takt/__data.json*', async (route) => {
		await held;
		await route.continue();
	});

	const requested = page.waitForRequest((request) => isTaktData(request.url()));
	await page.keyboard.press('g');
	await page.keyboard.press('t');
	await requested;

	// An event from a ticket unrelated to the page being navigated away from.
	await moveTicketLive(page, db, ticket.id, 'Refine');

	const replayed = page.waitForRequest((request) => isTaktData(request.url()));
	release();

	await expect(page).toHaveURL('/takt');
	await replayed;
});
