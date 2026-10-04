// Pausing and resuming one run by its number, as `:anhalten` in the Run-Akte and `:fortsetzen N` anywhere do it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import * as runs from '$lib/server/domain/runs';
import { startRunner, type Executor } from '$lib/server/runner';
import { POST } from './+server';

const tmp = mkdtempSync(join(tmpdir(), 'studio-run-action-'));
process.env.STUDIO_DATA_DIR = tmp; // db() reads the directory on its first call
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const user: Actor = { kind: 'user' };
const untilAborted: Executor = {
	execute: (_run, io) =>
		new Promise((_done, fail) => io.signal.addEventListener('abort', () => fail(io.signal.reason)))
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const runner = startRunner(db(), { builtin: untilAborted });
afterAll(() => runner.stop());

const projectId = board.createProject(db(), user, { key: 'STU', name: 'Studio' }).id;
const ticketId = board.createTicket(db(), user, projectId, { title: 'T' }).id;
const profileId = runs.createProfile(db(), user, {
	name: 'qwen',
	executor: 'builtin',
	provider: 'openai-compatible',
	model: 'm'
}).id;

const post = (id: number | string, action: string) =>
	POST({ params: { id: String(id), action } } as never) as Promise<Response>;
const row = (id: number) =>
	db().prepare('SELECT state, halted, resume_reason FROM runs WHERE id = ?').get(id);

it('pauses a running run and resumes it by its number in a continuation run', async () => {
	const running = runs.createRun(db(), user, { ticketId, profileId }).id;
	await flush();

	const paused = await post(running, 'pause');
	expect(await paused.json()).toEqual({ paused: 1 });
	expect(row(running)).toEqual({ state: 'paused', halted: 1, resume_reason: null });

	const resumed = await post(running, 'resume');
	expect(await resumed.json()).toEqual({ resumed: 1 });
	await flush();
	const continuation = db()
		.prepare('SELECT id FROM runs WHERE resumed_from_run_id = ?')
		.get(running)!.id as number;
	expect(row(continuation)).toEqual({ state: 'running', halted: 0, resume_reason: 'halt' });
	runner.cancel(continuation);
});

it('answers a run that cannot be paused or resumed with its message and way out as JSON, and an unknown action or number with 404', async () => {
	const refused = await post(999, 'resume');
	expect(refused.status).toBe(400);
	expect(await refused.json()).toEqual({
		code: 'not_found',
		message: 'Run 999 gibt es nicht.',
		hint: ':fortsetzen zeigt die angehaltenen Runs; :fortsetzen all setzt alle fort.'
	});
	const queued = runs.createRun(db(), user, { ticketId, profileId: profileId }).id;
	runner.cancel(queued);
	expect(await (await post(queued, 'pause')).json()).toMatchObject({ code: 'run_not_active' });

	for (const [id, action] of [
		[1, 'restart'],
		['x', 'resume']
	] as const)
		expect(() => post(id, action)).toThrow(expect.objectContaining({ status: 404 }));
});
