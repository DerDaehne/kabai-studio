import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { addComment, addTask, createProject } from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import {
	disconnectRunner,
	issuePairingCode,
	pairRunner
} from '../../src/lib/server/domain/runners.ts';
import { createProfile } from '../../src/lib/server/domain/runs.ts';
import { axeExceptions } from './axe.exceptions.ts';
import { expect, open, queueRun, test, waitForTransitionsEnd } from './fixtures.ts';

// Ratchet: axeExceptions.length today. Lower it whenever an entry below is fixed and removed; never raise it to
// match a growing list — that defeats the point of the exception list (see axe.exceptions.ts).
const MAX_EXCEPTIONS = 0;

const HUMAN: Actor = { kind: 'user' };

type Theme = 'light' | 'dark';
type Width = 'phone' | 'desktop';
const themes: Theme[] = ['light', 'dark'];
const widths: Width[] = ['phone', 'desktop'];
const phoneViewport = { width: 375, height: 667 };

/** Sets the theme the way `storePreference()` does (`+layout.svelte`): a data attribute plus localStorage. */
async function setTheme(page: Page, theme: Theme) {
	await page.evaluate((value) => {
		document.documentElement.dataset.theme = value;
		localStorage.setItem('studio-theme', value);
	}, theme);
}

/** Checks one already-open page against WCAG 2.1 A/AA in one theme and width, and reports unexpected violations. */
async function checkView(page: Page, view: string, theme: Theme, width: Width) {
	await page.setViewportSize(width === 'phone' ? phoneViewport : { width: 1280, height: 720 });
	await setTheme(page, theme);
	await waitForTransitionsEnd(page);
	const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
	const found = violations.flatMap((violation) =>
		violation.nodes.map((node) => ({ ruleId: violation.id, selector: node.target.join(' ') }))
	);
	const unexpected = found.filter(
		(violation) =>
			!axeExceptions.some(
				(exception) =>
					exception.view === view &&
					exception.theme === theme &&
					exception.width === width &&
					exception.ruleId === violation.ruleId &&
					exception.selector === violation.selector
			)
	);
	expect(unexpected, `${view} (${theme}, ${width}): unexpected axe violations`).toEqual([]);
}

/**
 * Runs `checkView` for every theme × width combination against the page already left open on the view under test.
 * `storePreference()` switches the theme in place without a reload, so this does the same instead of navigating
 * four times.
 */
async function checkEveryCombination(page: Page, view: string) {
	for (const theme of themes) {
		for (const width of widths) {
			await checkView(page, view, theme, width);
		}
	}
}

test('the exception list only shrinks', () => {
	expect(axeExceptions.length).toBeLessThanOrEqual(MAX_EXCEPTIONS);
});

test.describe('WCAG 2.1 A/AA, light/dark × phone/desktop', () => {
	test('start page (Stellwerk)', async ({ page, db, seedTicket, fakeModel }) => {
		fakeModel.reply({
			call: {
				name: 'request_human',
				args: { question: 'Deploy now or later?', options: [{ label: 'Jetzt' }] }
			}
		});
		const ticket = seedTicket('Axe gate: an active run holding on a question');
		await open(page, '/');
		await queueRun(db, page, ticket.id, fakeModel);
		await expect(page.getByRole('listitem').filter({ hasText: ticket.ref })).toContainText('fragt');

		await checkEveryCombination(page, 'start');
	});

	test('Takt', async ({ page, db, seedTicket, fakeModel }) => {
		const question = 'Axe gate: ship the backup to the cold volume now?';
		fakeModel.reply({
			call: { name: 'request_human', args: { question, options: [{ label: 'Ja' }] } }
		});
		const ticket = seedTicket('Axe gate: a question waiting in Takt');
		await open(page, '/takt');
		await queueRun(db, page, ticket.id, fakeModel);
		await expect(page.getByRole('heading', { name: question })).toBeVisible();

		await checkEveryCombination(page, 'takt');
	});

	test('Run-Akte (ticket page)', async ({ page, db, seedTicket }) => {
		const ticket = seedTicket('Axe gate: a ticket with a task and a comment');
		const taskTitle = 'Check the rendered task list for a11y issues';
		addTask(db, HUMAN, ticket.id, taskTitle);
		addComment(db, HUMAN, ticket.id, 'A real work-log comment, so the comment list is not empty.');
		await open(page, ticket.path);
		await expect(page.getByRole('button', { name: `[ ] ${taskTitle}` })).toBeVisible();

		await checkEveryCombination(page, 'run-akte');
	});

	test('board', async ({ page, seedTicket }) => {
		seedTicket('Axe gate: a ticket visible on the board');
		await open(page, '/board');

		await checkEveryCombination(page, 'board');
	});

	test('board flow with projects of two variants', async ({ page, db, seedTicket }) => {
		seedTicket('Axe gate: a ticket in the grouped flow');
		const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
		const { id } = createProject(
			db,
			HUMAN,
			{ key: `A${suffix}`, name: `Axe knowledge ${suffix}` },
			'knowledge'
		);
		try {
			await open(page, '/board');
			await page.keyboard.press(' ');
			await page.keyboard.press('g');
			await expect(page.locator('.variant-name').first()).toBeVisible();

			await checkEveryCombination(page, 'board-flow');
		} finally {
			db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(id);
		}
	});

	test('projects', async ({ page }) => {
		// The browser suite's own project ("WEB", from global-setup.ts) is already real content.
		await open(page, '/projects');

		await checkEveryCombination(page, 'projects');
	});

	test('settings', async ({ page }) => {
		await open(page, '/settings');

		await checkEveryCombination(page, 'settings');
	});

	test('settings/profiles', async ({ page, db }) => {
		createProfile(db, HUMAN, {
			name: 'Axe gate profile',
			executor: 'builtin',
			provider: 'openai-compatible',
			base_url: 'http://127.0.0.1:1',
			model: 'fake'
		});
		await open(page, '/settings/profiles');

		await checkEveryCombination(page, 'settings-profiles');
	});

	test('settings/runners with the connect dialog open', async ({ page, db }) => {
		const machine = pairRunner(db, { code: issuePairingCode().code, name: 'Axe gate machine' });
		try {
			await open(page, '/settings/runners');
			await checkEveryCombination(page, 'settings-runners');

			await page.getByRole('button', { name: 'Rechner verbinden' }).click();
			await expect(page.getByRole('textbox', { name: 'Befehl' })).toBeFocused();
			await checkEveryCombination(page, 'settings-runners-connect');
		} finally {
			disconnectRunner(db, machine.id);
		}
	});
});

test.describe('the shell: app bar, banner, toast and crumb', () => {
	test('a standing pause banner and a toast with a countdown pass axe in both themes and widths', async ({
		page
	}) => {
		await open(page, '/dev/ui');
		try {
			expect((await page.request.post('/api/pause')).ok()).toBe(true);
			await expect(page.locator('.rk-banner[data-status="warning"]')).toBeVisible();
			await page.getByRole('button', { name: 'Rückgängig-Meldung' }).click();
			await expect(page.locator('.rk-toast')).toBeVisible();
			// the showcase page around them has findings of its own; the shell parts are what is under test
			for (const theme of themes) {
				for (const width of widths) {
					await page.setViewportSize(
						width === 'phone' ? phoneViewport : { width: 1280, height: 720 }
					);
					await setTheme(page, theme);
					await waitForTransitionsEnd(page);
					const { violations } = await new AxeBuilder({ page })
						.include('.rk-appbar')
						.include('.rk-banner')
						.include('.rk-toasts')
						.withTags(['wcag2a', 'wcag2aa'])
						.analyze();
					expect(
						violations.map((violation) => violation.id),
						`${theme}, ${width}`
					).toEqual([]);
				}
			}
		} finally {
			await page.request.delete('/api/halt');
		}
	});

	test('the crumb passes axe in both themes and widths', async ({ page, seedTicket }) => {
		await open(page, seedTicket('Axe gate: a crumb above the title').path);
		await expect(page.locator('.rk-crumb')).toBeVisible();
		await checkEveryCombination(page, 'crumb');
	});
});
