import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import { DomainError, type Actor } from './domain/core';
import * as runs from './domain/runs';
import { startRunner, type Executor, type RunContext } from './runner';
import { setSecret } from './secrets';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };
const tmp = mkdtempSync(join(tmpdir(), 'studio-runner-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function setup(db = openDb(':memory:')) {
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const ticketId = board.createTicket(db, user, projectId, { title: 'T' }).id;
	const local = runs.createProfile(db, user, { name: 'Local', executor: 'builtin', provider: 'openai-compatible', model: 'm' }).id;
	const cloud = runs.createProfile(db, user, { name: 'Cloud', executor: 'builtin', provider: 'anthropic', model: 'm', pool: 'cloud' }).id;
	const queue = (profileId: number, ticket = ticketId) => runs.createRun(db, user, { ticketId: ticket, profileId }).id;
	const row = (id: number) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id)!;
	const state = (id: number) => row(id).state;
	const comments = () => db.prepare('SELECT author_kind, run_id, body FROM comments ORDER BY id').all();
	return { db, projectId, ticketId, local, cloud, queue, row, state, comments };
}

type ExecutorResult = Awaited<ReturnType<Executor['execute']>>;
type ExecutorCall = { run: RunContext; io: Parameters<Executor['execute']>[1]; done: (result?: ExecutorResult) => void; fail: (err: unknown) => void };

/** An executor whose runs the test ends itself; like a real executor it gives up when the signal fires. */
function fakeExecutor() {
	const calls: ExecutorCall[] = [];
	const executor: Executor = {
		execute: (run, io) =>
			new Promise((done, fail) => {
				io.signal.addEventListener('abort', () => fail(new Error('aborted')));
				calls.push({ run, io, done, fail });
			})
	};
	const call = (runId: number) => calls.find((c) => c.run.id === runId)!;
	return { executor, calls, call };
}

/** Lets the runner's microtask wake-ups and settled executor promises run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const stopRunners: (() => void)[] = [];
afterEach(() => {
	stopRunners.splice(0).forEach((stop) => stop());
	vi.restoreAllMocks();
});
function start(...args: Parameters<typeof startRunner>) {
	const runner = startRunner(...args);
	stopRunners.push(runner.stop);
	return runner;
}

/** Runs `claimRun` in a loop in `count` separate Node processes that all start at the same moment; returns the ids each claimed. */
async function claimInParallelProcesses(file: string, limits: runs.Limits, count: number): Promise<number[][]> {
	const startAt = Date.now() + 1500;
	// Without Vite: the resolve hook adds the missing .ts extensions, transform-types handles DomainError's parameter properties.
	const script = `
		import { registerHooks } from 'node:module';
		registerHooks({ resolve: (spec, ctx, next) => { try { return next(spec, ctx); } catch (e) { if (spec.startsWith('.')) return next(spec + '.ts', ctx); throw e; } } });
		const { openDb } = await import(${JSON.stringify(resolve('src/lib/server/db.ts'))});
		const runs = await import(${JSON.stringify(resolve('src/lib/server/domain/runs.ts'))});
		const db = openDb(${JSON.stringify(file)});
		const sleep = new Int32Array(new SharedArrayBuffer(4));
		while (Date.now() < ${startAt});
		const claimed = [];
		// the 1 ms pause mimics a runner between wake-ups; without it the faster process takes every run
		for (let run; (run = runs.claimRun(db, { kind: 'system' }, ${JSON.stringify(limits)})); Atomics.wait(sleep, 0, 0, 1)) claimed.push(run.id);
		console.log(JSON.stringify(claimed));`;
	const children = Array.from({ length: count }, () =>
		spawn(process.execPath, ['--input-type=module', '--experimental-transform-types', '--no-warnings', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
	);
	try {
		return await Promise.all(
			children.map(
				(child) =>
					new Promise<number[]>((done, fail) => {
						let output = '';
						child.stdout!.on('data', (chunk) => (output += chunk));
						child.on('exit', (code) => (code === 0 ? done(JSON.parse(output)) : fail(new Error(`child process exited with ${code}`))));
					})
			)
		);
	} finally {
		children.forEach((child) => child.exitCode === null && child.kill('SIGKILL'));
	}
}

describe('claimRun', () => {
	it('gives a queued run to exactly one of two connections, and a waiting run keeps its pool slot', () => {
		const file = join(tmp, 'claim.db');
		const { db, local, queue, row } = setup(openDb(file));
		const other = openDb(file);
		const [first, second] = [queue(local), queue(local)];
		const limits = { global: 5, pools: {} }; // pool "local" has no entry, so its limit is 1

		const claimed = runs.claimRun(db, system, limits);
		expect(claimed).toMatchObject({ id: first, profile: { name: 'Local', pool: 'local' } });
		expect(runs.claimRun(other, system, limits)).toBeUndefined();
		expect(row(first)).toMatchObject({ state: 'running' });
		expect(runs.runForToken(db, claimed!.token)?.runId).toBe(first);

		runs.setRunState(db, system, first, 'waiting_approval');
		expect(runs.claimRun(other, system, limits)).toBeUndefined();
		runs.finishRun(db, system, first, { state: 'cancelled' });
		expect(runs.claimRun(other, system, limits)?.id).toBe(second);
	});

	it('claims every run exactly once from two parallel processes, oldest first and within the pool limits', async () => {
		const file = join(tmp, 'parallel.db');
		const { db, local, cloud, queue } = setup(openDb(file));
		for (let i = 0; i < 200; i++) queue(i % 7 ? cloud : local); // 171 cloud runs, 29 local runs

		const perProcess = await claimInParallelProcesses(file, { global: 1000, pools: { cloud: 1000, local: 3 } }, 2);

		const claimed = perProcess.flat().sort((a, b) => a - b);
		expect(new Set(claimed).size).toBe(claimed.length);
		const runningIn = (pool: string) =>
			db.prepare("SELECT r.id FROM runs r JOIN agent_profiles p ON p.id = r.agent_profile_id WHERE r.state = 'running' AND p.pool = ? ORDER BY r.id").all(pool).map((r) => r.id as number);
		expect(runningIn('local')).toEqual([1, 8, 15]);
		expect(runningIn('cloud')).toHaveLength(171);
		expect(claimed).toEqual([...runningIn('local'), ...runningIn('cloud')].sort((a, b) => a - b));
		expect(perProcess.every((ids) => ids.length > 0)).toBe(true);
	});
});

describe('startRunner', () => {
	it('holds back runs of a full pool, starts runs of other pools, respects the global limit and claims in FIFO order once a slot frees up', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor }, { global: 2, pools: { local: 1, cloud: 2 } });
		const [local1, local2, cloud1, cloud2] = [s.queue(s.local), s.queue(s.local), s.queue(s.cloud), s.queue(s.cloud)];
		await flush();
		// local2 waits for its pool, cloud2 for the global limit although the cloud pool has room
		expect([local1, local2, cloud1, cloud2].map(s.state)).toEqual(['running', 'queued', 'running', 'queued']);
		expect(runs.runForToken(s.db, fake.call(local1).run.token)?.runId).toBe(local1);

		fake.call(local1).done({ usage: { tokensIn: 7, tokensOut: 3 } });
		await flush();
		expect([local1, local2, cloud1, cloud2].map(s.state)).toEqual(['succeeded', 'running', 'running', 'queued']);
		expect(s.row(local1)).toMatchObject({ tokens_in: 7, tokens_out: 3 });
		expect(runs.runForToken(s.db, fake.call(local1).run.token)).toBeUndefined();

		fake.call(cloud1).done({ state: 'paused' });
		await flush();
		expect([local1, local2, cloud1, cloud2].map(s.state)).toEqual(['succeeded', 'running', 'paused', 'running']);
		expect(fake.calls.map((c) => c.run.id)).toEqual([local1, cloud1, local2, cloud2]);
	});

	it('cancels a run: state cancelled, token revoked, executor signalled, and the executor ending late changes nothing', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const consoleError = vi.spyOn(console, 'error');
		const [cancelled, waiting] = [s.queue(s.local), s.queue(s.local)];
		await flush();
		const { run, io } = fake.call(cancelled);
		expect(io.emit({ type: 'log', payload: { msg: 'working' } })).toEqual({ seq: 1, duplicate: false });

		runner.cancel(cancelled);
		expect(s.row(cancelled)).toMatchObject({ state: 'cancelled', token_hash: null });
		expect(runs.runForToken(s.db, run.token)).toBeUndefined();
		expect(io.signal.aborted).toBe(true);
		expect(() => io.emit({ type: 'log' })).toThrow(expect.objectContaining({ code: 'run_not_active' }));
		await flush();
		expect(s.state(cancelled)).toBe('cancelled');
		expect(s.comments()).toEqual([]);
		expect(consoleError).not.toHaveBeenCalled();
		expect(s.state(waiting)).toBe('running');

		const queued = s.queue(s.local);
		runner.cancel(queued);
		expect(s.state(queued)).toBe('cancelled');
		expect(() => runner.cancel(cancelled)).toThrow(expect.objectContaining({ code: 'invalid_run_transition' }));
	});

	it('fails runs left active by a server restart with a system comment, then keeps working the queue', async () => {
		const s = setup();
		const [running, waiting] = [s.queue(s.local), s.queue(s.cloud)];
		runs.startRun(s.db, system, running);
		runs.startRun(s.db, system, waiting);
		runs.setRunState(s.db, system, waiting, 'waiting_approval');
		const queued = s.queue(s.local);
		const fake = fakeExecutor();

		start(s.db, { builtin: fake.executor });

		for (const id of [running, waiting]) {
			expect(s.row(id)).toMatchObject({ state: 'failed', token_hash: null });
			expect(s.row(id).error).toBe('[server_restart] Server-Neustart — der Run lief noch, als Studio beendet wurde.');
		}
		expect(s.comments()).toEqual(
			[running, waiting].map((id) => ({ author_kind: 'system', run_id: id, body: expect.stringContaining(`Run ${id} ist fehlgeschlagen: [server_restart] Server-Neustart`) }))
		);
		expect(s.state(queued)).toBe('running');
		expect(fake.calls.map((c) => c.run.id)).toEqual([queued]);
	});

	it('fails a run whose executor throws, with a masked system comment naming run, stable code and way out', async () => {
		const s = setup();
		const secret = 'sk-runner-test-secret-4711';
		setSecret(s.db, 'runner-test', secret, false, randomBytes(32));
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor }, { global: 5, pools: { local: 5 } });
		const [crashed, ruleBroken] = [s.queue(s.local), s.queue(s.local)];
		await flush();

		fake.call(crashed).fail(new Error(`provider answered 401 for ${secret}`));
		fake.call(ruleBroken).fail(new DomainError('max_steps', 'Schrittlimit 40 erreicht.', 'max_steps im Profil erhöhen oder das Ticket teilen.'));
		await flush();

		expect(s.row(crashed)).toMatchObject({ state: 'failed', token_hash: null, error: '[executor_error] provider answered 401 for [secret:runner-test]' });
		expect(s.row(ruleBroken)).toMatchObject({ state: 'failed', error: '[max_steps] Schrittlimit 40 erreicht.' });
		expect(s.comments()).toEqual([
			{
				author_kind: 'system',
				run_id: crashed,
				body: `Run ${crashed} ist fehlgeschlagen: [executor_error] provider answered 401 for [secret:runner-test]\nAusweg: Run-Log prüfen, Ursache beheben und einen neuen Run starten.`
			},
			{ author_kind: 'system', run_id: ruleBroken, body: `Run ${ruleBroken} ist fehlgeschlagen: [max_steps] Schrittlimit 40 erreicht.\nAusweg: max_steps im Profil erhöhen oder das Ticket teilen.` }
		]);
	});

	it('fails a run with executor_unavailable instead of leaving it queued when no executor handles its profile', async () => {
		const s = setup();
		const acp = runs.createProfile(s.db, user, { name: 'ACP', executor: 'acp', command: 'agent' }).id;
		start(s.db, {});
		const id = s.queue(acp);
		await flush();
		expect(s.row(id).error).toBe('[executor_unavailable] Für „acp“-Profile ist noch kein Executor eingebaut.');
		expect(s.comments()).toHaveLength(1);
	});
});
