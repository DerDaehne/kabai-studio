import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { createProfile, createRun, finishRun, startRun } from '../../src/lib/server/domain/runs.ts';
import { expect, intoWorkStep, open, queueRun, test } from './fixtures.ts';

const HUMAN: Actor = { kind: 'user' };
const REKTA_EASE_OUT = 'cubic-bezier(0.4, 0, 0.5, 1)';

/** Seeds a run of `ticketId` that already ended in failure, so the start page shows a tile for it. */
function failedRun(db: DatabaseSync, ticketId: number): void {
	intoWorkStep(db, ticketId);
	const profile = createProfile(db, HUMAN, {
		name: `Fake ${randomUUID()}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: 'http://127.0.0.1:1',
		model: 'fake'
	}).id;
	const run = createRun(db, HUMAN, { ticketId, profileId: profile }).id;
	startRun(db, HUMAN, run);
	finishRun(db, HUMAN, run, { state: 'failed', error: 'boom' });
}

/** Remembers the names of the CSS animations that start from now on in `window.startedAnimations`. */
const recordStartedAnimations = (page: Page) =>
	page.evaluate(() => {
		const started: string[] = [];
		(window as unknown as { startedAnimations: string[] }).startedAnimations = started;
		document.addEventListener(
			'animationstart',
			(event) => started.push(event.animationName.replace(/^svelte-\w+-/, '')),
			true
		);
	});
const startedAnimations = (page: Page) =>
	page.evaluate(() => (window as unknown as { startedAnimations: string[] }).startedAnimations);
/** What still runs, by name and target, so a failure says which animation it is. */
const runningAnimations = (page: Page, within = 'body') =>
	page.evaluate(
		(within) =>
			document
				.querySelector(within)!
				.getAnimations({ subtree: true })
				.filter((animation) => animation.playState === 'running')
				.map((animation) => {
					const { animationName, transitionProperty } = animation as CSSAnimation & CSSTransition;
					const target = (animation.effect as KeyframeEffect).target;
					return `${animationName ?? transitionProperty} on ${target?.tagName}.${target?.className}`;
				}),
		within
	);
const twoFrames = (page: Page) =>
	page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);

test('headings use the Rekta weights: the title 600, the group headings 500', async ({ page }) => {
	await open(page, '/dev/ui');
	const weights = await page.evaluate(() =>
		['h1', 'h2', 'h3'].map((tag) => {
			const heading = document.body.appendChild(document.createElement(tag));
			const weight = getComputedStyle(heading).fontWeight;
			heading.remove();
			return weight;
		})
	);
	expect(weights).toEqual(['600', '500', '500']);
});

test("the turnstile eases with Rekta's curve and keeps its duration", async ({ page }) => {
	await open(page, '/');
	await page.evaluate(() => {
		const seen: string[][] = [];
		(window as unknown as { turnstile: string[][] }).turnstile = seen;
		const sample = () => {
			const style = getComputedStyle(document.documentElement, '::view-transition-new(root)');
			if (style.animationName === 'turnstile-in')
				seen.push([style.animationTimingFunction, style.animationDuration]);
			if (seen.length < 5) requestAnimationFrame(sample);
		};
		sample();
	});
	await page
		.getByRole('navigation', { name: 'Ansichten' })
		.getByRole('link', { name: /^takt/i })
		.click();
	await expect(page).toHaveURL('/takt');
	await expect
		.poll(() => page.evaluate(() => (window as unknown as { turnstile: string[][] }).turnstile))
		.toContainEqual([REKTA_EASE_OUT, '0.4s']);
});

test.describe('tiles build in', () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test('while the view arrives, but a tile that a live update adds later appears without it', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		failedRun(db, seedTicket('A tile that is there on arrival').id);
		await page.addInitScript(() => {
			const started: string[] = [];
			(window as unknown as { startedAnimations: string[] }).startedAnimations = started;
			document.addEventListener(
				'animationstart',
				(event) => started.push(event.animationName.replace(/^svelte-\w+-/, '')),
				true
			);
		});
		await open(page, '/');
		await expect.poll(() => startedAnimations(page), 'on arrival').toContain('tile-in');

		await expect(page.locator('.start')).not.toHaveAttribute('data-rk-arriving');
		await recordStartedAnimations(page);
		fakeModel.reply({
			call: { name: 'request_human', args: { question: 'Live?', options: [{ label: 'Ja' }] } }
		});
		const asking = seedTicket('A run that asks');
		await queueRun(db, page, asking.id, fakeModel);
		const live = page.locator('.slot').filter({ hasText: 'Live?' });
		await expect(live).toBeVisible();
		await twoFrames(page);
		const buildIns = await live.evaluate(
			(el) =>
				el.getAnimations().filter((a) => /tile-in$/.test((a as CSSAnimation).animationName)).length
		);
		expect(buildIns, 'the new tile runs no build-in').toBe(0);
		expect(await startedAnimations(page), 'a live update builds nothing in').not.toContain(
			'tile-in'
		);
		await page.keyboard.press('1');
	});
});

test.describe('controls', () => {
	const controlHeights = (page: Page) =>
		page.evaluate(() => {
			const probe = (className: string) => {
				const button = document.body.appendChild(document.createElement('button'));
				button.className = className;
				const { height } = button.getBoundingClientRect();
				button.remove();
				return height;
			};
			return { normal: probe('btn'), small: probe('btn btn-sm') };
		});

	test.describe('with a fine pointer', () => {
		test('are 32 px high', async ({ page }) => {
			await open(page, '/settings');
			expect(await controlHeights(page)).toEqual({ normal: 32, small: 32 });
		});
	});

	test.describe('with touch', () => {
		test.use({ hasTouch: true });

		test('are 44 px high', async ({ page }) => {
			await open(page, '/settings');
			expect(await controlHeights(page)).toEqual({ normal: 44, small: 44 });
		});
	});
});

const reducedMotion: Record<string, (page: Page) => Promise<unknown>> = {
	'the system asks for it': (page) => page.emulateMedia({ reducedMotion: 'reduce' }),
	'the app setting is off': (page) =>
		page.addInitScript(() => localStorage.setItem('studio-motion', 'reduced'))
};

for (const [reason, reduce] of Object.entries(reducedMotion)) {
	test(`when ${reason} nothing keeps running in the start view, the head, the turnstile and the pivot`, async ({
		page,
		db,
		seedTicket
	}) => {
		await reduce(page);
		failedRun(db, seedTicket('A failed run tile').id);
		await page.setViewportSize({ width: 375, height: 667 });
		await open(page, '/');
		await twoFrames(page);
		expect(await runningAnimations(page), 'start view').toEqual([]);

		await page
			.getByRole('navigation', { name: 'Ansichten' })
			.getByRole('link', { name: /^board/i })
			.click();
		await expect(page).toHaveURL('/board');
		await twoFrames(page);
		expect(await runningAnimations(page), 'head and turnstile').toEqual([]);

		await open(page, '/dev/ui');
		await page
			.getByTestId('pivot-showcase')
			.getByRole('tab', { name: /^Fertig/ })
			.click();
		await twoFrames(page);
		expect(await runningAnimations(page, '[data-testid="pivot-showcase"]'), 'pivot').toEqual([]);
	});
}
