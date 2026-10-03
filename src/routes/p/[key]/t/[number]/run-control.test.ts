import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { RunStart, RunTab } from '$lib/runs/run-control';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import {
	createProfile,
	createRun,
	finishRun,
	startRun,
	type Profile
} from '$lib/server/domain/runs';
import { subscribe } from '$lib/server/events';
import { builtinExecutor } from '$lib/server/executors/builtin';
import { startRunner, type Executor } from '$lib/server/runner';
import { reloadsTicket } from '$lib/ticket-live';
import type { RunTrace } from '$lib/trace/trace';
import { actions, load } from './+page.server';

// A real (file-backed) STUDIO_DATA_DIR of its own: db() is a process-wide singleton and the runner claims every queued run.
const dir = mkdtempSync(join(tmpdir(), 'studio-run-control-'));
process.env.STUDIO_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const user: Actor = { kind: 'user' };
const projectId = board.createProject(db(), user, { key: 'RUN', name: 'Runs' }).id;
const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

let profileCount = 0;
/** A profile in a pool of its own, so the runs of earlier tests never fill it. */
function newProfile(fields: Partial<Profile> = {}) {
	profileCount += 1;
	return createProfile(db(), user, {
		name: `Profil ${profileCount}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm',
		pool: `pool-${profileCount}`,
		...fields
	}).id;
}

const newTicket = () => board.createTicket(db(), user, projectId, { title: 'Export bauen' });
const params = (number: number) => ({ key: 'RUN', number: String(number) });
const urlOf = (number: number) => new URL(`http://localhost/p/RUN/t/${number}`);

async function post(action: 'start' | 'stop', number: number, fields: Record<string, string>) {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, value);
	const request = new Request(urlOf(number), { method: 'POST', body });
	return actions[action]({ request, params: params(number), url: urlOf(number) } as never);
}

type Shown = { runs: RunTab[]; start: RunStart; trace?: RunTrace };
/** What a tab of the Run-Akte loads, on its first visit and on every live reload. */
const shown = (number: number): Shown =>
	load({ params: params(number), url: urlOf(number), depends: () => {} } as never) as never;

const priorityOf = (runId: number) =>
	db().prepare('SELECT priority FROM runs WHERE id = ?').get(runId)!.priority;

async function settled(done: () => boolean) {
	while (!done()) await new Promise((resolve) => setImmediate(resolve));
}

/** An OpenAI-compatible model server that answers every request with `text`, then stops. */
function fakeModel(text: string, [input, output]: [number, number]): typeof fetch {
	const chunk = (fields: object) =>
		`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', ...fields })}\n\n`;
	const body = [
		chunk({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
		chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
		chunk({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } }),
		'data: [DONE]\n\n'
	].join('');
	return async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('start', () => {
	it('queues a run with the preselected profile at human priority and says why it waits', async () => {
		const { id, number } = newTicket();
		const profileId = newProfile();
		const busy = createRun(db(), user, { ticketId: id, profileId }).id;
		startRun(db(), user, busy);
		const { start } = shown(number);
		expect(start.preselected).toBe(profileId);

		await expect(
			post('start', number, { profileId: String(start.preselected) })
		).rejects.toMatchObject({ status: 303, location: `/p/RUN/t/${number}` });

		const [started] = shown(number).runs;
		expect(started).toMatchObject({ state: 'queued', profile: `Profil ${profileCount}` });
		expect(priorityOf(started.id)).toBe('human');
		expect(started.waitText).toBe(`wartet: Pool „pool-${profileCount}“ ist voll (1 von 1 aktiv).`);
	});

	it('refuses an unknown profile with message and hint at the start form, and queues nothing', async () => {
		const { number } = newTicket();
		const result = await post('start', number, { profileId: '4711' });
		expect(result).toMatchObject({
			status: 400,
			data: {
				action: 'start',
				code: 'not_found',
				message: expect.any(String),
				hint: expect.any(String)
			}
		});
		expect(shown(number).runs).toEqual([]);
	});
});

describe('stop', () => {
	it('cancels a waiting and a running run through the runner, which aborts the executor', async () => {
		const signals = new Map<number, AbortSignal>();
		const hold: Executor['execute'] = (run, io) => {
			signals.set(run.id, io.signal);
			return new Promise((resolve) => io.signal.addEventListener('abort', () => resolve()));
		};
		stops.push(startRunner(db(), { builtin: { execute: hold } }).stop);
		const { id, number } = newTicket();
		const profileId = newProfile();
		const running = createRun(db(), user, { ticketId: id, profileId }).id;
		await settled(() => signals.has(running));
		const waiting = createRun(db(), user, { ticketId: id, profileId }).id;

		expect(await post('stop', number, { runId: String(waiting) })).toBeUndefined();
		expect(await post('stop', number, { runId: String(running) })).toBeUndefined();

		const states = Object.fromEntries(shown(number).runs.map((tab) => [tab.id, tab.state]));
		expect(states).toEqual({ [running]: 'cancelled', [waiting]: 'cancelled' });
		expect(signals.get(running)?.aborted).toBe(true);
		expect(signals.has(waiting)).toBe(false);
	});

	it('refuses an ended run with message and hint at the stop form', async () => {
		stops.push(startRunner(db(), {}).stop);
		const { id, number } = newTicket();
		const runId = createRun(db(), user, { ticketId: id, profileId: newProfile() }).id;
		finishRun(db(), user, runId, { state: 'cancelled' });
		expect(await post('stop', number, { runId: String(runId) })).toMatchObject({
			status: 400,
			data: {
				action: 'stop',
				code: 'invalid_run_transition',
				message: expect.stringContaining(`Run ${runId}`),
				hint: expect.any(String)
			}
		});
	});

	it('404s for a run of another ticket instead of stopping it', async () => {
		stops.push(startRunner(db(), {}).stop);
		const other = newTicket();
		const { number } = newTicket();
		const profileId = newProfile();
		const foreign = createRun(db(), user, {
			ticketId: other.id,
			profileId,
			notBefore: '2999-01-01T00:00:00Z'
		}).id;
		await expect(post('stop', number, { runId: String(foreign) })).rejects.toMatchObject({
			status: 404,
			body: { message: `Run ${foreign} gehört nicht zu diesem Ticket.` }
		});
		expect(shown(other.number).runs[0].state).toBe('queued');
	});
});

describe('live', () => {
	it('lets a second tab follow every state change with the sums the event carries', async () => {
		const fetch = fakeModel('Fertig.', [120, 8]);
		stops.push(startRunner(db(), { builtin: builtinExecutor(db(), { fetch }) }).stop);
		const { id, number } = newTicket();
		const profileId = newProfile({ base_url: 'http://model.test/v1' });
		type Change = {
			type: string;
			runId: number;
			to?: string;
			tokensIn?: number;
			tokensOut?: number;
			cost?: number;
		};
		const followed: { event: Change; tab?: RunTab }[] = [];
		const off = subscribe((event) => {
			// the second tab reloads on exactly the events reloadsTicket names, and loads again
			if (!reloadsTicket(event, id) || !('runId' in event)) return;
			const change = event as unknown as Change;
			followed.push({
				event: change,
				tab: shown(number).runs.find((tab) => tab.id === change.runId)
			});
		});
		stops.push(off);

		await post('start', number, { profileId: String(profileId) }).catch(() => {});
		await settled(() => followed.some(({ tab }) => tab?.state === 'succeeded'));

		const changes = followed.filter(({ event }) => event.type === 'run.state_changed');
		expect(changes.map(({ tab }) => tab?.state)).toEqual(['running', 'succeeded']);
		for (const { event, tab } of changes)
			expect(tab).toMatchObject({
				state: event.to,
				tokensIn: event.tokensIn,
				tokensOut: event.tokensOut,
				cost: event.cost
			});
		expect(followed[0]).toMatchObject({ event: { type: 'run.created' }, tab: { state: 'queued' } });
	});
});

describe('end to end', () => {
	it('starts a run from the Run-Akte that the builtin executor works to the end, and the tab shows the result', async () => {
		const fetch = fakeModel('Export gebaut.', [1500, 42]);
		stops.push(startRunner(db(), { builtin: builtinExecutor(db(), { fetch }) }).stop);
		const states: string[] = [];
		stops.push(subscribe((e) => e.type === 'run.state_changed' && states.push(e.to as string)));
		const { number } = newTicket();
		const profileId = newProfile({ base_url: 'http://model.test/v1' });

		await post('start', number, { profileId: String(profileId) }).catch(() => {});
		await settled(() => shown(number).runs[0]?.state === 'succeeded');

		const { runs, trace } = shown(number);
		expect(states).toEqual(['running', 'succeeded']);
		expect(runs[0]).toMatchObject({
			profile: `Profil ${profileCount}`,
			tokensIn: 1500,
			tokensOut: 42,
			cost: 0
		});
		expect(runs[0].finishedAt).not.toBeNull();
		expect(trace?.id).toBe(runs[0].id);
		expect(trace?.events).toContainEqual(
			expect.objectContaining({ key: 'handoff', payload: { text: 'Export gebaut.' } })
		);
	});
});
