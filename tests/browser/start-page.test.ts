import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import type { Actor } from '../../src/lib/server/domain/core.ts';
import { createProject, createTicket, deleteTicket } from '../../src/lib/server/domain/board.ts';
import { haltRuns, releaseHalt } from '../../src/lib/server/domain/halt.ts';
import { latestOpenQuestion } from '../../src/lib/server/domain/questions.ts';
import {
	appendEvent,
	createProfile,
	createRun,
	finishRun,
	startRun,
	type RunEnd
} from '../../src/lib/server/domain/runs.ts';
import { expect, intoWorkStep, open, queueRun, sidewaysScrollers, test } from './fixtures.ts';

const HUMAN: Actor = { kind: 'user' };

function profileOnUnreachableHost(db: DatabaseSync): number {
	return createProfile(db, HUMAN, {
		name: `Fake ${randomUUID()}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: 'http://127.0.0.1:1',
		model: 'fake'
	}).id;
}

/** Seeds a run of `ticketId` that already ended with `end`. */
function finishedRun(db: DatabaseSync, ticketId: number, end: RunEnd): number {
	intoWorkStep(db, ticketId);
	const run = createRun(db, HUMAN, { ticketId, profileId: profileOnUnreachableHost(db) }).id;
	startRun(db, HUMAN, run); // a run only ends from "running"
	finishRun(db, HUMAN, run, end);
	return run;
}

/** Enough projects to make the start page's project list scroll; `remove` takes them away again. */
function crowdProjects(db: DatabaseSync) {
	const ids = Array.from(
		{ length: 20 },
		(_, i) =>
			createProject(db, HUMAN, {
				key: `C${i}${randomUUID()
					.slice(0, 6)
					.toUpperCase()
					.replace(/[^A-Z0-9]/g, 'X')}`,
				name: `Crowd ${i}`
			}).id
	);
	return {
		remove: () => ids.forEach((id) => db.prepare('DELETE FROM projects WHERE id = ?').run(id))
	};
}

/** A second project with one ticket whose run failed; `remove` takes both away again. */
function otherProjectWithFailedRun(db: DatabaseSync) {
	const key = `Z${randomUUID()
		.replace(/\W/g, '')
		.slice(0, 6)
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, 'X')}`;
	const project = createProject(db, HUMAN, { key, name: `Other ${key}` }).id;
	const ticket = createTicket(db, HUMAN, project, { title: 'Failed elsewhere' }).id;
	finishedRun(db, ticket, { state: 'failed', error: 'boom' });
	return {
		remove: () => {
			deleteTicket(db, HUMAN, ticket);
			db.prepare('DELETE FROM projects WHERE id = ?').run(project);
		}
	};
}

const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const tileOf = (page: Page, ref: string) =>
	section(page, 'jetzt').locator('.slot').filter({ hasText: ref });
/** The phase word under a run tile; the state tag beside the ticket may say the same word. */
const phaseOf = (page: Page, ref: string, word: string) =>
	tileOf(page, ref)
		.locator('span.muted')
		.filter({ hasText: new RegExp(`^${word}$`) });
const runIdOf = (db: DatabaseSync, ticketId: number) =>
	(db.prepare('SELECT max(id) AS id FROM runs WHERE ticket_id = ?').get(ticketId) as { id: number })
		.id;

test('without an active run the status line says no agent is at work and leads to the board', async ({
	page
}) => {
	await open(page, '/');
	await expect(page.getByRole('status').filter({ hasText: 'Kein Agent arbeitet.' })).toBeVisible();

	await page.getByRole('link', { name: 'Zum Board' }).click();
	await expect(page).toHaveURL('/board');
});

test.describe('at 1440 px', () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test('a question is a 2×2 tile, answered with 1 in place, taken back with u, and arrives live in a second tab too', async ({
		page,
		context,
		db,
		seedTicket,
		fakeModel
	}) => {
		const question = 'Ship it now or after the review?';
		fakeModel.reply({
			call: {
				name: 'request_human',
				args: { question, options: [{ label: 'Jetzt' }, { label: 'Später' }] }
			}
		});
		const ticket = seedTicket('Decide in a tile');
		const second = await context.newPage();
		await open(second, '/');
		await open(page, '/');

		await queueRun(db, page, ticket.id, fakeModel);
		const tile = tileOf(page, ticket.ref).filter({ hasText: question });
		await expect(tile).toHaveAttribute('data-size', '2x2');
		await expect(tile).toContainText(question);
		await expect(tileOf(second, ticket.ref)).toHaveAttribute('data-size', '2x2');
		const box = (await tile.boundingBox())!;
		expect(Math.round(box.width)).toBe(308); // two units of 150 px and one gap
		expect(Math.round(box.height)).toBe(308);
		await expect(page.getByRole('status').filter({ hasText: ticket.ref })).toBeVisible();

		await page.keyboard.press('1');
		await expect(page.getByText(`Antwort gesendet · ${ticket.ref}`)).toBeVisible();
		await expect(tile).toBeHidden();
		await page.keyboard.press('u');
		await expect(tile).toContainText(question);
		expect(latestOpenQuestion(db, ticket.id)).toMatchObject({ question, answer: null });

		fakeModel.reply({ text: 'Erledigt.' });
		await tile.getByRole('button', { name: 'Antwort 2: Später' }).click();
		await expect(tileOf(second, ticket.ref).filter({ hasText: question })).toBeHidden();
		const finished = section(page, 'betrieb').getByRole('listitem').filter({ hasText: ticket.ref });
		await expect(finished.filter({ hasText: 'wartet' })).toBeVisible(); // the follow-up run waits out the undo window
		// the real window is 10 s; waiting it out would eat the test's budget, so the follow-up is released here
		const released = db
			.prepare(
				"UPDATE runs SET not_before = NULL WHERE ticket_id = ? AND state = 'queued' AND not_before IS NOT NULL"
			)
			.run(ticket.id).changes;
		expect(released).toBe(1);
		expect((await page.request.delete('/api/halt')).ok()).toBe(true);
		await expect(finished.filter({ hasText: 'fertig' })).toBeVisible({ timeout: 15_000 });
		await second.close();
	});

	test('the panorama fills the stage: three sections fit, the fourth begins, the wheel scrolls sideways and the window stays', async ({
		page,
		db
	}) => {
		const crowded = crowdProjects(db);
		try {
			await open(page, '/');
			const lefts = await page
				.locator('.panorama > section')
				.evaluateAll((sections) =>
					sections.map((s) => [s.getBoundingClientRect().left, s.getBoundingClientRect().right])
				);
			expect(lefts).toHaveLength(4);
			for (const [, right] of lefts.slice(0, 3)) expect(right).toBeLessThanOrEqual(1440);
			expect(lefts[3][0]).toBeLessThan(1440);
			await expect(page.getByText('← → oder seitlich scrollen')).toBeVisible();

			const panorama = page.locator('.panorama');
			const bottom = await panorama.evaluate((el) => el.getBoundingClientRect().bottom);
			const appBarTop = await page
				.locator('footer.appbar')
				.evaluate((el) => el.getBoundingClientRect().top);
			expect(Math.abs(bottom - appBarTop)).toBeLessThanOrEqual(1);

			const projects = await section(page, 'projekte').evaluate((el) => ({
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight
			}));
			expect(
				projects.scrollHeight,
				'the project list overflows, so it keeps a wheel over it'
			).toBeGreaterThan(projects.clientHeight);
			// the gap between two sections has no list of its own that could keep the wheel
			const gapBetweenSections = (lefts[0][1] + lefts[1][0]) / 2;
			await page.mouse.move(gapBetweenSections, 600);
			await page.mouse.wheel(0, 300);
			await expect.poll(() => panorama.evaluate((el) => el.scrollLeft)).toBe(300);
			expect(await page.evaluate(() => window.scrollY)).toBe(0);
		} finally {
			crowded.remove();
		}
	});

	test('keys: → and ← change the section, j moves within it, * focuses its project, gt opens the Takt', async ({
		page,
		db,
		seedTicket
	}) => {
		const ticket = seedTicket('Reach me by keys');
		finishedRun(db, ticket.id, { state: 'succeeded' });
		finishedRun(db, ticket.id, { state: 'cancelled' }); // two rows in operations, so j has somewhere to go
		await open(page, '/');

		await page.keyboard.press('ArrowRight');
		await expect(section(page, 'projekte').locator('[data-item]').first()).toBeFocused();
		await page.keyboard.press('l');
		const operations = section(page, 'betrieb');
		await expect(operations.locator('[data-item]').first()).toBeFocused();
		await page.keyboard.press('j');
		await expect(operations.locator('[data-item]').nth(1)).toBeFocused();
		await page.keyboard.press('ArrowLeft');
		await expect(section(page, 'projekte').locator('[data-item]').first()).toBeFocused();

		const name = await section(page, 'projekte').locator('[data-item] .name').first().textContent();
		await page.keyboard.press('*');
		await expect(page.locator('main .focus')).toContainText(name ?? '');
		await page.keyboard.press(' ');
		await page.keyboard.press(' ');

		await page.keyboard.press('g');
		await page.keyboard.press('t');
		await expect(page).toHaveURL('/takt');
	});

	test('answering a question lifts the tile out and the tile behind it glides into its place', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		fakeModel.reply({
			call: { name: 'request_human', args: { question: 'Glide?', options: [{ label: 'Ja' }] } }
		});
		const behind = seedTicket('A failed run behind the question');
		finishedRun(db, behind.id, { state: 'failed', error: 'boom' });
		const asking = seedTicket('A run that asks');
		await open(page, '/');
		await queueRun(db, page, asking.id, fakeModel);
		await expect(tileOf(page, asking.ref).filter({ hasText: 'Glide?' })).toBeVisible();
		const moving = tileOf(page, behind.ref);
		const positionOf = () => moving.evaluate((el) => el.getBoundingClientRect().left);
		await expect.poll(positionOf).toBeGreaterThan(300); // beside the 2×2 question
		const before = await positionOf();
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						[...document.querySelectorAll('.slot')]
							.find((el) => el.textContent?.includes('boom'))!
							.getAnimations()
							.filter((animation) => animation.playState !== 'finished').length
				)
			)
			.toBe(0); // the slide-in has ended, so only the glide can move the slot
		await page.evaluate(() => {
			const slot = [...document.querySelectorAll('.slot')].find((el) =>
				el.textContent?.includes('boom')
			);
			const seen: number[] = [];
			(window as unknown as { seen: number[] }).seen = seen;
			const sample = () => {
				seen.push(slot!.getBoundingClientRect().left);
				if (seen.length < 120) requestAnimationFrame(sample);
			};
			sample();
		});

		await page.keyboard.press('1');
		await expect.poll(positionOf).toBeLessThan(before - 100);
		const after = await positionOf();
		const seen = await page.evaluate(() => (window as unknown as { seen: number[] }).seen);
		const inFlight = seen.filter((left) => left < before - 30 && left > after + 30);
		expect(inFlight.length).toBeGreaterThan(0); // seen well between the old and the new place, not jumping
		await page.keyboard.press('u');
	});

	test('operations shows the earliest start of a queued run', async ({ page, db, seedTicket }) => {
		const ticket = seedTicket('A run that starts later');
		const startsAt = new Date(Date.now() + 3 * 3_600_000);
		intoWorkStep(db, ticket.id);
		createRun(db, HUMAN, {
			ticketId: ticket.id,
			profileId: profileOnUnreachableHost(db),
			notBefore: startsAt.toISOString()
		});
		await open(page, '/');
		const expected = await page.evaluate(
			(iso) =>
				new Intl.DateTimeFormat(navigator.language, { timeStyle: 'short' }).format(new Date(iso)),
			startsAt.toISOString()
		);

		const row = section(page, 'betrieb').getByRole('listitem').filter({ hasText: ticket.ref });
		await expect(row).toContainText(`frühester Start ${expected}`);
	});

	test('Enter opens the Run-Akte of the focused tile and k moves back up a tile', async ({
		page,
		db,
		seedTicket
	}) => {
		const older = seedTicket('First failed run');
		const newer = seedTicket('Second failed run');
		finishedRun(db, older.id, { state: 'failed', error: 'boom' });
		const newest = finishedRun(db, newer.id, { state: 'failed', error: 'boom' });
		await open(page, '/');
		const tiles = section(page, 'jetzt').locator('[data-item]');
		await tiles.first().focus();
		await page.keyboard.press('j');
		await expect(tiles.nth(1)).toBeFocused();
		await page.keyboard.press('k');
		await expect(tiles.first()).toBeFocused();

		const focused = await tiles.first().textContent();
		const expected = focused?.includes(newer.ref) ? newer : older;
		await page.keyboard.press('Enter');
		const runId = expected === newer ? newest : runIdOf(db, older.id);
		await expect(page).toHaveURL(`${expected.path}?run=${runId}`);
	});

	test('with a project focused, the other projects’ tiles fold into one line saying how many and in how many projects', async ({
		page,
		db,
		seedTicket
	}) => {
		const own = seedTicket('Tile of the focused project');
		finishedRun(db, own.id, { state: 'failed', error: 'boom' });
		const others = [otherProjectWithFailedRun(db), otherProjectWithFailedRun(db)];
		try {
			await open(page, '/');
			await expect(section(page, 'jetzt').locator('.slot')).toHaveCount(3);
			const ownProject = section(page, 'projekte').locator('[data-item]').filter({
				hasText: 'Browser-Suite'
			});
			await ownProject.focus();
			await page.keyboard.press('*');

			await expect(section(page, 'jetzt').locator('.slot')).toHaveCount(1);
			await expect(tileOf(page, own.ref)).toBeVisible();
			await expect(page.getByText('2 weitere in 2 anderen Projekten')).toBeVisible();
		} finally {
			for (const other of others) other.remove();
		}
	});

	test('a run held by the human is no agent at work in its project', async ({ page, db }) => {
		const project = createProject(db, HUMAN, { key: 'HELD', name: 'Held project' }).id;
		const ticket = createTicket(db, HUMAN, project, { title: 'A held run' }).id;
		const held = finishedRun(db, ticket, { state: 'paused' });
		db.prepare('UPDATE runs SET halted = 1 WHERE id = ?').run(held);
		try {
			await open(page, '/');
			const row = section(page, 'projekte').getByRole('link').filter({ hasText: 'Held project' });
			await expect(row).toContainText(/(^|\s)0\s*Agents aktiv/);
		} finally {
			deleteTicket(db, HUMAN, ticket);
			db.prepare('DELETE FROM projects WHERE id = ?').run(project);
		}
	});

	test('x on a run tile asks in a sheet, y cancels the run', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		fakeModel.reply('hang');
		const ticket = seedTicket('Cancel me from the start view');
		await open(page, '/');
		await queueRun(db, page, ticket.id, fakeModel);
		const tile = tileOf(page, ticket.ref);
		await expect(tile).toHaveAttribute('data-size', '2x1');

		await tile.locator('[data-item]').focus();
		await page.keyboard.press('x');
		const sheet = page.getByRole('dialog', { name: `Run ${runIdOf(db, ticket.id)} abbrechen?` });
		await expect(sheet).toBeVisible();
		await expect(sheet).toHaveClass(/sheet/);
		await page.keyboard.press('y');
		await expect(sheet).toBeHidden();
		await expect(
			section(page, 'betrieb').getByRole('listitem').filter({ hasText: ticket.ref })
		).toContainText('abgebrochen');
	});

	test('the trace shows a running run with its phase, run time and newest steps, live', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		fakeModel.reply({ call: { name: 'no_such_tool', args: {} } }, 'hang');
		const ticket = seedTicket('Watch my trace');
		await open(page, '/');
		await queueRun(db, page, ticket.id, fakeModel);

		const track = section(page, 'spur').locator('article').filter({ hasText: ticket.ref });
		await expect(track).toContainText('läuft seit');
		await expect(track.locator('.steps li').first()).toContainText('no_such_tool');
		await expect(
			tileOf(page, ticket.ref).getByRole('img', { name: /Tokens je Minute/ })
		).toBeAttached();
		const stop = await page.request.post('/?/stop', {
			form: { runId: String(runIdOf(db, ticket.id)) },
			headers: { 'x-sveltekit-action': 'true', origin: new URL(page.url()).origin }
		});
		expect(stop.ok()).toBe(true);
	});

	const cancelRun = async (page: Page, db: DatabaseSync, ticketId: number) => {
		const stop = await page.request.post('/?/stop', {
			form: { runId: String(runIdOf(db, ticketId)) },
			headers: { 'x-sveltekit-action': 'true', origin: new URL(page.url()).origin }
		});
		expect(stop.ok()).toBe(true);
	};

	test('a run tile says the agent works while the model has not answered, never "between steps"', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		fakeModel.reply('hang');
		const ticket = seedTicket('Wait for the first chunk');
		await open(page, '/');
		await queueRun(db, page, ticket.id, fakeModel);
		await expect(phaseOf(page, ticket.ref, 'arbeitet')).toBeVisible();

		await page.reload();
		await expect(phaseOf(page, ticket.ref, 'arbeitet')).toBeVisible();
		await expect(page.locator('main')).not.toContainText('zwischen zwei Schritten');
		await cancelRun(page, db, ticket.id);
	});

	test('a streamed delta turns the phase word of the tile and the trace to "schreibt" without a reload', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		fakeModel.reply({ partial: 'Working on it' });
		const ticket = seedTicket('Stream one delta, then wait');
		await open(page, '/');
		await queueRun(db, page, ticket.id, fakeModel);

		await expect(phaseOf(page, ticket.ref, 'schreibt')).toBeVisible();
		const track = section(page, 'spur').locator('article').filter({ hasText: ticket.ref });
		await expect(track).toContainText('schreibt');
		await cancelRun(page, db, ticket.id);
	});

	test('a stored event ends the live phase: after a finished step the tile says "arbeitet" again', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		fakeModel.reply({ call: { name: 'no_such_tool', args: {} } }, 'hang');
		const ticket = seedTicket('Stream a call, then wait');
		await open(page, '/');
		await queueRun(db, page, ticket.id, fakeModel);

		await expect(
			tileOf(page, ticket.ref).locator('.stat').filter({ hasText: 'Tokens' }).locator('.value')
		).toHaveText('110');
		await expect(phaseOf(page, ticket.ref, 'arbeitet')).toBeVisible();
		await expect(phaseOf(page, ticket.ref, 'schreibt')).toHaveCount(0);
		await cancelRun(page, db, ticket.id);
	});

	test('a live phase older than an event the page missed does not outlast the reload that brings the event', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		fakeModel.reply({ partial: 'Working on it' });
		const ticket = seedTicket('Miss an event');
		await open(page, '/');
		await queueRun(db, page, ticket.id, fakeModel);
		await expect(phaseOf(page, ticket.ref, 'schreibt')).toBeVisible();

		// stored in the test process, so it never reaches the page's stream: like an event sent while the connection was down
		const runId = runIdOf(db, ticket.id);
		appendEvent(db, { kind: 'agent', runId }, runId, {
			type: 'tool_call',
			key: 'missed-call',
			payload: { step: 1, tool: 'read_file', args: {} }
		});
		// any state change reloads the tracks, as the reload after a reconnect does
		expect((await page.request.delete('/api/halt')).ok()).toBe(true);

		await expect(
			section(page, 'spur').locator('article').filter({ hasText: ticket.ref })
		).toContainText('read_file');
		await expect(phaseOf(page, ticket.ref, 'Werkzeug läuft')).toBeVisible();
		await cancelRun(page, db, ticket.id);
	});

	test('the phase word is plain text outside every live region', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		fakeModel.reply('hang');
		const ticket = seedTicket('Read my phase');
		await open(page, '/');
		await queueRun(db, page, ticket.id, fakeModel);

		const inTile = phaseOf(page, ticket.ref, 'arbeitet');
		const inTrace = section(page, 'spur')
			.locator('article')
			.filter({ hasText: ticket.ref })
			.locator('p.detail')
			.filter({ hasText: /^arbeitet · / });
		for (const word of [inTile, inTrace]) {
			await expect(word).toBeVisible();
			expect(
				await word.evaluate((el) => el.closest('[aria-live], [role="status"], [role="alert"]'))
			).toBeNull();
		}
		await cancelRun(page, db, ticket.id);
	});

	test('the token figure of a run tile is a dash before the first step and grows by each step’s usage', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		fakeModel.reply('hang');
		const waiting = seedTicket('No step finished yet');
		await open(page, '/');
		await queueRun(db, page, waiting.id, fakeModel);
		const tokens = (ref: string) =>
			tileOf(page, ref).locator('.stat').filter({ hasText: 'Tokens' }).locator('.value');
		await expect(tokens(waiting.ref)).toHaveText('–');
		await cancelRun(page, db, waiting.id);

		fakeModel.reply(
			{ call: { name: 'no_such_tool', args: {} } },
			{ call: { name: 'no_such_tool', args: {} } },
			'hang'
		);
		const working = seedTicket('Two steps finished');
		await queueRun(db, page, working.id, fakeModel);
		// the second step's usage event must have landed before the figure can read 220
		await expect
			.poll(
				() =>
					(
						db
							.prepare('SELECT tokens_in + tokens_out AS total FROM runs WHERE ticket_id = ?')
							.get(working.id) as { total: number }
					).total,
				{ timeout: 15_000 }
			)
			.toBe(220);
		await expect(tokens(working.ref)).toHaveText('220'); // 100 in and 10 out per step
		await cancelRun(page, db, working.id);
	});

	test('operations lists a waiting run with its reason and a failed one with code, way out, duration and cost', async ({
		page,
		db,
		seedTicket
	}) => {
		const failedTicket = seedTicket('A ticket whose run failed');
		const failed = finishedRun(db, failedTicket.id, {
			state: 'failed',
			error: '[provider_unreachable] Timeout talking to the model'
		});
		db.prepare(
			"INSERT INTO comments (ticket_id, author_kind, author, body, run_id) VALUES (?, 'system', 'studio', ?, ?)"
		).run(failedTicket.id, 'Run fehlgeschlagen.\nAusweg: Modellserver starten.', failed);
		const waiting = seedTicket('A ticket whose run waits');
		haltRuns(db, HUMAN);
		intoWorkStep(db, waiting.id);
		createRun(db, HUMAN, { ticketId: waiting.id, profileId: profileOnUnreachableHost(db) });
		try {
			await open(page, '/');
			const operations = section(page, 'betrieb');
			await expect(operations.getByRole('listitem').filter({ hasText: waiting.ref })).toContainText(
				'Not-Aus aktiv'
			);
			const row = operations.getByRole('listitem').filter({ hasText: failedTicket.ref });
			await expect(row).toContainText('fehlgeschlagen');
			await expect(row).toContainText('[provider_unreachable] Timeout talking to the model');
			expect((await row.textContent())!.split('[provider_unreachable]')).toHaveLength(2); // the code shows once
			await expect(row).toContainText('Ausweg: Modellserver starten.');
			await expect(row).toContainText(/\d+:\d\d · keine/);
			await expect(row.getByRole('link', { name: failedTicket.ref })).toHaveAttribute(
				'href',
				`${failedTicket.path}?run=${failed}`
			);
			await expect(tileOf(page, failedTicket.ref)).toHaveAttribute('data-size', '2x1');
		} finally {
			releaseHalt(db, HUMAN);
		}
	});
});

test('at 1920 px all four sections fit, at 2560 px the tiles take six columns and running runs a second graph', async ({
	page,
	db,
	seedTicket,
	fakeModel
}) => {
	fakeModel.reply('hang');
	const ticket = seedTicket('Run on a wide screen');
	await page.setViewportSize({ width: 1920, height: 1080 });
	await open(page, '/');
	await queueRun(db, page, ticket.id, fakeModel);
	const tile = tileOf(page, ticket.ref);
	await expect(tile).toHaveAttribute('data-size', '2x1');
	const rights = await page
		.locator('.panorama > section')
		.evaluateAll((sections) => sections.map((s) => s.getBoundingClientRect().right));
	for (const right of rights) expect(right).toBeLessThanOrEqual(1920);
	await expect(page.getByText('← → oder seitlich scrollen')).toBeHidden();
	await expect(tile.getByRole('img', { name: /Schritte je Minute/ })).toBeHidden();

	await page.setViewportSize({ width: 2560, height: 1440 });
	const columns = await page
		.locator('.tiles')
		.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' '));
	expect(columns).toEqual(Array(6).fill('170px'));
	await expect(tile.getByRole('img', { name: /Schritte je Minute/ })).toBeVisible();
	await page.request.post('/?/stop', {
		form: { runId: String(runIdOf(db, ticket.id)) },
		headers: { 'x-sveltekit-action': 'true', origin: new URL(page.url()).origin }
	});
});

test.describe('on a phone', () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test('sections stack, nothing scrolls sideways, a question tile is 2×1 without options and leads to the Run-Akte', async ({
		page,
		db,
		seedTicket,
		fakeModel
	}) => {
		const question = 'Phone question?';
		fakeModel.reply({
			call: { name: 'request_human', args: { question, options: [{ label: 'Ja' }] } }
		});
		const ticket = seedTicket('A ticket with a long error');
		finishedRun(db, ticket.id, {
			state: 'failed',
			error: `[provider_unreachable] ${'https://example.invalid/'.repeat(12)}`
		});
		await open(page, '/');
		await queueRun(db, page, ticket.id, fakeModel);
		const tile = tileOf(page, ticket.ref).filter({ hasText: question });
		await expect(tile).toBeVisible();
		await expect(tile.getByRole('button', { name: /Antwort 1/ })).toBeHidden();
		const box = (await tile.boundingBox())!;
		expect(box.height).toBeLessThan(box.width); // one row, not two
		await expect(tile.getByRole('link', { name: ticket.ref })).toHaveAttribute(
			'href',
			new RegExp(`${ticket.path}\\?run=`)
		);

		const tops = await page
			.locator('.panorama > section')
			.evaluateAll((sections) => sections.map((s) => s.getBoundingClientRect().top));
		expect(tops).toEqual([...tops].sort((a, b) => a - b));
		expect(await sidewaysScrollers(page)).toEqual([]);
	});
});

test('with reduced motion no animation runs on the start view', async ({
	page,
	db,
	seedTicket
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const ticket = seedTicket('A failed run tile');
	finishedRun(db, ticket.id, { state: 'failed', error: 'boom' });
	await open(page, '/');
	await expect(tileOf(page, ticket.ref)).toBeVisible();
	expect(
		await page.evaluate(
			() =>
				document.getAnimations().filter((animation) => animation.playState !== 'finished').length
		)
	).toBe(0);
});

test('signing out moved to the settings and still works', async ({ page }) => {
	await open(page, '/settings');
	await expect(page.getByText(/Angemeldet als /)).toBeVisible();
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Abmelden' })).toHaveCount(0);
});
