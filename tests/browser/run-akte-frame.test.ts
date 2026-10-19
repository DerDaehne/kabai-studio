import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { DatabaseSync } from 'node:sqlite';
import { addComment, addTask, deleteTask, tasksOf } from '../../src/lib/server/domain/board.ts';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { createProfile, createRun, finishRun } from '../../src/lib/server/domain/runs.ts';
import type { FakeModel } from './fake-model.ts';
import {
	expect,
	intoWorkStep,
	open,
	queueRun,
	sidewaysScrollers,
	test,
	waitForTransitionsEnd,
	type SeededTicket
} from './fixtures.ts';
import { pageOverflowX } from './widths.ts';

const HUMAN: Actor = { kind: 'user' };
const QUESTION = 'Shall the frame ship today?';

const tab = (page: Page, name: RegExp) => page.getByRole('tab', { name });
const selectedTab = (page: Page) => page.getByRole('tab', { selected: true });
const runIds = (db: DatabaseSync, ticketId: number) =>
	(
		db.prepare('SELECT id FROM runs WHERE ticket_id = ? ORDER BY id').all(ticketId) as {
			id: number;
		}[]
	).map((run) => run.id);

/** A ticket whose real run asked a question: four facets, a step in the trace, a task and a comment. */
async function askingTicket(
	page: Page,
	db: DatabaseSync,
	fakeModel: FakeModel,
	ticket: SeededTicket
) {
	addTask(db, HUMAN, ticket.id, 'Write the frame');
	addComment(db, HUMAN, ticket.id, 'A comment from the human.');
	fakeModel.reply({
		call: { name: 'request_human', args: { question: QUESTION, options: [{ label: 'Yes' }] } }
	});
	await queueRun(db, page, ticket.id, fakeModel);
	await expect.poll(() => openQuestionOf(db, ticket.id), { timeout: 15000 }).toBe(QUESTION);
}

const openQuestionOf = (db: DatabaseSync, ticketId: number) =>
	(
		db
			.prepare('SELECT question FROM questions WHERE ticket_id = ? AND answer IS NULL')
			.get(ticketId) as { question: string } | undefined
	)?.question;

/** A ticket whose real run has ended: it has a trace but nothing to answer. */
async function endedTicket(
	page: Page,
	db: DatabaseSync,
	fakeModel: FakeModel,
	ticket: SeededTicket
) {
	fakeModel.reply({ text: 'Nothing to do.' });
	await queueRun(db, page, ticket.id, fakeModel);
	await expect
		.poll(
			() =>
				(
					db.prepare('SELECT state FROM runs WHERE ticket_id = ?').get(ticket.id) as {
						state: string;
					}
				).state,
			{ timeout: 15000 }
		)
		.toBe('succeeded');
}

test('the title has three levels, a kicker, one bold title and a facts line, and no more', async ({
	page,
	seedTicket
}) => {
	const ticket = seedTicket('A title in three levels');
	await open(page, ticket.path);

	const title = page.getByRole('heading', { level: 1 });
	await expect(title).toHaveCount(1);
	await expect(title).toHaveText('A title in three levels');
	expect(await title.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('600');

	const kicker = page.locator('.rk-kicker');
	const facts = page.getByTestId('facts');
	await expect(kicker).toContainText('WEB');
	await expect(kicker).toContainText(ticket.ref);
	const [kickerBox, titleBox, factsBox] = await Promise.all(
		[kicker, title, facts].map((part) => part.boundingBox())
	);
	expect(kickerBox!.y).toBeLessThan(titleBox!.y);
	expect(titleBox!.y).toBeLessThan(factsBox!.y);
	const sizeOf = (part: typeof title) =>
		part.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
	expect(await sizeOf(title)).toBeGreaterThan(await sizeOf(kicker));
	expect(await sizeOf(title)).toBeGreaterThan(await sizeOf(facts));
	await expect(page.locator('header').filter({ has: title }).getByRole('heading')).toHaveCount(1);
});

test('the facts line names the Lage with its reason, the step and the profile, and the column only in the expert view', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Where does it stand');
	await askingTicket(page, db, fakeModel, ticket);
	await open(page, ticket.path);

	const facts = page.getByTestId('facts');
	await expect(facts).toContainText('Wartet auf dich · Offene Frage');
	await expect(facts.getByRole('img', { name: /^Schritt \d von \d$/ })).toBeVisible();
	await expect(facts).toContainText('Umsetzung');
	await expect(facts).toContainText('Profil Fake model');
	await expect(facts).not.toContainText('Spalte');

	await open(page, '/board');
	await page.getByRole('button', { name: 'Ablauf zeigen' }).click();
	await page.getByRole('link', { name: 'Where does it stand' }).click();
	await expect(page).toHaveURL(new RegExp(`${ticket.path}`));
	await expect(facts).toContainText('Spalte Umsetzen');

	await open(page, '/board');
	await page.getByRole('button', { name: 'Ablauf zeigen' }).click();
	await page.getByRole('link', { name: 'Where does it stand' }).click();
	await expect(facts).not.toContainText('Spalte');
});

test('the pivot offers frage only while a question is open, with counts, and h, l and the arrows switch', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const asking = seedTicket('Pivot with a question');
	await askingTicket(page, db, fakeModel, asking);
	await open(page, asking.path);

	const names = await page.getByRole('tab').allTextContents();
	expect(names.map((name) => name.replace(/\s+/g, ' ').trim())).toEqual([
		'frage 1',
		'spur 1',
		'akte 1',
		'runs 1'
	]);
	await expect(selectedTab(page)).toContainText('frage');
	await expect(page.getByRole('tabpanel')).toContainText(QUESTION);

	await page.keyboard.press('l');
	await expect(selectedTab(page)).toContainText('spur');
	await page.keyboard.press('l');
	await expect(selectedTab(page)).toContainText('akte');
	await page.keyboard.press('h');
	await expect(selectedTab(page)).toContainText('spur');
	await tab(page, /^spur/).focus();
	await page.keyboard.press('ArrowRight');
	await expect(selectedTab(page)).toContainText('akte');
	await expect(selectedTab(page)).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await expect(selectedTab(page)).toContainText('frage');

	await page.keyboard.press('?');
	await expect(
		page.getByRole('region', { name: 'Bewegen' }).getByText('links/rechts')
	).toBeVisible();

	const plain = seedTicket('Pivot without a question');
	await open(page, plain.path);
	const plainNames = await page.getByRole('tab').allTextContents();
	expect(plainNames.map((name) => name.replace(/\s+/g, ' ').trim().replace(/ \d+$/, ''))).toEqual([
		'spur',
		'akte',
		'runs'
	]);
});

test('a switch slides the facet in from the side of its place in the order', async ({
	page,
	seedTicket
}) => {
	const ticket = seedTicket('Slide direction');
	await open(page, ticket.path);
	const slideFrom = () =>
		page.locator('[data-panorama]').evaluate((row) => row.style.getPropertyValue('--slide-from'));
	await tab(page, /^runs/).click();
	expect(await slideFrom(), 'a later facet comes from the right').toBe('1');
	await tab(page, /^akte/).click();
	expect(await slideFrom(), 'an earlier facet comes from the left').toBe('-1');
});

test.describe('the facet in the address', () => {
	test('a switch replaces the address without a history entry, back leaves the file and forward comes back to the facet', async ({
		page,
		seedTicket
	}) => {
		const ticket = seedTicket('Facet in the address');
		await open(page, '/board');
		await page.getByRole('link', { name: 'Facet in the address' }).click();
		await expect(page).toHaveURL(new RegExp(`${ticket.path}$`));
		await expect(selectedTab(page)).toContainText('akte');
		const entries = () => page.evaluate(() => history.length);
		const before = await entries();

		await tab(page, /^runs/).click();
		await expect(page).toHaveURL(`${ticket.path}?facet=runs`);
		await page.keyboard.press('h');
		await expect(page).toHaveURL(`${ticket.path}?facet=akte`);
		await page.keyboard.press('h');
		await expect(page).toHaveURL(`${ticket.path}?facet=spur`);
		expect(await entries(), 'switching facets adds no history entry').toBe(before);

		await page.reload();
		await expect(selectedTab(page)).toContainText('spur');

		await page.goBack();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Board'); // a forward during the turn back is lost
		await page.goForward();
		await expect(page).toHaveURL(`${ticket.path}?facet=spur`);
		await expect(selectedTab(page)).toContainText('spur');
	});

	test('the first HTML already shows the facet of the address', async ({ browser, seedTicket }) => {
		const ticket = seedTicket('Facet before hydration');
		const context = await browser.newContext({ javaScriptEnabled: false });
		const page = await context.newPage();
		await page.goto(`${ticket.path}?facet=runs`);
		const shown = page.locator('[role="tabpanel"]:not([hidden])');
		await expect(shown).toHaveCount(1);
		await expect(shown).toContainText('Noch keine Runs.');
		await context.close();
	});

	test('an open question comes first, a run in the address opens its trace, otherwise the file', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const plain = seedTicket('Opens on the file');
		await open(page, plain.path);
		await expect(selectedTab(page)).toContainText('akte');

		const ended = seedTicket('Opens on the trace');
		await endedTicket(page, db, fakeModel, ended);
		await open(page, ended.path);
		await expect(selectedTab(page)).toContainText('spur');

		const [run] = runIds(db, ended.id);
		await open(page, `${ended.path}?run=${run}`);
		await expect(selectedTab(page)).toContainText('spur');
		await expect(page.getByRole('heading', { name: `Run ${run}` })).toBeVisible();
		await tab(page, /^akte/).click();
		await expect(page).toHaveURL(`${ended.path}?run=${run}&facet=akte`);

		const asking = seedTicket('Opens on the question');
		await askingTicket(page, db, fakeModel, asking);
		await open(page, asking.path);
		await expect(selectedTab(page)).toContainText('frage');
		await open(page, `${asking.path}?facet=akte`);
		await expect(selectedTab(page)).toContainText('akte');
	});
});

test('a live change leaves the facet in front where it is, even when the default would now be another', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Stays where it is');
	await open(page, ticket.path);
	await expect(selectedTab(page)).toContainText('akte');

	await askingTicket(page, db, fakeModel, ticket);
	await expect(tab(page, /^frage/)).toBeVisible();
	await expect(selectedTab(page)).toContainText('akte');
	await expect(page).toHaveURL(ticket.path);
});

test.describe('the file facet', () => {
	test('lists tasks as switches that work by pointer and keyboard, and has no badges left', async ({
		page,
		db,
		seedTicket
	}) => {
		const ticket = seedTicket('Switches in the file');
		const first = addTask(db, HUMAN, ticket.id, 'First task');
		addTask(db, HUMAN, ticket.id, 'Second task');
		const done = (id: number) => tasksOf(db, ticket.id).find((task) => task.id === id)!.done;
		await open(page, ticket.path);

		await expect(page.locator('.rk-rows').first()).toBeVisible();
		await expect(page.locator('.badge')).toHaveCount(0);
		const box = page.getByRole('checkbox', { name: 'First task' });
		await expect(box).not.toBeChecked();
		await box.click();
		await expect.poll(() => done(first.id)).toBe(true);
		await expect(box).toBeChecked();

		await box.focus();
		await page.keyboard.press('Space');
		await expect.poll(() => done(first.id)).toBe(false);
		await expect(box).not.toBeChecked();
	});

	test('shows description, comments and relations as hairline rows', async ({
		page,
		db,
		seedTicket
	}) => {
		const ticket = seedTicket('Rows in the file');
		addComment(db, HUMAN, ticket.id, 'Looks fine to me.');
		await open(page, ticket.path);
		await expect(page.locator('ul.rk-rows.comments > li')).toContainText('Looks fine to me.');
		await expect(page.getByText('Keine Relationen.')).toBeVisible();
	});
});

test.describe('widths', () => {
	const stageHeight = (page: Page) =>
		page.evaluate(() => {
			const probe = document.body.appendChild(document.createElement('div'));
			probe.style.height = 'var(--stage-h)';
			const height = probe.getBoundingClientRect().height;
			probe.remove();
			return height;
		});

	test('375 px scrolls only vertically, 1100 px shows one facet', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const ticket = seedTicket(
			'A ticket with a very long title that has to wrap on a phone without any sideways scrolling at all'
		);
		await askingTicket(page, db, fakeModel, ticket);
		await page.setViewportSize({ width: 375, height: 667 });
		for (const facet of ['frage', 'spur', 'akte', 'runs']) {
			await open(page, `${ticket.path}?facet=${facet}`);
			expect(await pageOverflowX(page), facet).toBeLessThanOrEqual(0);
			expect(await sidewaysScrollers(page), facet).toEqual([]);
		}
		await page.setViewportSize({ width: 1100, height: 800 });
		await open(page, ticket.path);
		await expect(page.locator('[role="tabpanel"]:not([hidden])')).toHaveCount(1);
	});

	for (const width of [1440, 2560]) {
		test(`${width} px keeps one facet behind tabs, and the wheel scrolls the page, not sideways`, async ({
			page,
			db,
			seedTicket,
			fakeModel
		}) => {
			const ticket = seedTicket('Narrow pivot on a wide screen');
			for (let n = 1; n <= 40; n++) addTask(db, HUMAN, ticket.id, `Task ${n}`);
			await askingTicket(page, db, fakeModel, ticket);
			await page.setViewportSize({ width, height: 900 });
			await open(page, `${ticket.path}?facet=akte`);

			await expect(page.getByRole('tablist')).toBeVisible();
			await expect(page.locator('[role="tabpanel"]:not([hidden])')).toHaveCount(1);
			await expect(page.locator('[data-panorama] > section:not([hidden])')).toHaveCount(1);
			expect(await pageOverflowX(page)).toBeLessThanOrEqual(0);
			expect(await sidewaysScrollers(page)).toEqual([]);

			const panel = page.locator('[role="tabpanel"]:not([hidden])');
			const box = (await panel.boundingBox())!;
			await page.mouse.move(box.x + 100, box.y + 100);
			await page.mouse.wheel(0, 400);
			await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
			expect(await page.locator('[data-panorama]').evaluate((row) => row.scrollLeft)).toBe(0);
		});
	}

	for (const scheme of ['light', 'dark'] as const) {
		test(`passes axe in the ${scheme} theme on every facet and on a wide screen`, async ({
			page,
			db,
			seedTicket,
			fakeModel
		}) => {
			const ticket = seedTicket('Axe over the frame');
			await askingTicket(page, db, fakeModel, ticket);
			await page.emulateMedia({ colorScheme: scheme });
			const violations = async () => {
				await waitForTransitionsEnd(page);
				const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
				return result.violations.flatMap((violation) =>
					violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`)
				);
			};
			await page.setViewportSize({ width: 1280, height: 800 });
			for (const facet of ['frage', 'spur', 'akte', 'runs']) {
				await open(page, `${ticket.path}?facet=${facet}`);
				expect(await violations(), `${scheme} ${facet}`).toEqual([]);
			}
			await page.setViewportSize({ width: 375, height: 667 });
			await open(page, `${ticket.path}?facet=akte`);
			expect(await violations(), `${scheme} phone`).toEqual([]);
			await page.setViewportSize({ width: 1440, height: 900 });
			await open(page, ticket.path);
			expect(await violations(), `${scheme} wide screen`).toEqual([]);
		});
	}
});

const reduced: Record<string, (page: Page) => Promise<unknown>> = {
	'the system asks for it': (page) => page.emulateMedia({ reducedMotion: 'reduce' }),
	'the app setting is off': (page) =>
		page.addInitScript(() => localStorage.setItem('studio-motion', 'reduced'))
};

test.describe('motion', () => {
	const panelAnimations = (page: Page) =>
		page
			.locator('[role="tabpanel"]:not([hidden])')
			.evaluate((panel) => panel.getAnimations().length);

	test('a switch slides the facet in while motion is on', async ({ page, seedTicket }) => {
		await open(page, seedTicket('Moving facets').path);
		await tab(page, /^runs/).click();
		expect(await panelAnimations(page)).toBeGreaterThan(0);
	});

	for (const [reason, reduce] of Object.entries(reduced)) {
		test(`a switch jumps when ${reason}`, async ({ page, seedTicket }) => {
			await reduce(page);
			await open(page, seedTicket('Still facets').path);
			await tab(page, /^runs/).click();
			await expect(selectedTab(page)).toContainText('runs');
			await page.evaluate(
				() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
			);
			expect(await panelAnimations(page)).toBe(0);
		});
	}
});

test('the project tag in the kicker is its own element, not just text', async ({
	page,
	seedTicket
}) => {
	await open(page, seedTicket('Tag in the kicker').path);
	const tag = page.locator('.rk-kicker span').first();
	await expect(tag).toHaveText('WEB');
	expect(await tag.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
		'rgba(0, 0, 0, 0)'
	);
});

test('a switch keeps the scroll position of the window', async ({ page, db, seedTicket }) => {
	const ticket = seedTicket('Keeps the scroll position');
	for (let i = 1; i <= 30; i++) addTask(db, HUMAN, ticket.id, `Task ${i}`);
	intoWorkStep(db, ticket.id);
	const profile = createProfile(db, HUMAN, {
		name: 'Unreachable model',
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: 'http://127.0.0.1:9',
		model: 'none'
	});
	// enough runs that the runs facet is a long page too, so the window never has to clamp
	for (let i = 0; i < 30; i++) {
		const run = createRun(db, HUMAN, { ticketId: ticket.id, profileId: profile.id }) as unknown as {
			id: number;
		};
		finishRun(db, HUMAN, run.id, { state: 'cancelled' });
	}
	await page.setViewportSize({ width: 375, height: 667 });
	await open(page, `${ticket.path}?facet=akte`);
	const target = await page.evaluate(() =>
		Math.round(
			document.querySelector('[role="tablist"]')!.getBoundingClientRect().top + scrollY - 120
		)
	);
	expect(target).toBeGreaterThan(100);
	await page.evaluate((y) => scrollTo(0, y), target);
	await expect.poll(() => page.evaluate(() => scrollY)).toBe(target);
	await page.keyboard.press('l');
	await expect(selectedTab(page)).toContainText('runs');
	await page.waitForTimeout(300);
	expect(await page.evaluate(() => scrollY)).toBe(target);
});

test('a run link in the runs facet brings its trace in front, and back returns to runs', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Run link inside the file');
	await endedTicket(page, db, fakeModel, ticket);
	await open(page, `${ticket.path}?facet=runs`);
	await page.getByRole('list', { name: 'Runs dieses Tickets' }).getByRole('link').first().click();
	await expect(page).toHaveURL(/\?run=\d+&facet=spur$/);
	await expect(selectedTab(page)).toContainText('spur');
	await page.goBack();
	await expect(page).toHaveURL(`${ticket.path}?facet=runs`);
	await expect(selectedTab(page)).toContainText('runs');
});

test('a question answered elsewhere takes frage away and the default facet comes to the front', async ({
	page,
	browser,
	db,
	seedTicket,
	fakeModel
}) => {
	const ticket = seedTicket('Answered elsewhere');
	await askingTicket(page, db, fakeModel, ticket);
	await open(page, ticket.path);
	await expect(selectedTab(page)).toContainText('frage');

	const other = await browser.newContext();
	const takt = await other.newPage();
	await open(takt, '/takt');
	await expect(takt.getByRole('heading', { name: QUESTION })).toBeVisible();
	await takt.keyboard.press('1');
	await expect(takt.getByText(/Antwort gesendet/)).toBeVisible();

	await expect(tab(page, /^frage/)).toHaveCount(0, { timeout: 15000 });
	await expect(selectedTab(page)).toHaveCount(1);
	await expect(page.locator('[role="tabpanel"]:not([hidden])')).toHaveCount(1);
	await other.close();
});

test('a task switch that the server refuses jumps back', async ({ page, db, seedTicket }) => {
	const ticket = seedTicket('Refused switch');
	const task = addTask(db, HUMAN, ticket.id, 'Vanishing task');
	await open(page, ticket.path);
	const box = page.getByRole('checkbox', { name: 'Vanishing task' });
	deleteTask(db, HUMAN, task.id, 'gone before the click');
	await box.click();
	await expect(box).not.toBeChecked();
});

test('back to the file at 1440 px brings the facet and the scroll position of the page back', async ({
	page,
	db,
	seedTicket
}) => {
	const ticket = seedTicket('Scroll on back');
	for (let i = 1; i <= 40; i++) addTask(db, HUMAN, ticket.id, `Task ${i}`);
	await page.setViewportSize({ width: 1440, height: 600 });
	await open(page, `${ticket.path}?facet=akte`);
	await page.evaluate(() => scrollTo(0, 400));
	await expect.poll(() => page.evaluate(() => scrollY)).toBe(400);
	await page.getByRole('link', { name: 'takt' }).first().click();
	await expect(page).toHaveURL('/takt');
	await page.goBack();
	await expect(page).toHaveURL(`${ticket.path}?facet=akte`);
	await expect(selectedTab(page)).toContainText('akte');
	await expect.poll(() => page.evaluate(() => scrollY)).toBe(400);
});

test('the facet heading stays in the outline when the tabs show, so no level is skipped', async ({
	page,
	seedTicket
}) => {
	await page.setViewportSize({ width: 375, height: 667 });
	await open(page, `${seedTicket('Outline').path}?facet=akte`);
	await expect(page.getByRole('heading', { level: 2, name: /^akte/ })).toHaveCount(1);
	const hidden = await page
		.getByRole('heading', { level: 2, name: /^akte/ })
		.evaluate((el) => el.getBoundingClientRect().width);
	expect(hidden, 'visually hidden, not laid out').toBeLessThanOrEqual(1);
});

test('an expert-view choice kept for /board moves up to every page once the board has loaded', async ({
	page,
	context,
	seedTicket
}) => {
	const ticket = seedTicket('Old cookie path');
	await open(page, '/');
	const { hostname } = new URL(page.url());
	await context.addCookies([
		{ name: 'studio-board-view', value: 'flow', domain: hostname, path: '/board' }
	]);
	await open(page, '/board');
	await open(page, ticket.path);
	await expect(page.getByTestId('facts')).toContainText('Spalte');
});
