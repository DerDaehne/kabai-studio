import { test as base, expect, type Page, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/lib/server/db.ts';
import * as board from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { createProfile, createRun } from '../../src/lib/server/domain/runs.ts';
import { startFakeModel, type FakeModel } from './fake-model.ts';
import { PROJECT, studioDatabase } from './global-setup.ts';

export { expect };

const HUMAN: Actor = { kind: 'user' };

export type SeededTicket = { id: number; ref: string; path: string };
/** Creates a ticket in the seeded project, in its first column or in a column one move away. */
type SeedTicket = (title: string, column?: string) => SeededTicket;

/**
 * `db` writes into the server's database through the domain layer, so seeded data follows the same rules as data
 * entered in the UI. Its events stay in the test process: seed before opening the page that shows the data.
 */
export const test = base.extend<
	{ seedTicket: SeedTicket; fakeModel: FakeModel },
	{ db: DatabaseSync }
>({
	db: [
		async ({}, use) => {
			const db = openDb(studioDatabase());
			await use(db);
			db.close();
		},
		{ scope: 'worker' }
	],
	// Deleting a seeded ticket afterwards takes its tasks, runs and questions along, so tests stay independent.
	seedTicket: async ({ db }, use) => {
		const seeded: number[] = [];
		await use((title, column) => {
			const ticket = ticketInSeededProject(db, title, column);
			seeded.push(ticket.id);
			return ticket;
		});
		for (const id of seeded) board.deleteTicket(db, HUMAN, id);
	},
	fakeModel: async ({}, use) => {
		const model = await startFakeModel();
		await use(model);
		await model.close();
	}
});

export const isLiveConnection = (url: string) => new URL(url).pathname === '/api/events';

/** Opens a page once it has hydrated: the layout then has its live connection open and the server listens on it. */
export async function open(page: Page, path: string): Promise<void> {
	const connected = (response: Response) => isLiveConnection(response.url());
	await Promise.all([page.waitForResponse(connected), page.goto(path)]);
}

function ticketInSeededProject(db: DatabaseSync, title: string, column?: string): SeededTicket {
	const projectId = Number(process.env.STUDIO_BROWSER_PROJECT_ID);
	const { id, number } = board.createTicket(db, HUMAN, projectId, { title });
	if (column) board.moveTicket(db, HUMAN, id, reachableColumn(db, id, column));
	return { id, ref: `${PROJECT.key}-${number}`, path: `/p/${PROJECT.key}/t/${number}` };
}

function reachableColumn(db: DatabaseSync, ticketId: number, name: string): number {
	const move = board.allowedMoves(db, ticketId, HUMAN).find((target) => target.name === name);
	if (!move) throw new Error(`The seeded ticket cannot move to "${name}".`);
	return move.columnId;
}

/**
 * Queues a run of the ticket for a builtin agent on the fake model. The server's runner wakes only on events inside
 * its own process, so releasing the kill switch (a no-op while it is not set) wakes it to claim the run.
 */
export async function queueRun(db: DatabaseSync, page: Page, ticketId: number, model: FakeModel) {
	const profile = createProfile(db, HUMAN, {
		name: `Fake model ${randomUUID()}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: model.baseUrl,
		model: 'fake'
	});
	createRun(db, HUMAN, { ticketId, profileId: profile.id });
	expect((await page.request.delete('/api/halt')).ok()).toBe(true);
}

/** What a user could scroll sideways: the page itself, or a scroll container whose content is wider than its box. */
export function sidewaysScrollers(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const root = document.documentElement;
		// Title rows (the head pivot) are sideways strips by design; they scroll inside themselves, never the page.
		const scrolls = (element: Element) =>
			element === root ||
			(!element.hasAttribute('data-title-row') &&
				/auto|scroll/.test(getComputedStyle(element).overflowX));
		return [root, ...document.body.querySelectorAll('*')]
			.filter((element) => element.scrollWidth > element.clientWidth && scrolls(element))
			.map((element) => [element.tagName.toLowerCase(), ...element.classList].join('.'));
	});
}
