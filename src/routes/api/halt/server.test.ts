// The kill switch route against a real DB file and the runner the server started, as the init hook starts it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import { haltedSince } from '$lib/server/domain/halt';
import * as runs from '$lib/server/domain/runs';
import { startRunner, type Executor } from '$lib/server/runner';
import { DELETE, POST } from './+server';

const tmp = mkdtempSync(join(tmpdir(), 'studio-halt-'));
process.env.STUDIO_DATA_DIR = tmp; // db() reads the directory on its first call
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const user: Actor = { kind: 'user' };
const untilAborted: Executor = {
	execute: (_run, io) =>
		new Promise((_done, fail) => io.signal.addEventListener('abort', () => fail(io.signal.reason)))
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

it('halts every run on POST and lets the queue go on DELETE, through the runner the server started', async () => {
	const runner = startRunner(db(), { builtin: untilAborted });
	const projectId = board.createProject(db(), user, { key: 'STU', name: 'Studio' }).id;
	const ticketId = board.createTicket(db(), user, projectId, { title: 'T' }).id;
	const profileId = runs.createProfile(db(), user, {
		name: 'qwen',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const [running, waiting] = [1, 2].map(
		() => runs.createRun(db(), user, { ticketId, profileId }).id
	);
	const state = (id: number) => db().prepare('SELECT state FROM runs WHERE id = ?').get(id)!.state;
	await flush();

	const halted = await POST({} as never);
	expect(await halted.json()).toEqual({ cancelled: 1 });
	expect([running, waiting].map(state)).toEqual(['cancelled', 'queued']);

	const released = await DELETE({} as never);
	expect(released.status).toBe(204);
	await flush();
	expect(state(waiting)).toBe('running');
	expect(haltedSince(db())).toBeNull();
	runner.stop();
});
