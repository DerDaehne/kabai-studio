import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { addComment, addTask } from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { createProfile } from '../../src/lib/server/domain/runs.ts';
import { axeExceptions } from './axe.exceptions.ts';
import { expect, open, queueRun, test } from './fixtures.ts';

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
	// Switching in place starts colour transitions; axe has to judge the colours they settle on, not one in between.
	await page.waitForFunction(() =>
		document.getAnimations().every((animation) => !(animation instanceof CSSTransition))
	);
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
		await expect(page.getByRole('listitem').filter({ hasText: ticket.ref })).toContainText('hält');

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
		await expect(page.getByText(taskTitle)).toBeVisible();

		await checkEveryCombination(page, 'run-akte');
	});

	test('board', async ({ page, seedTicket }) => {
		seedTicket('Axe gate: a ticket visible on the board');
		await open(page, '/board');

		await checkEveryCombination(page, 'board');
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
});
