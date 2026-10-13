import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import { DomainError, type Actor } from './domain/core';
import * as runs from './domain/runs';
import { subscribe, type StudioEvent } from './events';
import { answerQuestion, requestHuman } from './domain/questions';
import {
	haltedSince,
	haltKind,
	haltRuns,
	pauseRun,
	pauseRuns,
	releaseHalt,
	resumeAll,
	resumeRun
} from './domain/halt';
import { acceptTicket, startTicket } from './domain/intents';
import { finishStep } from './domain/steps';
import { ticketLagen } from './lagen';
import type { Step } from './domain/variants';
import { LIMITS, startRunner, type Executor, type Resume, type RunContext } from './runner';
import { setSecret } from './secrets';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };
const tmp = mkdtempSync(join(tmpdir(), 'studio-runner-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function setup(db = openDb(':memory:')) {
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const newTicket = () =>
		board.createTicket(db, user, projectId, {
			title: 'T',
			column_id: board.columns(db, projectId).find((c) => c.step === 'implement')!.id
		}).id;
	const ticketId = newTicket();
	const local = runs.createProfile(db, user, {
		name: 'Local',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const cloud = runs.createProfile(db, user, {
		name: 'Cloud',
		executor: 'builtin',
		provider: 'anthropic',
		model: 'm',
		pool: 'cloud'
	}).id;
	const queue = (profileId: number, ticket = ticketId) =>
		runs.createRun(db, user, { ticketId: ticket, profileId }).id;
	const row = (id: number) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id)!;
	const state = (id: number) => row(id).state;
	const comments = () =>
		db.prepare('SELECT author_kind, run_id, body FROM comments ORDER BY id').all();
	return { db, projectId, ticketId, newTicket, local, cloud, queue, row, state, comments };
}

type ExecutorResult = Awaited<ReturnType<Executor['execute']>>;
type ExecutorCall = {
	run: RunContext;
	io: Parameters<Executor['execute']>[1];
	done: (result?: ExecutorResult) => void;
	fail: (err: unknown) => void;
};

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
	vi.useRealTimers();
});
function start(...args: Parameters<typeof startRunner>) {
	const runner = startRunner(...args);
	stopRunners.push(runner.stop);
	return runner;
}

/**
 * Alternates `claimRun` across `connections`, one commit at a time, until none of them can claim anything. Proves
 * that a claim is visible to the next connection at once and that order and limits hold across connections — not
 * that two overlapping claims are safe, since turns never overlap (see the interleaved probes below for that).
 */
function claimRoundRobin(
	connections: ReturnType<typeof openDb>[],
	limits: runs.Limits
): number[][] {
	const claimedBy = connections.map(() => [] as number[]);
	for (let turn = 0; ; turn = (turn + 1) % connections.length) {
		const claimed = runs.claimRun(connections[turn], system, limits);
		if (!claimed) return claimedBy;
		claimedBy[turn].push(claimed.id);
	}
}

/** A second connection that never waits for the write lock: a claim it cannot take right now just does not happen. */
function rivalClaimer(file: string, limits: runs.Limits) {
	const rival = openDb(file);
	rival.exec('PRAGMA busy_timeout = 0');
	const claimed: number[] = [];
	const tryClaim = () => {
		try {
			const run = runs.claimRun(rival, system, limits);
			if (run) claimed.push(run.id);
		} catch (err) {
			if ((err as { errcode?: number }).errcode !== 5) throw err;
		}
	};
	return { claimed, tryClaim };
}

/** `db`, but `between` runs before every statement it prepares or executes — a rival at every possible point. */
function interleaved(
	db: ReturnType<typeof openDb>,
	between: () => void
): ReturnType<typeof openDb> {
	return new Proxy(db, {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (typeof value !== 'function') return value;
			if (prop !== 'exec' && prop !== 'prepare') return value.bind(target);
			return (sql: string) => {
				between();
				return value.call(target, sql);
			};
		}
	});
}

const runningIds = (db: ReturnType<typeof openDb>) =>
	db
		.prepare("SELECT id FROM runs WHERE state = 'running' ORDER BY id")
		.all()
		.map((r) => r.id as number);

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

	it('claims every run exactly once across two connections, oldest first and within the pool limits', () => {
		const file = join(tmp, 'parallel.db');
		const { db, local, cloud, queue } = setup(openDb(file));
		const other = openDb(file);
		for (let i = 0; i < 50; i++) queue(i % 7 ? cloud : local); // 42 cloud runs, 8 local runs

		const limits = { global: 1000, pools: { cloud: 1000, local: 3 } };
		const claimedBy = claimRoundRobin([db, other], limits);

		const claimed = claimedBy.flat().sort((a, b) => a - b);
		expect(new Set(claimed).size).toBe(claimed.length);
		const runningIn = (pool: string) =>
			db
				.prepare(
					"SELECT r.id FROM runs r JOIN agent_profiles p ON p.id = r.agent_profile_id WHERE r.state = 'running' AND p.pool = ? ORDER BY r.id"
				)
				.all(pool)
				.map((r) => r.id as number);
		expect(runningIn('local')).toEqual([1, 8, 15]);
		expect(runningIn('cloud')).toHaveLength(42);
		expect(claimed).toEqual([...runningIn('local'), ...runningIn('cloud')].sort((a, b) => a - b));
		expect(claimedBy.every((ids) => ids.length > 0)).toBe(true);
	});

	it('claims every run exactly once, whichever statement of the claim another connection claims between', () => {
		const file = join(tmp, 'claim-interleaved.db');
		const { db, cloud, queue } = setup(openDb(file));
		for (let i = 0; i < 50; i++) queue(cloud);
		const limits = { global: 1000, pools: { cloud: 1000 } };
		const rival = rivalClaimer(file, limits);

		const ours = runs.claimRun(interleaved(db, rival.tryClaim), system, limits);

		const claimed = [ours!.id, ...rival.claimed];
		expect(new Set(claimed).size).toBe(claimed.length);
		expect(runningIds(db)).toEqual([...claimed].sort((a, b) => a - b));
	});
});

describe('startRunner', () => {
	it('holds back runs of a full pool, starts runs of other pools, respects the global limit and claims in FIFO order once a slot frees up', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor }, { global: 2, pools: { local: 1, cloud: 2 } });
		const [local1, local2, cloud1, cloud2] = [
			s.queue(s.local),
			s.queue(s.local),
			s.queue(s.cloud),
			s.queue(s.cloud)
		];
		await flush();
		// local2 waits for its pool, cloud2 for the global limit although the cloud pool has room
		expect([local1, local2, cloud1, cloud2].map(s.state)).toEqual([
			'running',
			'queued',
			'running',
			'queued'
		]);
		expect(runs.runForToken(s.db, fake.call(local1).run.token)?.runId).toBe(local1);

		fake.call(local1).done({ usage: { tokensIn: 7, tokensOut: 3 } });
		await flush();
		expect([local1, local2, cloud1, cloud2].map(s.state)).toEqual([
			'succeeded',
			'running',
			'running',
			'queued'
		]);
		expect(s.row(local1)).toMatchObject({ tokens_in: 7, tokens_out: 3 });
		expect(runs.runForToken(s.db, fake.call(local1).run.token)).toBeUndefined();

		fake.call(cloud1).done({ state: 'paused' });
		await flush();
		expect([local1, local2, cloud1, cloud2].map(s.state)).toEqual([
			'succeeded',
			'running',
			'paused',
			'running'
		]);
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
		expect(io.emit({ type: 'log', payload: { msg: 'working' } })).toEqual({
			seq: 1,
			duplicate: false
		});

		runner.cancel(cancelled);
		expect(s.row(cancelled)).toMatchObject({ state: 'cancelled', token_hash: null });
		expect(runs.runForToken(s.db, run.token)).toBeUndefined();
		expect(io.signal.aborted).toBe(true);
		expect(io.park.aborted).toBe(false);
		expect(() => io.emit({ type: 'log' })).toThrow(
			expect.objectContaining({ code: 'run_not_active' })
		);
		await flush();
		expect(s.state(cancelled)).toBe('cancelled');
		expect(s.comments()).toEqual([]);
		expect(consoleError).not.toHaveBeenCalled();
		expect(s.state(waiting)).toBe('running');

		const queued = s.queue(s.local);
		runner.cancel(queued);
		expect(s.state(queued)).toBe('cancelled');
		expect(() => runner.cancel(cancelled)).toThrow(
			expect.objectContaining({ code: 'invalid_run_transition' })
		);
	});

	it('frees the pool slot as soon as a run is cancelled, even if its executor ignores the signal', async () => {
		const s = setup();
		const ignoresSignal: Executor = { execute: () => new Promise(() => {}) };
		const runner = start(s.db, { builtin: ignoresSignal });
		const [cancelled, waiting] = [s.queue(s.local), s.queue(s.local)];
		await flush();
		expect(s.state(waiting)).toBe('queued');

		runner.cancel(cancelled);
		await flush();

		expect(s.state(waiting)).toBe('running');
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
			expect(s.row(id).error).toBe(
				'[server_restart] Server-Neustart — der Run lief noch, als Studio beendet wurde.'
			);
		}
		expect(s.comments()).toEqual(
			[running, waiting].map((id) => ({
				author_kind: 'system',
				run_id: id,
				body: expect.stringContaining(
					`Run ${id} ist fehlgeschlagen: [server_restart] Server-Neustart`
				)
			}))
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
		fake
			.call(ruleBroken)
			.fail(
				new DomainError(
					'max_steps',
					'Schrittlimit 40 erreicht.',
					'max_steps im Profil erhöhen oder das Ticket teilen.'
				)
			);
		await flush();

		expect(s.row(crashed)).toMatchObject({
			state: 'failed',
			token_hash: null,
			error: '[executor_error] provider answered 401 for [secret:runner-test]'
		});
		expect(s.row(ruleBroken)).toMatchObject({
			state: 'failed',
			error: '[max_steps] Schrittlimit 40 erreicht.'
		});
		expect(s.comments()).toEqual([
			{
				author_kind: 'system',
				run_id: crashed,
				body: `Run ${crashed} ist fehlgeschlagen: [executor_error] provider answered 401 for [secret:runner-test]\nAusweg: Run-Log prüfen, Ursache beheben und einen neuen Run starten.`
			},
			{
				author_kind: 'system',
				run_id: ruleBroken,
				body: `Run ${ruleBroken} ist fehlgeschlagen: [max_steps] Schrittlimit 40 erreicht.\nAusweg: max_steps im Profil erhöhen oder das Ticket teilen.`
			}
		]);
	});

	it('fails a run with executor_unavailable instead of leaving it queued, and the way out names the installed executors', async () => {
		const s = setup();
		const acp = runs.createProfile(s.db, user, {
			name: 'ACP',
			executor: 'acp',
			command: 'agent'
		}).id;
		start(s.db, { builtin: fakeExecutor().executor });
		const id = s.queue(acp);
		await flush();
		expect(s.row(id).error).toBe(
			'[executor_unavailable] Für „acp“-Profile ist kein Executor installiert.'
		);
		expect(s.comments()).toEqual([
			{
				author_kind: 'system',
				run_id: id,
				body: `Run ${id} ist fehlgeschlagen: [executor_unavailable] Für „acp“-Profile ist kein Executor installiert.\nAusweg: Wähle ein Profil mit einem installierten Executor: builtin.`
			}
		]);
	});

	it('says plainly that runs cannot execute yet when no executor is installed at all', async () => {
		const s = setup();
		start(s.db, {});
		const id = s.queue(s.local);
		await flush();
		expect(s.comments()).toEqual([
			{
				author_kind: 'system',
				run_id: id,
				body: `Run ${id} ist fehlgeschlagen: [executor_unavailable] Für „builtin“-Profile ist kein Executor installiert.\nAusweg: In dieser Version ist noch kein Executor installiert — Runs lassen sich noch nicht ausführen.`
			}
		]);
	});

	it('keeps working the queue when the ticket of a running run is deleted, which removes the run without an event', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor }, { global: 5, pools: { local: 1 } });
		const otherTicket = board.createTicket(s.db, user, s.projectId, {
			title: 'Other',
			column_id: board.columns(s.db, s.projectId).find((c) => c.step === 'implement')!.id
		}).id;
		const [deleted, waiting] = [s.queue(s.local), s.queue(s.local, otherTicket)];
		await flush();
		expect(s.state(waiting)).toBe('queued');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		board.deleteTicket(s.db, user, s.ticketId);
		fake.call(deleted).done();
		await flush();

		expect(s.state(waiting)).toBe('running');
		expect(consoleError).toHaveBeenCalledOnce(); // finishing the vanished run fails and is logged
	});

	describe('a run whose ticket is deleted while its executor still works', () => {
		/** Deletes the ticket of an executing run, then creates a new ticket with a run, which the runner starts at once. */
		async function deletedWhileExecuting() {
			const s = setup();
			const fake = fakeExecutor();
			start(s.db, { builtin: fake.executor });
			s.queue(s.cloud);
			await flush();
			const [deleted] = fake.calls;
			board.deleteTicket(s.db, user, s.ticketId);
			const ticketId = s.newTicket();
			const runId = s.queue(s.cloud, ticketId);
			await flush();
			expect(s.state(runId)).toBe('running');
			const events = () =>
				s.db.prepare('SELECT count(*) AS n FROM run_events WHERE run_id = ?').get(runId)!.n;
			return { ...s, deleted, ticketId, runId, events };
		}

		it('never hands out the ids of the deleted ticket and run again', async () => {
			const s = await deletedWhileExecuting();
			expect(s.ticketId).not.toBe(s.deleted.run.ticketId);
			expect(s.runId).not.toBe(s.deleted.run.id);
		});

		it.each([
			['fails', (deleted: ExecutorCall) => deleted.fail(new Error('provider timed out'))],
			['succeeds', (deleted: ExecutorCall) => deleted.done()]
		])(
			'leaves the new run and ticket alone when the executor of the deleted run %s late, and logs it once',
			async (_, end) => {
				const s = await deletedWhileExecuting();
				const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

				end(s.deleted);
				await flush();

				expect(s.row(s.runId)).toMatchObject({ state: 'running', error: null, finished_at: null });
				expect(s.comments()).toEqual([]);
				expect(consoleError).toHaveBeenCalledOnce();
			}
		);

		it('rejects a late event of the deleted run instead of writing it into the new one', async () => {
			const s = await deletedWhileExecuting();

			expect(() => s.deleted.io.emit({ type: 'message', payload: { text: 'late' } })).toThrow(
				DomainError
			);
			expect(s.events()).toBe(0);
		});
	});
});

describe('priority queue', () => {
	function withPriorities() {
		const s = setup();
		const column = (step: Step) =>
			s.db
				.prepare('SELECT id FROM columns WHERE project_id = ? AND step = ?')
				.get(s.projectId, step)!.id as number;
		const reviewColumn = column('critique');
		const ticketIn = (columnId = column('implement')) =>
			board.createTicket(s.db, user, s.projectId, { title: 'T', column_id: columnId }).id;
		const blockingTicket = ticketIn();
		board.linkRelation(s.db, user, blockingTicket, ticketIn(), 'blocks');
		const reviewTicket = ticketIn(reviewColumn);
		const queueWith = (ticketId: number, trigger: 'manual' | 'on_enter') =>
			runs.createRun(s.db, user, { ticketId, profileId: s.local, trigger }).id;
		const priority = (id: number) => s.row(id).priority;
		return { ...s, column, ticketIn, blockingTicket, reviewTicket, queueWith, priority };
	}

	it('derives the priority when a run is created: normal by default, blocker for a ticket with waiting successors, review for a run triggered in critique', () => {
		const s = withPriorities();
		expect(s.priority(s.queue(s.local))).toBe('normal');
		expect(s.priority(s.queueWith(s.blockingTicket, 'manual'))).toBe('blocker');
		expect(s.priority(s.queueWith(s.reviewTicket, 'on_enter'))).toBe('review');
		expect(s.priority(s.queueWith(s.reviewTicket, 'manual'))).toBe('normal');
	});

	it('gives a ticket whose blocks successors are all done the normal priority', () => {
		const s = withPriorities();
		const [predecessor, successor] = [s.ticketIn(), s.ticketIn()];
		board.linkRelation(s.db, user, predecessor, successor, 'blocks');
		board.moveTicket(s.db, user, successor, s.column('done'));
		expect(s.priority(s.queueWith(predecessor, 'manual'))).toBe('normal');
	});

	it.each(['implement', 'critique', 'acceptance'] as const)(
		'gives a ticket whose blocks successor waits in %s the blocker priority',
		(step) => {
			const s = withPriorities();
			const [predecessor, successor] = [s.ticketIn(), s.ticketIn(s.column(step))];
			board.linkRelation(s.db, user, predecessor, successor, 'blocks');
			expect(s.priority(s.queueWith(predecessor, 'manual'))).toBe('blocker');
		}
	);

	it('rejects prioritizing a run that already runs with run_not_queued and keeps its priority', () => {
		const s = withPriorities();
		const run = s.queue(s.local);
		runs.claimRun(s.db, system, { global: 4, pools: {} });
		expect(() => runs.prioritizeRun(s.db, user, run)).toThrow(
			expect.objectContaining({ code: 'run_not_queued' })
		);
		expect(s.priority(run)).toBe('normal');
	});

	it('lets only the human prioritize a queued run; an agent gets requires_human', () => {
		const s = withPriorities();
		const run = s.queue(s.local);
		expect(() => runs.prioritizeRun(s.db, { kind: 'agent', runId: run }, run)).toThrow(
			expect.objectContaining({ code: 'requires_human' })
		);
		expect(s.priority(run)).toBe('normal');
		runs.prioritizeRun(s.db, user, run);
		expect(s.priority(run)).toBe('human');
	});

	it('claims the queued run with the highest priority once a full pool frees a slot, and the older run among equal priorities', async () => {
		const s = withPriorities();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor }, { global: 4, pools: { local: 1 } });
		const first = s.queue(s.local);
		await flush();
		const [normal, review, olderBlocker, newerBlocker, human] = [
			s.queue(s.local),
			s.queueWith(s.reviewTicket, 'on_enter'),
			s.queueWith(s.blockingTicket, 'manual'),
			s.queueWith(s.blockingTicket, 'manual'),
			s.queue(s.local)
		];
		runs.prioritizeRun(s.db, user, human);

		for (const run of [first, human, olderBlocker, newerBlocker, review]) {
			await flush();
			expect(s.state(run)).toBe('running');
			fake.call(run).done();
		}
		await flush();
		expect(fake.calls.map((c) => c.run.id)).toEqual([
			first,
			human,
			olderBlocker,
			newerBlocker,
			review,
			normal
		]);
	});

	it('never aborts a running run for a queued run with a higher priority', async () => {
		const s = withPriorities();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor }, { global: 4, pools: { local: 1 } });
		const running = s.queue(s.local);
		await flush();
		const urgent = s.queue(s.local);
		runs.prioritizeRun(s.db, user, urgent);
		await flush();
		expect([running, urgent].map(s.state)).toEqual(['running', 'queued']);
		expect(fake.call(running).io.signal.aborted).toBe(false);
	});

	it('tells why a queued run waits: its pool, how full it is and how many queued runs of the pool come first', async () => {
		const s = withPriorities();
		const limits = { global: 4, pools: { local: 1 } };
		const running = s.queue(s.local);
		runs.claimRun(s.db, system, limits);
		const [normal, blocker] = [s.queue(s.local), s.queueWith(s.blockingTicket, 'manual')];
		const human = s.queue(s.local);
		runs.prioritizeRun(s.db, user, human);

		expect(runs.waitReason(s.db, normal, limits)).toEqual({
			pool: 'local',
			priority: 'normal',
			activeInPool: 1,
			poolLimit: 1,
			active: 1,
			globalLimit: 4,
			ahead: 2,
			causes: [
				{ code: 'pool_full', pool: 'local', active: 1, limit: 1 },
				{ code: 'ahead', count: 2 }
			],
			text: 'wartet: Pool „local“ ist voll (1 von 1 aktiv), vor ihm in der Queue: 2 Runs.'
		});
		expect(runs.waitReason(s.db, human, limits)).toMatchObject({
			priority: 'human',
			ahead: 0,
			text: 'wartet: Pool „local“ ist voll (1 von 1 aktiv).'
		});
		expect(runs.waitReason(s.db, blocker, limits)).toMatchObject({ ahead: 1 });
		expect(runs.waitReason(s.db, running, limits)).toBeUndefined();
	});

	it('names a reached global limit as the wait reason', () => {
		const s = setup();
		const limits = { global: 1, pools: { local: 2, cloud: 2 } };
		s.queue(s.cloud);
		runs.claimRun(s.db, system, limits);
		const waiting = s.queue(s.local);
		expect(runs.waitReason(s.db, waiting, limits)?.text).toBe(
			'wartet: das globale Limit ist erreicht (1 von 1 aktiv).'
		);
	});
});

describe('cold start of a model', () => {
	const coldStart = { hintAfterMs: 30_000, failAfterMs: 30 * 60_000 };
	const loadingHint =
		'Das Modell hat nach 30 s noch nicht geantwortet — es wird geladen oder heruntergeladen. Warten oder den Run abbrechen; nach 30 min schlägt der Run mit model_loading_timeout fehl.';

	function startCold(...args: Parameters<typeof start>) {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const events: StudioEvent[] = [];
		stopRunners.push(subscribe((event) => events.push(event)));
		const runner = start(...args);
		const phaseEvents = (runId: number) =>
			events
				.filter(
					(e) =>
						e.type === 'run.event' && e.runId === runId && (e.payload as { phase?: string }).phase
				)
				.map(({ eventType, payload }) => ({ eventType, payload }));
		return { runner, events, phaseEvents };
	}

	it('keeps a run whose model is still loading running and reports the loading phase on the bus once the soft threshold passes', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const { phaseEvents } = startCold(s.db, { builtin: fake.executor }, LIMITS, coldStart);
		const id = s.queue(s.local);
		await flush();
		const { io } = fake.call(id);
		io.emit({ type: 'log', payload: { msg: 'request sent' } }); // a log line is not the model's answer

		vi.advanceTimersByTime(coldStart.hintAfterMs - 1);
		expect(phaseEvents(id)).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(phaseEvents(id)).toEqual([
			{
				eventType: 'log',
				payload: { phase: 'model_loading', text: 'Modell wird geladen …', hint: loadingHint }
			}
		]);

		vi.advanceTimersByTime(20_000); // the model answers after 50 s, between the soft threshold and the hard limit
		expect(s.state(id)).toBe('running');
		io.emit({ type: 'message', payload: { text: 'first answer' } });
		vi.advanceTimersByTime(coldStart.failAfterMs); // the first answer ends the cold start, so its limit no longer applies
		await flush();
		expect(s.state(id)).toBe('running');
		fake.call(id).done();
		await flush();
		expect(s.state(id)).toBe('succeeded');
		expect(phaseEvents(id)).toHaveLength(1);
	});

	it('offers to wait or cancel after the soft threshold, and a run cancelled while loading stays cancelled past the hard limit', async () => {
		const s = setup();
		const ignoresSignal: Executor = { execute: () => new Promise(() => {}) };
		const { runner, phaseEvents } = startCold(s.db, { builtin: ignoresSignal }, LIMITS, coldStart);
		const consoleError = vi.spyOn(console, 'error');
		const id = s.queue(s.local);
		await flush();

		vi.advanceTimersByTime(coldStart.hintAfterMs);
		expect(phaseEvents(id)).toMatchObject([{ payload: { hint: loadingHint } }]);
		runner.cancel(id);
		vi.advanceTimersByTime(coldStart.failAfterMs);
		await flush();

		expect(s.row(id)).toMatchObject({ state: 'cancelled', error: null });
		expect(s.comments()).toEqual([]);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('fails a run whose model does not answer within the hard limit with model_loading_timeout, a masked way out and a system comment, and frees its slot', async () => {
		const s = setup();
		const secret = 'sk-model-name-secret-0815';
		setSecret(s.db, 'model-secret', secret, false, randomBytes(32));
		const leaky = runs.createProfile(s.db, user, {
			name: 'Leaky',
			executor: 'builtin',
			provider: 'openai-compatible',
			model: secret
		}).id;
		const fake = fakeExecutor();
		startCold(s.db, { builtin: fake.executor }, LIMITS, coldStart);
		const [cold, waiting] = [s.queue(leaky), s.queue(s.local)];
		await flush();

		vi.advanceTimersByTime(coldStart.failAfterMs - 1);
		expect(s.state(cold)).toBe('running');
		vi.advanceTimersByTime(1);
		await flush();

		const error =
			'[model_loading_timeout] Das Modell „[secret:model-secret]“ hat nach 30 min noch nicht geantwortet.';
		expect(s.row(cold)).toMatchObject({ state: 'failed', token_hash: null, error });
		expect(s.comments()).toEqual([
			{
				author_kind: 'system',
				run_id: cold,
				body: `Run ${cold} ist fehlgeschlagen: ${error}\nAusweg: Im Log des Modell-Servers prüfen, ob er das Modell laden bzw. herunterladen kann, dann einen neuen Run starten.`
			}
		]);
		expect(fake.call(cold).io.signal.aborted).toBe(true);
		expect(s.state(waiting)).toBe('running');
	});

	it('stops watching a run that ends before its model answered', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const { phaseEvents } = startCold(s.db, { builtin: fake.executor }, LIMITS, coldStart);
		const consoleError = vi.spyOn(console, 'error');
		const id = s.queue(s.local);
		await flush();

		fake.call(id).done();
		await flush();
		vi.advanceTimersByTime(coldStart.failAfterMs);

		expect(s.state(id)).toBe('succeeded');
		expect(phaseEvents(id)).toEqual([]);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('publishes executor phases masked on the bus without storing them, and only a phase other than model loading ends the cold start', async () => {
		const s = setup();
		const secret = 'sk-phase-line-secret-2718';
		setSecret(s.db, 'phase-secret', secret, false, randomBytes(32));
		const fake = fakeExecutor();
		const { events } = startCold(s.db, { builtin: fake.executor }, LIMITS, coldStart);
		const id = s.queue(s.local);
		await flush();
		const { io } = fake.call(id);
		const storedEventTypes = () =>
			s.db
				.prepare('SELECT type, payload FROM run_events WHERE run_id = ?')
				.all(id)
				.map((e) => [e.type, JSON.parse(e.payload as string).phase]);

		io.phase({ name: 'model_downloading', elapsedMs: 5_000 });
		io.phase({ name: 'model_loading', elapsedMs: 10_000 });
		vi.advanceTimersByTime(coldStart.hintAfterMs); // still loading: the soft threshold reports the loading phase
		expect(storedEventTypes()).toEqual([['log', 'model_loading']]);

		const longLine = `checking ${secret} ${'x'.repeat(200)}`;
		io.phase({
			name: 'thinking',
			elapsedMs: 192_000,
			tokens: 4100,
			tokensPerSecond: 34,
			lastLine: longLine
		});
		vi.advanceTimersByTime(coldStart.failAfterMs);
		await flush();

		expect(s.state(id)).toBe('running');
		const agent = { kind: 'agent', runId: id };
		const phase = {
			type: 'run.phase',
			projectId: s.projectId,
			ticketId: s.ticketId,
			actor: agent,
			runId: id
		};
		expect(events.filter((e) => e.type === 'run.phase')).toEqual([
			{ ...phase, name: 'model_downloading', elapsedMs: 5_000 },
			{ ...phase, name: 'model_loading', elapsedMs: 10_000 },
			{
				...phase,
				name: 'thinking',
				elapsedMs: 192_000,
				tokens: 4100,
				tokensPerSecond: 34,
				lastLine: `checking [secret:phase-secret] ${'x'.repeat(200)}`.slice(0, 120)
			}
		]);
		expect(storedEventTypes()).toEqual([['log', 'model_loading']]);
	});

	it('drops a phase reported after the run was cancelled', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const { runner, events } = startCold(s.db, { builtin: fake.executor }, LIMITS, coldStart);
		const id = s.queue(s.local);
		await flush();
		runner.cancel(id);

		fake.call(id).io.phase({ name: 'writing', elapsedMs: 1_000 });

		expect(events.filter((e) => e.type === 'run.phase')).toEqual([]);
	});
});

describe('parking and resuming a run', () => {
	const runsOf = (s: ReturnType<typeof setup>) =>
		s.db
			.prepare(
				'SELECT id, state, trigger, resumed_from_run_id, resume_reason, not_before FROM runs ORDER BY id'
			)
			.all();
	const lastRunId = (s: ReturnType<typeof setup>) =>
		s.db.prepare('SELECT max(id) AS id FROM runs').get()!.id as number;

	it('raises io.park with reason and notBefore; the executor ends paused after its step, the token is revoked and the pool slot freed', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const [parked, waiting] = [s.queue(s.local), s.queue(s.local)];
		await flush();
		const { run, io } = fake.call(parked);
		expect(io.park.aborted).toBe(false);

		expect(runner.park(parked, 'quota', '2026-10-02T15:00:00.000Z')).toBe(true);

		expect(io.park.aborted).toBe(true);
		expect(io.park.reason).toEqual({ reason: 'quota', notBefore: '2026-10-02T15:00:00.000Z' });
		expect(io.signal.aborted).toBe(false);
		expect(s.state(parked)).toBe('running'); // parking lets the executor finish its step
		fake.call(parked).done({ state: 'paused' });
		await flush();
		expect(s.row(parked)).toMatchObject({ state: 'paused', token_hash: null });
		expect(runs.runForToken(s.db, run.token)).toBeUndefined();
		expect(s.state(waiting)).toBe('running');
		expect(runner.park(parked, 'quota')).toBe(false);
	});

	it('queues exactly one follow-up run for a run paused with resume, and none for a run paused without resume', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor }, { global: 5, pools: { local: 5 } });
		const [resumed, waitsForHuman] = [s.queue(s.local), s.queue(s.local)];
		await flush();
		const intervention: runs.Intervention = {
			kind: 'context_budget',
			attempt: 1,
			max: 1,
			reason: '72 % of the context used',
			hint: 'continue in a fresh run',
			stepTokens: 23_000
		};
		fake.call(resumed).io.emit({ type: 'intervention', payload: intervention });

		fake
			.call(resumed)
			.done({ state: 'paused', resume: { reason: 'context_budget', handoffSeq: 2 } });
		fake.call(waitsForHuman).done({ state: 'paused' });
		await flush();

		const followUp = lastRunId(s);
		expect(runsOf(s)).toEqual([
			{
				id: resumed,
				state: 'paused',
				trigger: 'manual',
				resumed_from_run_id: null,
				resume_reason: null,
				not_before: null
			},
			{
				id: waitsForHuman,
				state: 'paused',
				trigger: 'manual',
				resumed_from_run_id: null,
				resume_reason: null,
				not_before: null
			},
			{
				id: followUp,
				state: 'running',
				trigger: 'resume',
				resumed_from_run_id: resumed,
				resume_reason: 'context_budget',
				not_before: null
			}
		]);
		expect(fake.call(followUp).run).toMatchObject({
			ticketId: s.ticketId,
			projectId: s.projectId,
			profile: { id: s.local }
		});
		expect(
			s.db.prepare('SELECT type, payload FROM run_events WHERE run_id = ?').all(resumed)
		).toEqual([{ type: 'intervention', payload: JSON.stringify(intervention) }]);
	});

	it('allows one fresh run per chain and then asks the human with reason and handoff; parking for the quota neither counts nor is refused', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor });
		s.queue(s.local);
		const pauseLatest = async (resume: Resume) => {
			fake.call(lastRunId(s)).done({ state: 'paused', resume });
			await flush();
		};
		await flush();

		await pauseLatest({ reason: 'quota', handoffSeq: 1 });
		await pauseLatest({ reason: 'recovery', handoffSeq: 4 }); // the fresh run of the chain
		await pauseLatest({ reason: 'quota', handoffSeq: 2 });
		const exhausted = lastRunId(s);
		await pauseLatest({ reason: 'context_budget', handoffSeq: 7 });

		expect(runsOf(s).map((r) => [r.state, r.resume_reason])).toEqual([
			['paused', null],
			['paused', 'quota'],
			['paused', 'recovery'],
			['paused', 'quota']
		]);
		expect(lastRunId(s)).toBe(exhausted);
		expect(
			s.db
				.prepare('SELECT c.step FROM tickets t JOIN columns c ON c.id = t.column_id WHERE t.id = ?')
				.get(s.ticketId)
		).toEqual({ step: 'implement' }); // the question leaves the ticket where it is
		const question =
			`Run ${exhausted} kommt nicht weiter (Kontext-Budget erreicht), und seine Kette hat ihren frischen Run schon verbraucht ` +
			`(höchstens 1 je Kette). 0 Hinweise in diesem Run. Den Stand zeigt die Run-Akte: /p/STU/t/1?run=${exhausted}. Wie soll es weitergehen?`;
		expect(question).not.toContain('Event');
		const stored = s.db.prepare('SELECT run_id, question, options FROM questions').all() as {
			run_id: number;
			question: string;
			options: string;
		}[];
		expect(stored.map(({ run_id, question }) => ({ run_id, question }))).toEqual([
			{ run_id: exhausted, question }
		]);
		expect(JSON.parse(stored[0].options)).toEqual([
			{ label: 'Neuer Versuch mit frischem Kontext und meinem Hinweis' },
			{ label: 'Aufgabe verkleinern: nur den nächsten prüfbaren Schritt' },
			{
				label: 'Aufhören: Stand als Kommentar festhalten, Ticket bleibt beim Menschen',
				stopsRun: true
			}
		]);
		const commentBody = [
			question,
			'1. Neuer Versuch mit frischem Kontext und meinem Hinweis',
			'2. Aufgabe verkleinern: nur den nächsten prüfbaren Schritt',
			'3. Aufhören: Stand als Kommentar festhalten, Ticket bleibt beim Menschen'
		].join('\n');
		expect(s.comments()).toEqual([{ author_kind: 'system', run_id: exhausted, body: commentBody }]);
	});

	it('answering the escalation question with option 1 resumes the run like any other option answer', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor });
		s.queue(s.local);
		await flush();
		fake
			.call(lastRunId(s))
			.done({ state: 'paused', resume: { reason: 'recovery', handoffSeq: 1 } });
		await flush();
		fake
			.call(lastRunId(s))
			.done({ state: 'paused', resume: { reason: 'recovery', handoffSeq: 2 } });
		await flush();
		const exhausted = lastRunId(s);
		const questionId = s.db.prepare('SELECT id FROM questions WHERE run_id = ?').get(exhausted)!
			.id as number;

		answerQuestion(s.db, user, questionId, { option: 1 });

		expect(runsOf(s).at(-1)).toMatchObject({ resumed_from_run_id: exhausted, resume_reason: null });
	});

	it('stops the chain instead of starting a run when the human picks the "Aufhören" option, and keeps the handoff comment', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor });
		s.queue(s.local);
		await flush();
		fake
			.call(lastRunId(s))
			.done({ state: 'paused', resume: { reason: 'recovery', handoffSeq: 1 } });
		await flush();
		fake
			.call(lastRunId(s))
			.done({ state: 'paused', resume: { reason: 'recovery', handoffSeq: 2 } });
		await flush();
		const exhausted = lastRunId(s);
		const questionId = s.db.prepare('SELECT id FROM questions WHERE run_id = ?').get(exhausted)!
			.id as number;
		const runsBefore = (s.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n;

		const question =
			`Run ${exhausted} kommt nicht weiter (Stillstand oder Längenlimit), und seine Kette hat ihren frischen Run schon verbraucht ` +
			`(höchstens 1 je Kette). 0 Hinweise in diesem Run. Den Stand zeigt die Run-Akte: /p/STU/t/1?run=${exhausted}. Wie soll es weitergehen?`;
		const askComment = [
			question,
			'1. Neuer Versuch mit frischem Kontext und meinem Hinweis',
			'2. Aufgabe verkleinern: nur den nächsten prüfbaren Schritt',
			'3. Aufhören: Stand als Kommentar festhalten, Ticket bleibt beim Menschen'
		].join('\n');

		const { resumesRun } = answerQuestion(s.db, user, questionId, { option: 3 });

		expect(resumesRun).toBe(false);
		expect((s.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n).toBe(
			runsBefore
		);
		// Exactly the ask-time comment, no second "start a run" way-out comment for a deliberate stop.
		expect(s.comments()).toEqual([{ author_kind: 'system', run_id: exhausted, body: askComment }]);
	});

	it('still accepts a free-text answer to the escalation question alongside its three fixed options', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor });
		s.queue(s.local);
		await flush();
		fake
			.call(lastRunId(s))
			.done({ state: 'paused', resume: { reason: 'recovery', handoffSeq: 1 } });
		await flush();
		fake
			.call(lastRunId(s))
			.done({ state: 'paused', resume: { reason: 'recovery', handoffSeq: 2 } });
		await flush();
		const exhausted = lastRunId(s);
		const questionId = s.db.prepare('SELECT id FROM questions WHERE run_id = ?').get(exhausted)!
			.id as number;

		const { resumesRun } = answerQuestion(s.db, user, questionId, {
			text: 'Versuch es mit dem anderen Parser.'
		});

		expect(resumesRun).toBe(true);
		expect(runsOf(s).at(-1)).toMatchObject({ resumed_from_run_id: exhausted });
	});

	it('starts a new chain with a run the human resumes, so it gets its own fresh run', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor });
		const first = s.queue(s.local);
		await flush();
		fake.call(first).done({ state: 'paused', resume: { reason: 'recovery', handoffSeq: 1 } });
		await flush();
		const fresh = lastRunId(s);
		fake.call(fresh).done({ state: 'paused' }); // e.g. after request_human
		await flush();

		const resumedByHuman = runs.createRun(s.db, user, {
			ticketId: s.ticketId,
			profileId: s.local,
			resumedFromRunId: fresh
		}).id;
		await flush();
		fake
			.call(resumedByHuman)
			.done({ state: 'paused', resume: { reason: 'recovery', handoffSeq: 3 } });
		await flush();

		expect(runsOf(s).at(-1)).toMatchObject({
			resumed_from_run_id: resumedByHuman,
			resume_reason: 'recovery'
		});
	});

	it('claims a follow-up run only once its notBefore has passed, also after a server restart, by one timer instead of polling', async () => {
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
		});
		vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const first = s.queue(s.local);
		await flush();
		fake.call(first).done({
			state: 'paused',
			resume: { reason: 'quota', handoffSeq: 1, notBefore: '2026-10-02T15:00:00Z' }
		});
		await flush();
		const followUp = lastRunId(s);
		expect(s.row(followUp)).toMatchObject({
			state: 'queued',
			resume_reason: 'quota',
			not_before: '2026-10-02T15:00:00.000Z'
		});
		expect(vi.getTimerCount()).toBe(1);

		runner.stop();
		expect(vi.getTimerCount()).toBe(0);
		start(s.db, { builtin: fake.executor });
		expect(vi.getTimerCount()).toBe(1);
		const other = s.queue(s.local); // a held-back run does not block its pool
		await flush();
		expect([followUp, other].map(s.state)).toEqual(['queued', 'running']);
		fake.call(other).done();
		await flush();
		expect(vi.getTimerCount()).toBe(1); // every wake-up replaces the one not_before timer instead of adding another

		vi.advanceTimersByTime(3 * 3_600_000 - 1);
		await flush();
		expect(s.state(followUp)).toBe('queued');
		vi.advanceTimersByTime(1);
		await flush();
		expect(s.state(followUp)).toBe('running');
	});

	it('waits for a notBefore beyond the longest timer delay by waking once per maximum delay, not at once', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor });
		const first = s.queue(s.local);
		await flush();
		fake.call(first).done({
			state: 'paused',
			resume: { reason: 'quota', handoffSeq: 1, notBefore: '2026-11-01T12:00:00Z' }
		});
		await flush();
		const followUp = lastRunId(s);

		const before = Date.now();
		vi.advanceTimersToNextTimer();
		await flush();
		expect(Date.now() - before).toBe(2 ** 31 - 1); // setTimeout would fire at once for a longer delay and spin
		expect(s.state(followUp)).toBe('queued');
		vi.advanceTimersByTime(Date.parse('2026-11-01T12:00:00Z') - Date.now());
		await flush();
		expect(s.state(followUp)).toBe('running');
	});
});

describe('resuming after the human answers', () => {
	it('continues a run that asked the human in its original role once the undo window after the answer has passed', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
		const s = setup();
		const inProgress = s.db
			.prepare("SELECT id FROM columns WHERE project_id = ? AND step = 'implement'")
			.get(s.projectId)!.id as number;
		const ticketId = board.createTicket(s.db, user, s.projectId, {
			title: 'Asks first',
			column_id: inProgress
		}).id;
		const columnOf = () =>
			s.db.prepare('SELECT column_id FROM tickets WHERE id = ?').get(ticketId)!.column_id;
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor });
		const asking = s.queue(s.local, ticketId);
		await flush();
		const { io, done } = fake.call(asking);
		const questionId = requestHuman(s.db, { kind: 'agent', runId: asking }, ticketId, {
			question: 'Export all columns or only id and title?',
			options: [{ label: 'All' }, { label: 'Only id and title' }]
		}).id;
		io.emit({ type: 'message', key: 'handoff', payload: { text: 'Waiting for the columns.' } });
		done({ state: 'paused' });
		await flush();
		expect(s.state(asking)).toBe('paused');

		answerQuestion(s.db, user, questionId, { option: 2 });
		await flush();
		const followUp = s.db.prepare('SELECT max(id) AS id FROM runs').get()!.id as number;
		expect(s.row(followUp)).toMatchObject({
			state: 'queued',
			resumed_from_run_id: asking,
			column_id: inProgress
		});
		vi.advanceTimersByTime(10_000 - 1);
		await flush();
		expect(s.state(followUp)).toBe('queued');

		vi.advanceTimersByTime(1);
		await flush();
		expect(s.state(followUp)).toBe('running');
		expect(fake.call(followUp).run).toMatchObject({ ticketId, profile: { id: s.local } });
		expect(columnOf()).toBe(inProgress);
	});
});

describe('stop (kill switch)', () => {
	const agent: Actor = { kind: 'agent', runId: 1 };
	const haltComment = (runId: number) => ({
		author_kind: 'system',
		run_id: runId,
		body: `Run ${runId} wurde durch den Not-Aus (:stop) abgebrochen.\nAusweg: Nach dem Fortsetzen (:fortsetzen all) einen neuen Run für das Ticket starten (:run).`
	});

	it('cancels every active run at once, aborts its executor and comments on its ticket, while queued runs stay in the queue', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const [local, cloud, approving, queued] = [
			s.queue(s.local),
			s.queue(s.cloud),
			s.queue(s.cloud),
			s.queue(s.local)
		];
		await flush();
		runs.setRunState(s.db, system, approving, 'waiting_approval');
		expect([local, cloud, approving, queued].map(s.state)).toEqual([
			'running',
			'running',
			'waiting_approval',
			'queued'
		]);

		expect(runner.halt()).toEqual([local, cloud, approving]);

		for (const id of [local, cloud, approving]) {
			const { run, io } = fake.call(id);
			expect(s.row(id)).toMatchObject({ state: 'cancelled', token_hash: null });
			expect(runs.runForToken(s.db, run.token)).toBeUndefined();
			expect(io.signal.aborted).toBe(true);
		}
		expect(s.comments()).toEqual([local, cloud, approving].map(haltComment));
		await flush();
		expect(s.state(queued)).toBe('queued');
		expect(haltedSince(s.db)).toEqual(expect.any(String));
		expect(haltKind(s.db)).toBe('stop');
	});

	it('claims nothing while halted: new, follow-up and held-back runs wait with the kill switch as their reason, and releasing starts them', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
		const s = setup();
		const limits = { global: 10, pools: { local: 10, cloud: 10 } };
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor }, limits);
		const paused = s.queue(s.local);
		await flush();
		fake.call(paused).done({ state: 'paused' });
		await flush();

		runner.halt();
		const fresh = s.queue(s.cloud);
		const followUp = runs.createRun(s.db, system, {
			ticketId: s.ticketId,
			profileId: s.local,
			resumedFromRunId: paused,
			resumeReason: 'quota'
		}).id;
		const heldBack = runs.createRun(s.db, system, {
			ticketId: s.ticketId,
			profileId: s.local,
			notBefore: '2026-10-03T12:01:00Z'
		}).id;
		vi.advanceTimersByTime(60_000);
		await flush();

		const waiting = [fresh, followUp, heldBack];
		expect(waiting.map(s.state)).toEqual(['queued', 'queued', 'queued']);
		for (const id of waiting)
			expect(runs.waitReason(s.db, id, limits)?.text).toBe(
				'wartet: Not-Aus aktiv — Fortsetzen mit :fortsetzen all.'
			);
		expect(vi.getTimerCount()).toBe(0); // a held-back run that is due waits for the release, not for another timer

		releaseHalt(s.db, user);
		await flush();
		expect(waiting.map(s.state)).toEqual(['running', 'running', 'running']);
		expect(haltedSince(s.db)).toBeNull();
	});

	it('keeps the halt across a server restart: a runner on the reopened database file starts nothing until the human releases it', async () => {
		const file = join(tmp, 'halt-restart.db');
		const s = setup(openDb(file));
		const fake = fakeExecutor();
		const before = start(s.db, { builtin: fake.executor });
		const cancelled = s.queue(s.local);
		await flush();
		before.halt();
		const waiting = s.queue(s.local);
		before.stop();
		s.db.close();

		const db = openDb(file);
		migrate(db);
		const state = (id: number) => db.prepare('SELECT state FROM runs WHERE id = ?').get(id)!.state;
		const after = fakeExecutor();
		start(db, { builtin: after.executor });
		await flush();
		expect([cancelled, waiting].map(state)).toEqual(['cancelled', 'queued']);
		expect(after.calls).toEqual([]);

		releaseHalt(db, user);
		await flush();
		expect(state(waiting)).toBe('running');
		expect(after.calls.map((call) => call.run.id)).toEqual([waiting]);
		db.close();
	});

	it('lets only the human set or release the kill switch: an agent or the system gets requires_human with a way out', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const running = s.queue(s.local);
		await flush();
		const refused = expect.objectContaining({
			code: 'requires_human',
			message: 'Den Not-Aus setzt nur der Mensch.',
			hint: 'Läuft etwas aus dem Ruder: frag den Menschen (requestHuman) — er entscheidet über den Not-Aus.'
		});

		for (const actor of [agent, system]) {
			expect(() => runner.halt(actor)).toThrow(refused);
			expect(() => haltRuns(s.db, actor)).toThrow(refused);
		}
		expect(s.state(running)).toBe('running');
		expect(fake.call(running).io.signal.aborted).toBe(false);
		expect(haltedSince(s.db)).toBeNull();

		runner.halt();
		for (const actor of [agent, system])
			expect(() => releaseHalt(s.db, actor)).toThrow(
				expect.objectContaining({
					code: 'requires_human',
					message: 'Den Not-Aus löst nur der Mensch.'
				})
			);
		expect(haltedSince(s.db)).not.toBeNull();
	});

	it('starts no run that outlives a halt arriving once a claim loop has already claimed many runs', () => {
		const { db, cloud, queue } = setup();
		for (let i = 0; i < 1000; i++) queue(cloud);
		const running = () =>
			db.prepare("SELECT count(*) AS n FROM runs WHERE state = 'running'").get()!.n as number;

		const limits = { global: 2000, pools: { cloud: 2000 } };
		const claimed = Array.from({ length: 30 }, () => runs.claimRun(db, system, limits)!.id);
		expect(running()).toBe(claimed.length);

		const cancelled = haltRuns(db, user);

		expect(runs.claimRun(db, system, limits)).toBeUndefined();
		expect(new Set(claimed)).toEqual(new Set(cancelled));
		expect(running()).toBe(0);
	});

	it('starts no run that outlives a halt, whichever statement of the halt a claim lands between', () => {
		const file = join(tmp, 'halt-interleaved.db');
		const { db, cloud, queue } = setup(openDb(file));
		for (let i = 0; i < 50; i++) queue(cloud);
		const limits = { global: 1000, pools: { cloud: 1000 } };
		const rival = rivalClaimer(file, limits);
		rival.tryClaim(); // one run already running before the halt starts, like the loop above

		const cancelled = haltRuns(interleaved(db, rival.tryClaim), user);

		expect(runningIds(db)).toEqual([]);
		expect(new Set(rival.claimed)).toEqual(new Set(cancelled));
		expect(runs.claimRun(db, system, limits)).toBeUndefined();
	});
});

describe('pause (:anhalten) and resume (:fortsetzen)', () => {
	const agent: Actor = { kind: 'agent', runId: 1 };
	const continuationsOf = (s: ReturnType<typeof setup>, runId: number) =>
		s.db.prepare('SELECT id FROM runs WHERE resumed_from_run_id = ?').all(runId);
	const resumeWayOut = ':fortsetzen zeigt die angehaltenen Runs; :fortsetzen all setzt alle fort.';

	it('pauses only the run the human halts in its Run-Akte: it ends paused and halted, its executor stops, other runs keep running and the queue goes on', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const otherTicket = board.createTicket(s.db, user, s.projectId, {
			title: 'Other',
			column_id: board.columns(s.db, s.projectId).find((c) => c.step === 'implement')!.id
		}).id;
		const [halted, other, waiting] = [
			s.queue(s.local),
			s.queue(s.cloud, otherTicket),
			s.queue(s.local)
		];
		await flush();
		const { run, io } = fake.call(halted);

		runner.pause(halted);

		expect(s.row(halted)).toMatchObject({ state: 'paused', halted: 1, token_hash: null });
		expect(runs.runForToken(s.db, run.token)).toBeUndefined();
		expect(io.signal.aborted).toBe(true);
		await flush();
		expect([halted, other, waiting].map(s.state)).toEqual(['paused', 'running', 'running']);
		expect(fake.call(other).io.signal.aborted).toBe(false);
		expect(haltedSince(s.db)).toBeNull();
		expect(continuationsOf(s, halted)).toEqual([]); // nothing continues it before the human resumes it
		expect(s.comments()).toEqual([]);
	});

	it('refuses to pause a run that is not working, and names the way out', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const [finished, busy] = [s.queue(s.local), s.queue(s.local)];
		await flush();
		fake.call(finished).done();
		await flush();
		const waiting = s.queue(s.local);
		await flush();
		expect([finished, busy, waiting].map(s.state)).toEqual(['succeeded', 'running', 'queued']);

		expect(() => runner.pause(finished)).toThrow(
			expect.objectContaining({
				code: 'run_not_active',
				message: `Run ${finished} ist „succeeded“ — anhalten lässt sich nur ein laufender Run.`,
				hint: 'Er hat schon geendet; einen neuen Run startet :run in der Run-Akte.'
			})
		);
		expect(() => pauseRun(s.db, user, waiting)).toThrow(
			expect.objectContaining({
				code: 'run_not_active',
				message: `Run ${waiting} ist „queued“ — anhalten lässt sich nur ein laufender Run.`,
				hint: 'Er hat noch nichts getan: brich ihn ab (x), wenn er nicht starten soll.'
			})
		);
		expect(() => pauseRun(s.db, user, 999)).toThrow(
			expect.objectContaining({ code: 'not_found', message: 'Run 999 gibt es nicht.' })
		);
		expect(s.state(waiting)).toBe('queued');
	});

	it('pauses every active run when halted outside a Run-Akte, and the queue holds', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const [local, cloud, approving, queued] = [
			s.queue(s.local),
			s.queue(s.cloud),
			s.queue(s.cloud),
			s.queue(s.local)
		];
		await flush();
		runs.setRunState(s.db, system, approving, 'waiting_approval');

		expect(runner.pauseAll()).toEqual([local, cloud, approving]);

		for (const id of [local, cloud, approving]) {
			expect(s.row(id)).toMatchObject({ state: 'paused', halted: 1, token_hash: null });
			expect(fake.call(id).io.signal.aborted).toBe(true);
		}
		const fresh = s.queue(s.cloud);
		await flush();
		expect([queued, fresh].map(s.state)).toEqual(['queued', 'queued']);
		expect(haltKind(s.db)).toBe('pause');
		expect(runs.waitReason(s.db, queued, LIMITS)?.text).toBe(
			'wartet: alle Runs angehalten — Fortsetzen mit :fortsetzen all.'
		);
		expect(s.comments()).toEqual([]);
	});

	it('names the kind of halt: pausing keeps a stop a stop, and stopping turns a pause into a stop', async () => {
		const s = setup();
		start(s.db, { builtin: fakeExecutor().executor });

		pauseRuns(s.db, user);
		const pausedAt = haltedSince(s.db);
		haltRuns(s.db, user);
		expect([haltKind(s.db), haltedSince(s.db)]).toEqual(['stop', pausedAt]);
		pauseRuns(s.db, user);
		expect(haltKind(s.db)).toBe('stop');
		releaseHalt(s.db, user);
		expect(haltKind(s.db)).toBeNull();
	});

	it('resumes a halted run in a continuation run with resume reason halt and the human priority, claimed before older queued work', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const halted = s.queue(s.local);
		await flush();
		runner.pause(halted);
		const [busy, older] = [s.queue(s.local, s.newTicket()), s.queue(s.local, s.newTicket())];
		await flush();

		const { id: continuation } = resumeRun(s.db, user, halted);

		expect(s.row(continuation)).toMatchObject({
			state: 'queued',
			trigger: 'resume',
			priority: 'human',
			resumed_from_run_id: halted,
			resume_reason: 'halt',
			agent_profile_id: s.local,
			halted: 0
		});
		fake.call(busy).done();
		await flush();
		expect([continuation, older].map(s.state)).toEqual(['running', 'queued']);
		expect(fake.call(continuation).run).toMatchObject({
			ticketId: s.ticketId,
			profile: { id: s.local }
		});
		expect(() => resumeRun(s.db, user, halted)).toThrow(
			expect.objectContaining({
				code: 'already_resumed',
				message: `Run ${halted} setzt schon in Run ${continuation} fort.`,
				hint: resumeWayOut
			})
		);
	});

	it('refuses to resume a run that is unknown or was not halted, names the way out and queues nothing', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor }, { global: 5, pools: { local: 5 } });
		const [running, asking, done] = [s.queue(s.local), s.queue(s.local), s.queue(s.local)];
		await flush();
		fake.call(asking).done({ state: 'paused' });
		fake.call(done).done();
		await flush();
		const before = s.db.prepare('SELECT count(*) AS n FROM runs').get();

		expect(() => resumeRun(s.db, user, 999)).toThrow(
			expect.objectContaining({
				code: 'not_found',
				message: 'Run 999 gibt es nicht.',
				hint: resumeWayOut
			})
		);
		for (const [id, state] of [
			[running, 'running'],
			[asking, 'paused'],
			[done, 'succeeded']
		] as const)
			expect(() => resumeRun(s.db, user, id)).toThrow(
				expect.objectContaining({
					code: 'run_not_halted',
					message: `Run ${id} ist nicht angehalten („${state}“) — fortsetzen lässt sich nur ein Run, den :anhalten pausiert hat.`,
					hint: resumeWayOut
				})
			);
		expect(s.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual(before);
	});

	it('never resumes a run the stop cancelled: only a new run continues its ticket', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const stopped = s.queue(s.local);
		await flush();
		runner.halt();

		expect(() => resumeRun(s.db, user, stopped)).toThrow(
			expect.objectContaining({
				code: 'run_not_halted',
				message: `Run ${stopped} ist nicht angehalten („cancelled“) — fortsetzen lässt sich nur ein Run, den :anhalten pausiert hat.`,
				hint: 'Ein abgebrochener Run lässt sich nicht fortsetzen; einen neuen startet :run in der Run-Akte.'
			})
		);
		expect(resumeAll(s.db, user)).toEqual({ resumed: [], skipped: [] });
		expect(continuationsOf(s, stopped)).toEqual([]);
		expect(() =>
			runs.createRun(s.db, user, {
				ticketId: s.ticketId,
				profileId: s.local,
				resumedFromRunId: stopped
			})
		).toThrow(expect.objectContaining({ code: 'invalid_resume' }));
		expect(s.state(stopped)).toBe('cancelled');
	});

	it('resumes every halted run and lifts the halt with :fortsetzen all, whether the halt was a pause or a stop', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor }, { global: 10, pools: { local: 10 } });
		const [first, second] = [s.queue(s.local), s.queue(s.local, s.newTicket())];
		await flush();
		runner.pauseAll();
		const queued = s.queue(s.local, s.newTicket());

		const { resumed: afterPause, skipped: skippedAfterPause } = resumeAll(s.db, user);
		await flush();

		expect(skippedAfterPause).toEqual([]);
		expect(afterPause).toHaveLength(2);
		expect(afterPause.map((id) => s.row(id))).toMatchObject(
			[first, second].map((halted) => ({
				state: 'running',
				resumed_from_run_id: halted,
				resume_reason: 'halt',
				priority: 'human'
			}))
		);
		expect(s.state(queued)).toBe('running');
		expect(haltKind(s.db)).toBeNull();

		const pausedAlone = afterPause[0];
		runner.pause(pausedAlone);
		runner.halt();
		const waiting = s.queue(s.local, s.newTicket());
		const { resumed: afterStop, skipped: skippedAfterStop } = resumeAll(s.db, user);
		await flush();

		expect(skippedAfterStop).toEqual([]);
		expect(afterStop.map((id) => s.row(id).resumed_from_run_id)).toEqual([pausedAlone]);
		expect(continuationsOf(s, afterPause[1])).toEqual([]); // cancelled by the stop
		expect([waiting, ...afterStop].map(s.state)).toEqual(['running', 'running']);
		expect(haltKind(s.db)).toBeNull();
	});

	it('refuses to delete a profile a paused run still needs to resume, so the halt can never get stuck without a way out', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		s.queue(s.local);
		await flush();
		runner.pauseAll();

		expect(() => runs.deleteProfile(s.db, user, s.local)).toThrow(
			expect.objectContaining({ code: 'profile_in_use' })
		);

		const { resumed, skipped } = resumeAll(s.db, user);
		expect(resumed).toHaveLength(1);
		expect(skipped).toEqual([]);
		expect(haltKind(s.db)).toBeNull();
	});

	it('skips a halted run whose profile is already gone (legacy data from before the delete guard), reports it, and still resumes the rest and releases the halt', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const [orphaned, healthy] = [s.queue(s.local), s.queue(s.cloud, s.newTicket())];
		await flush();
		runner.pauseAll();
		s.db.prepare('UPDATE runs SET agent_profile_id = NULL WHERE id = ?').run(orphaned);

		const { resumed, skipped } = resumeAll(s.db, user);

		expect(resumed).toHaveLength(1);
		expect(s.row(resumed[0]).resumed_from_run_id).toBe(healthy);
		expect(skipped).toEqual([
			{
				runId: orphaned,
				code: 'profile_deleted',
				message: `Das Agent-Profil von Run ${orphaned} gibt es nicht mehr.`,
				hint: 'Starte in der Run-Akte einen neuen Run mit einem anderen Profil (:run).'
			}
		]);
		expect(haltKind(s.db)).toBeNull();
		expect(s.row(orphaned)).toMatchObject({ state: 'paused', halted: 1 });
	});

	it('lets only the human pause or resume runs: an agent or the system gets requires_human with a way out', async () => {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const [running, halted] = [s.queue(s.local), s.queue(s.cloud)];
		await flush();
		runner.pause(halted);
		const refused = (message: string) =>
			expect.objectContaining({
				code: 'requires_human',
				message,
				hint: 'Läuft etwas aus dem Ruder: frag den Menschen (requestHuman) — er entscheidet, ob Runs anhalten.'
			});

		for (const actor of [agent, system]) {
			expect(() => runner.pause(running, actor)).toThrow(refused('Runs hält nur der Mensch an.'));
			expect(() => runner.pauseAll(actor)).toThrow(refused('Runs hält nur der Mensch an.'));
			expect(() => resumeRun(s.db, actor, halted)).toThrow(
				refused('Angehaltene Runs setzt nur der Mensch fort.')
			);
			expect(() => resumeAll(s.db, actor)).toThrow(
				refused('Angehaltene Runs setzt nur der Mensch fort.')
			);
		}
		expect(s.state(running)).toBe('running');
		expect(fake.call(running).io.signal.aborted).toBe(false);
		expect(haltedSince(s.db)).toBeNull();
		expect(continuationsOf(s, halted)).toEqual([]);
	});
});

describe('the chain of runs', () => {
	const lageOf = (db: ReturnType<typeof openDb>, ticketId: number) =>
		ticketLagen(db).find((row) => row.ticketId === ticketId);

	/** A run that finishes its step as done, as a well-behaved agent does, and ends. */
	const finishingExecutor = (db: ReturnType<typeof openDb>): Executor => ({
		execute: async (run) => {
			finishStep(db, { kind: 'agent', runId: run.id }, run.ticketId, {
				result: 'done',
				summary: `Run ${run.id}: done.`
			});
		}
	});

	it.each([
		['software', ['refine', 'plan', 'implement', 'critique']],
		['direct', ['implement', 'critique']]
	] as const)(
		'carries a %s ticket from one „los“ through %j to acceptance, one run per step',
		async (variant, steps) => {
			const db = openDb(':memory:');
			migrate(db);
			const projectId = board.createProject(db, user, { key: 'E2E', name: 'Kette' }, variant).id;
			const ticketId = board.createTicket(db, user, projectId, {
				title: 'Export',
				description: 'CSV export',
				size: 'S'
			}).id;
			board.completeTasks(db, user, ticketId, board.addTasks(db, user, ticketId, ['CSV']).ids);
			const profileId = runs.createProfile(db, user, {
				name: 'Lokal',
				executor: 'builtin',
				provider: 'openai-compatible',
				model: 'm'
			}).id;
			start(db, { builtin: finishingExecutor(db) });

			startTicket(db, user, ticketId, profileId);
			await vi.waitFor(() => expect(board.ticket(db, ticketId).column_step).toBe('acceptance'));
			await flush();

			expect(
				db
					.prepare(
						'SELECT c.step, r.state, r.trigger, r.agent_profile_id AS profileId FROM runs r JOIN columns c ON c.id = r.column_id ORDER BY r.id'
					)
					.all()
			).toEqual(
				steps.map((step, i) => ({
					step,
					state: 'succeeded',
					trigger: i === 0 ? 'manual' : 'on_enter',
					profileId
				}))
			);
		}
	);

	it('stops at a run that fails after finishing its step: the ticket waits for the human instead of a next run', async () => {
		const s = setup();
		const finishing = finishingExecutor(s.db);
		start(s.db, {
			builtin: {
				execute: async (run, io) => {
					await finishing.execute(run, io);
					throw new Error('model gone');
				}
			}
		});
		const failed = s.queue(s.local);
		await vi.waitFor(() => expect(s.state(failed)).toBe('failed'));
		await flush();
		expect(board.ticket(s.db, s.ticketId).column_step).toBe('critique');
		expect(s.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
		expect(lageOf(s.db, s.ticketId)).toMatchObject({
			lage: 'waiting',
			reason: { kind: 'failure' }
		});
	});

	it('lets a ticket wait for the human when the server stopped after finish_step but before the run ended', () => {
		const s = setup();
		const plan = board.columns(s.db, s.projectId).find((c) => c.step === 'plan')!.id;
		const ticketId = board.createTicket(s.db, user, s.projectId, {
			title: 'P',
			column_id: plan
		}).id;
		const orphaned = s.queue(s.local, ticketId);
		runs.startRun(s.db, system, orphaned);
		finishStep(s.db, { kind: 'agent', runId: orphaned }, ticketId, {
			result: 'done',
			summary: 'Plan'
		});

		start(s.db, {});

		expect(s.db.prepare('SELECT id, state FROM runs').all()).toEqual([
			{ id: orphaned, state: 'failed' }
		]);
		expect(lageOf(s.db, ticketId)).toMatchObject({
			step: 'implement',
			lage: 'waiting',
			reason: { kind: 'failure' }
		});
	});

	it('lets a ticket wait for the human when its run ends without finish_step, instead of leaving it ready', async () => {
		const s = setup();
		start(s.db, { builtin: { execute: async () => {} } });
		const silent = s.queue(s.local);
		await vi.waitFor(() => expect(s.state(silent)).toBe('succeeded'));
		await flush();

		expect(s.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
		expect(lageOf(s.db, s.ticketId)).toMatchObject({
			lage: 'waiting',
			reason: { kind: 'stalled' }
		});
	});

	it.each(['stop', 'pause'] as const)(
		'keeps the next step’s run waiting in the queue through a %s, never cancels it, and starts it once the human resumes',
		async (kind) => {
			const s = setup();
			const fake = fakeExecutor();
			const runner = start(s.db, { builtin: fake.executor }); // one local run at a time
			const plan = board.columns(s.db, s.projectId).find((c) => c.step === 'plan')!.id;
			const chained = board.createTicket(s.db, user, s.projectId, {
				title: 'K',
				column_id: plan
			}).id;
			const first = s.queue(s.local, chained);
			await flush();
			const other = s.queue(s.local); // older than the chain's run, so it takes the freed slot first
			finishStep(s.db, { kind: 'agent', runId: first }, chained, {
				result: 'done',
				summary: 'Plan'
			});
			fake.call(first).done();
			await flush();
			const next = s.db.prepare("SELECT id FROM runs WHERE trigger = 'on_enter'").get()!
				.id as number;
			expect([s.state(other), s.state(next)]).toEqual(['running', 'queued']);

			if (kind === 'stop') runner.halt();
			else runner.pauseAll();
			await flush();
			expect(s.row(next)).toMatchObject({ state: 'queued', ticket_id: chained });

			resumeAll(s.db, user);
			await flush();
			const resumedOther = s.db
				.prepare('SELECT id FROM runs WHERE resumed_from_run_id = ?')
				.get(other) as { id: number } | undefined;
			if (resumedOther) fake.call(resumedOther.id).done(); // a paused run resumes ahead of the chain
			await flush();
			expect(s.state(next)).toBe('running');
		}
	);
});

/** A started successor whose newest run ended its step with back, as the chain leaves it when a predecessor stands before it. */
function backedSuccessor(s: ReturnType<typeof setup>) {
	const successor = s.newTicket();
	const back = s.queue(s.local, successor);
	runs.startRun(s.db, system, back);
	finishStep(s.db, { kind: 'agent', runId: back }, successor, {
		result: 'back',
		summary: 'Finding'
	});
	runs.finishRun(s.db, system, back, { state: 'succeeded' });
	return successor;
}

describe('the chain of runs across a blocks predecessor', () => {
	/** A started successor whose `back` run ended while its predecessor stood before it, and a runner that stays out of the way. */
	function gated() {
		const s = setup();
		const fake = fakeExecutor();
		const runner = start(s.db, { builtin: fake.executor });
		const successor = backedSuccessor(s);
		const stepColumn = (step: Step) =>
			board.columns(s.db, s.projectId).find((c) => c.step === step)!.id;
		const predecessor = board.createTicket(s.db, user, s.projectId, {
			title: 'Davor',
			description: 'Voraussetzung',
			size: 'S',
			column_id: stepColumn('acceptance')
		}).id;
		board.linkRelation(s.db, user, predecessor, successor, 'blocks');
		const followUps = () =>
			s.db
				.prepare("SELECT id, state FROM runs WHERE ticket_id = ? AND trigger = 'on_enter'")
				.all(successor) as { id: number; state: string }[];
		return { s, fake, runner, successor, predecessor, stepColumn, followUps };
	}

	it('queues one follow-up run when the predecessor is accepted', async () => {
		const g = gated();
		expect(g.followUps()).toEqual([]);
		acceptTicket(g.s.db, user, g.predecessor);
		await flush();
		expect(g.followUps()).toHaveLength(1);
	});

	it('queues one follow-up run when a human moves the predecessor to done', async () => {
		const g = gated();
		board.moveTicket(g.s.db, user, g.predecessor, g.stepColumn('done'));
		await flush();
		expect(g.followUps()).toHaveLength(1);
	});

	it('queues one follow-up run when the critique approves the predecessor and review approval suffices', async () => {
		const g = gated();
		board.setBlocksSatisfiedAt(g.s.db, user, g.s.projectId, 'review_ok');
		board.moveTicket(g.s.db, user, g.predecessor, g.stepColumn('critique'));
		board.completeTasks(
			g.s.db,
			user,
			g.predecessor,
			board.addTasks(g.s.db, user, g.predecessor, ['K']).ids
		);
		const critique = g.s.queue(g.s.local, g.predecessor);
		await flush();
		expect(g.s.state(critique)).toBe('running');
		expect(g.followUps()).toEqual([]);

		finishStep(g.s.db, { kind: 'agent', runId: critique }, g.predecessor, {
			result: 'done',
			summary: 'Passt'
		});
		await flush();

		expect(g.followUps()).toHaveLength(1); // approval and move both fire, one run results
	});

	it.each(['stop', 'pause'] as const)(
		'keeps the follow-up run queued through a %s and starts it on resume',
		async (kind) => {
			const g = gated();
			if (kind === 'stop') g.runner.halt();
			else g.runner.pauseAll();
			board.moveTicket(g.s.db, user, g.predecessor, g.stepColumn('done'));
			await flush();
			const [followUp] = g.followUps();
			expect(followUp.state).toBe('queued');

			resumeAll(g.s.db, user);
			await flush();

			expect(g.s.state(followUp.id)).toBe('running');
		}
	);
});

describe('a failing follow-up run', () => {
	it('C: a failing follow-up neither fails the committed accept nor hides the event from later subscribers', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor });
		const successor = backedSuccessor(s);
		const predecessor = board.createTicket(s.db, user, s.projectId, {
			title: 'Davor',
			column_id: board.columns(s.db, s.projectId).find((c) => c.step === 'acceptance')!.id
		}).id;
		board.linkRelation(s.db, user, predecessor, successor, 'blocks');
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		s.db.exec(
			"CREATE TRIGGER refuse_follow_up BEFORE INSERT ON runs WHEN NEW.trigger = 'on_enter' BEGIN SELECT RAISE(ABORT, 'database is locked'); END"
		);
		const seen: string[] = [];
		const unsubscribe = subscribe((e) => seen.push(e.type));
		let thrown: unknown;
		try {
			acceptTicket(s.db, user, predecessor);
		} catch (err) {
			thrown = err;
		}
		unsubscribe();
		expect(board.ticket(s.db, predecessor).column_step).toBe('done');
		expect({ thrown: String(thrown), seen }).toEqual({
			thrown: 'undefined',
			seen: ['ticket.moved']
		});
		await flush();
		expect(logged).toHaveBeenCalledOnce();
	});
});

describe('the order of events around a follow-up run', () => {
	it('E: a later subscriber sees the move before the follow-up run it caused', async () => {
		const s = setup();
		const fake = fakeExecutor();
		start(s.db, { builtin: fake.executor });
		const successor = backedSuccessor(s);
		const predecessor = board.createTicket(s.db, user, s.projectId, {
			title: 'Davor',
			column_id: board.columns(s.db, s.projectId).find((c) => c.step === 'acceptance')!.id
		}).id;
		board.linkRelation(s.db, user, predecessor, successor, 'blocks');
		const seen: string[] = [];
		const unsubscribe = subscribe((e) => seen.push(e.type));
		acceptTicket(s.db, user, predecessor);
		await flush();
		unsubscribe();
		expect(seen.filter((t) => t === 'ticket.moved' || t === 'run.created')).toEqual([
			'ticket.moved',
			'run.created'
		]);
	});
});

describe('the review approval of a predecessor', () => {
	it('queues one follow-up run on the approval alone, without any move', async () => {
		const s = setup();
		start(s.db, { builtin: fakeExecutor().executor });
		board.setBlocksSatisfiedAt(s.db, user, s.projectId, 'review_ok');
		const successor = backedSuccessor(s);
		const predecessor = board.createTicket(s.db, user, s.projectId, {
			title: 'Davor',
			column_id: board.columns(s.db, s.projectId).find((c) => c.step === 'acceptance')!.id
		}).id;
		board.linkRelation(s.db, user, predecessor, successor, 'blocks');
		await flush();
		expect(s.db.prepare("SELECT count(*) AS n FROM runs WHERE trigger = 'on_enter'").get()).toEqual(
			{ n: 0 }
		);

		board.approveReview(s.db, user, predecessor);
		await flush();

		expect(s.db.prepare("SELECT count(*) AS n FROM runs WHERE trigger = 'on_enter'").get()).toEqual(
			{ n: 1 }
		);
	});
});
