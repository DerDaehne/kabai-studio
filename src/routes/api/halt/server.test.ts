// The halt routes against a real DB file and the runner the server started, as the init hook starts it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import { DomainError } from '$lib/server/domain/error';
import * as halt from '$lib/server/domain/halt';
import { haltedSince } from '$lib/server/domain/halt';
import * as runs from '$lib/server/domain/runs';
import type { Executor } from '$lib/server/executors/contract';
import { startRunner } from '$lib/server/runner';
import { POST as pauseAll } from '../pause/+server';
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
const projectId = board.createProject(db(), user, { key: 'STU', name: 'Studio' }).id;
let profiles = 0;
const stops: (() => void)[] = [];

beforeEach(() => {
	stops.push(startRunner(db(), { builtin: untilAborted }).stop);
});

afterEach(async () => {
	stops.splice(0).forEach((stop) => stop());
	await flush();
	db().exec('DELETE FROM runs; DELETE FROM runner_halt'); // what a test leaves behind must not reach the next one
});

/** Two runs of a fresh profile in a pool of its own, one per ticket: the first runs, the second waits. */
async function runningAndWaiting() {
	const newTicket = () =>
		board.createTicket(db(), user, projectId, {
			title: 'T',
			column_id: board.columns(db(), projectId).find((c) => c.step === 'implement')!.id
		}).id;
	profiles += 1;
	const profileId = runs.createProfile(db(), user, {
		name: `qwen ${profiles}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm',
		pool: `pool-${profiles}`
	}).id;
	const [running, waiting] = [1, 2].map(
		() => runs.createRun(db(), user, { ticketId: newTicket(), profileId }).id
	);
	await flush();
	return { running, waiting };
}

const state = (id: number) => db().prepare('SELECT state FROM runs WHERE id = ?').get(id)!.state;
const continuationOf = (id: number) =>
	db().prepare('SELECT id FROM runs WHERE resumed_from_run_id = ?').get(id)?.id as number;

it('stops every run on POST and lets the queue go on DELETE, through the runner the server started', async () => {
	const { running, waiting } = await runningAndWaiting();

	const halted = await POST({} as never);
	expect(await halted.json()).toEqual({ cancelled: 1 });
	expect([running, waiting].map(state)).toEqual(['cancelled', 'queued']);

	const released = await DELETE({} as never);
	expect(await released.json()).toEqual({ resumed: 0, released: 'stop', skipped: [] });
	await flush();
	expect(state(waiting)).toBe('running');
	expect(haltedSince(db())).toBeNull();
});

it('pauses every run on POST /api/pause, and DELETE resumes it ahead of the waiting run and lifts the pause', async () => {
	const { running, waiting } = await runningAndWaiting();

	const paused = await pauseAll({} as never);
	expect(await paused.json()).toEqual({ paused: 1 });
	expect([running, waiting].map(state)).toEqual(['paused', 'queued']);

	const released = await DELETE({} as never);
	expect(await released.json()).toEqual({ resumed: 1, released: 'pause', skipped: [] });
	await flush();
	expect([continuationOf(running), waiting].map(state)).toEqual(['running', 'queued']);
	expect(haltedSince(db())).toBeNull();
});

it('maps a DomainError that resumeAll itself did not turn into a skipped run to 400 with code, message and hint, instead of a 500', async () => {
	const refusal = new DomainError(
		'requires_human',
		'Angehaltene Runs setzt nur der Mensch fort.',
		'x'
	);
	const resumeAll = vi.spyOn(halt, 'resumeAll').mockImplementationOnce(() => {
		throw refusal;
	});

	try {
		const response = await DELETE({} as never);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			code: 'requires_human',
			message: 'Angehaltene Runs setzt nur der Mensch fort.',
			hint: 'x'
		});
	} finally {
		resumeAll.mockRestore();
	}
});

it('maps a DomainError from POST /api/halt (the kill switch) to 400 with code, message and hint, instead of a 500', async () => {
	const refusal = new DomainError('requires_human', 'Den Not-Aus setzt nur der Mensch.', 'x');
	const haltRuns = vi.spyOn(halt, 'haltRuns').mockImplementationOnce(() => {
		throw refusal;
	});

	try {
		const response = await POST({} as never);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			code: 'requires_human',
			message: 'Den Not-Aus setzt nur der Mensch.',
			hint: 'x'
		});
	} finally {
		haltRuns.mockRestore();
	}
});

it('maps a DomainError from POST /api/pause to 400 with code, message and hint, instead of a 500', async () => {
	const refusal = new DomainError('requires_human', 'Runs hält nur der Mensch an.', 'x');
	const pauseRuns = vi.spyOn(halt, 'pauseRuns').mockImplementationOnce(() => {
		throw refusal;
	});

	try {
		const response = await pauseAll({} as never);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			code: 'requires_human',
			message: 'Runs hält nur der Mensch an.',
			hint: 'x'
		});
	} finally {
		pauseRuns.mockRestore();
	}
});
