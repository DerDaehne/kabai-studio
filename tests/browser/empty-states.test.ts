// Every dead end on a fresh instance names the next DoD step in one sentence and one action, so a first-time
// owner never needs a manual (see CLAUDE.md "UX and AX"). This suite pins down the cases still worth a build
// (the 404 label) and regression-tests the ones already delivered by other tickets.
import type { DatabaseSync } from 'node:sqlite';
import * as board from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { expect, open, test } from './fixtures.ts';
import { PROJECT } from './global-setup.ts';

const HUMAN: Actor = { kind: 'user' };

/** Archives every active project for `run`, then restores exactly the ones it archived. */
async function withNoProjects(db: DatabaseSync, run: () => Promise<void>) {
	const active = db
		.prepare('UPDATE projects SET archived = 1 WHERE archived = 0 RETURNING id')
		.all()
		.map((row) => row.id as number);
	try {
		await run();
	} finally {
		const restore = db.prepare('UPDATE projects SET archived = 0 WHERE id = ?');
		for (const id of active) restore.run(id);
	}
}

/**
 * Clears any agent profile before a "no profile" check. Every other suite creates its own, randomly suffixed
 * profiles and never reads one created elsewhere, so nothing here is worth restoring — this only guards against
 * this file running out of its usual place ahead of the suites that seed profiles.
 */
function clearProfiles(db: DatabaseSync) {
	db.exec('DELETE FROM agent_profiles');
}

test('a 404 for an address that matched no route points its way out at the Stellwerk it links', async ({
	page
}) => {
	await page.goto('/this-view-was-never-built');
	const way = page.getByRole('link', { name: 'Zum Stellwerk' });
	await expect(way).toBeVisible();
	await expect(way).toHaveAttribute('href', '/');
	await way.click();
	await expect(page).toHaveURL('/');
});

test('deleting the last ticket in the Run-Akte lands on a board that still offers something to do', async ({
	page,
	db
}) => {
	// Not seedTicket: its own clean-up would try to delete the ticket this test already deletes through the UI.
	const projectId = Number(process.env.STUDIO_BROWSER_PROJECT_ID);
	const ticket = board.createTicket(db, HUMAN, projectId, { title: 'Throwaway ticket' });
	await open(page, `/p/${PROJECT.key}/t/${ticket.number}`);
	await page.getByRole('button', { name: 'Ticket löschen' }).click();
	await page.getByRole('button', { name: 'Endgültig löschen' }).click();

	await expect(page).toHaveURL('/board');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Board');
});

test('without a project the board says so and leads to creating one, same as the Stellwerk', async ({
	page,
	db
}) => {
	await withNoProjects(db, async () => {
		await open(page, '/board');
		await expect(page.getByText('Noch kein Projekt')).toBeVisible();
		await page.getByRole('link', { name: 'Projekt anlegen' }).click();
		await expect(page).toHaveURL('/projects');
	});
	// the Stellwerk's own "no project" state is covered by projects.test.ts
});

test('Takt without an open question says so and points back to the Stellwerk', async ({ page }) => {
	await open(page, '/takt');
	// The same sentence also sits in a visually-hidden live region for screen readers (line below the queue).
	await expect(page.locator('p.title', { hasText: 'Nichts wartet auf dich' })).toBeVisible();
	const way = page.getByRole('link', { name: 'Zum Stellwerk' });
	await way.click();
	await expect(page).toHaveURL('/');
});

test('a Run-Akte without an agent profile leads to creating one instead of failing to start', async ({
	page,
	db,
	seedTicket
}) => {
	const ticket = seedTicket('Ticket without a profile yet');
	clearProfiles(db);
	await open(page, ticket.path);
	await expect(page.getByText('Noch kein Agent-Profil')).toBeVisible();
	await page.getByRole('link', { name: 'Agent-Profil anlegen' }).click();

	await expect(page).toHaveURL('/settings/profiles');
	await expect(page.getByRole('link', { name: 'Neues Profil' })).toBeVisible();
});
