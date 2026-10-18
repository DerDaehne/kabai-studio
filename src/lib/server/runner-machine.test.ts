// Runs on a paired machine's pool, through the real runner and the real /runner channel: a machine's hello opens its
// pool with the slots it reported, its loss closes it again, and 40 s after the loss its active runs end.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { translate } from '../i18n/index';
import type { WaitCause } from '../lage';
import { assemblePrompt } from './agents/prompt';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import { answerQuestion, requestHuman } from './domain/questions';
import { issuePairingCode, pairRunner } from './domain/runners';
import * as runs from './domain/runs';
import type { Executor, ExecutorFacts, RunContext } from './executors/contract';
import { limits, startRunner, type ApprovalPolicy } from './runner';
import { installRunnerChannel, type RunnerChannel } from './runner-channel';
import { subscribe } from './events';
import { DEAD_MAN_GRACE_MS, DEAD_MAN_MS } from './runner-protocol';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };
const MACHINE = 'workstation';
const DEADLINE_MS = DEAD_MAN_MS + DEAD_MAN_GRACE_MS;

type Call = {
	run: RunContext;
	io: Parameters<Executor['execute']>[1];
	done: (facts?: ExecutorFacts) => void;
	abortedWithToken?: boolean;
};

let db: ReturnType<typeof openDb>;
let channel: RunnerChannel;
let server: Server;
let port: number;
const sockets: WebSocket[] = [];
const cleanups: (() => void)[] = [];

beforeEach(async () => {
	db = openDb(':memory:');
	migrate(db);
	channel = installRunnerChannel(db);
	server = createServer().on('upgrade', channel.handleUpgrade);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	vi.useRealTimers();
	for (const socket of sockets.splice(0)) socket.terminate();
	channel.close();
	await new Promise((resolve) => server.close(resolve));
	db.close();
});

function setup() {
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const column = board.columns(db, projectId).find((c) => c.step === 'implement')!.id;
	const newTicket = () =>
		board.createTicket(db, user, projectId, { title: 'T', column_id: column }).id;
	const profile = (pool: string) =>
		runs.createProfile(db, user, {
			name: pool,
			executor: 'builtin',
			provider: 'anthropic', // a cloud model: no cold start watch with its own timers
			model: 'm',
			pool
		}).id;
	const machinePool = profile(`runner:${MACHINE}`);
	const cloud = profile('cloud');
	const queue = (profileId: number, ticketId = newTicket()) =>
		runs.createRun(db, user, { ticketId, profileId }).id;
	const state = (id: number) => db.prepare('SELECT state FROM runs WHERE id = ?').get(id)!.state;
	const error = (id: number) => db.prepare('SELECT error FROM runs WHERE id = ?').get(id)!.error;
	return { projectId, newTicket, machinePool, cloud, queue, state, error };
}

/** An executor that works until the test ends it or its run is aborted, like a real one whose agent runs on the machine. */
function hangingExecutor() {
	const calls: Call[] = [];
	const executor: Executor = {
		execute: (run, io) =>
			new Promise<ExecutorFacts>((done, fail) => {
				const call: Call = { run, io, done: (facts = { ending: 'end_turn' }) => done(facts) };
				io.signal.addEventListener('abort', () => {
					call.abortedWithToken = runs.runForToken(db, run.token) !== undefined;
					fail(new Error('aborted'));
				});
				calls.push(call);
			})
	};
	const call = (runId: number) => calls.find((c) => c.run.id === runId)!;
	return { executor, calls, call };
}

function start(executor: Executor, approve?: ApprovalPolicy) {
	const runner = startRunner(db, { builtin: executor }, undefined, undefined, { approve });
	cleanups.push(runner.stop);
	return runner;
}

const pair = (name = MACHINE) => pairRunner(db, { code: issuePairingCode().code, name });

/** A machine's real handshake: the credential on the upgrade, then hello, then the server's welcome. */
async function connect(credential: string, slots = 2) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/runner`, {
		headers: { authorization: `Bearer ${credential}` }
	});
	sockets.push(socket);
	await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
	const welcome = new Promise((resolve) => socket.once('message', resolve));
	socket.send(
		JSON.stringify({
			type: 'hello',
			protocol: 1,
			version: '1.0.0',
			slots,
			workspaces: [],
			agents: []
		})
	);
	await welcome;
	return socket;
}

/** The connection drops without a close handshake, the way a lost network or a crashed runner ends it. */
async function lose(socket: WebSocket) {
	// the bus event itself, not vi.waitFor: that one moves a fake clock on while it polls
	const gone = new Promise<void>((resolve) => {
		const unsubscribe = subscribe((event) => {
			if (event.type !== 'machine.disconnected') return;
			unsubscribe();
			resolve();
		});
	});
	socket.terminate();
	await gone;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const causeCodes = (runId: number) =>
	runs.waitReason(db, runId, limits())!.causes.map((cause) => cause.code);

describe("a machine's pool", () => {
	it('keeps a run queued while its machine is not connected and starts it on the machine’s hello alone', async () => {
		const s = setup();
		const { credential } = pair();
		const fake = hangingExecutor();
		start(fake.executor);
		const run = s.queue(s.machinePool);
		await flush();
		expect(s.state(run)).toBe('queued');

		await connect(credential);

		await vi.waitFor(() => expect(s.state(run)).toBe('running'));
	});

	it('runs at most as many runs at once as the machine reported slots, and a full pool waits with real numbers', async () => {
		const s = setup();
		const { credential } = pair();
		const fake = hangingExecutor();
		start(fake.executor);
		const queued = [s.queue(s.machinePool), s.queue(s.machinePool), s.queue(s.machinePool)];

		await connect(credential, 2);

		await vi.waitFor(() => expect(queued.map(s.state)).toEqual(['running', 'running', 'queued']));
		expect(runs.waitReason(db, queued[2], limits())!.causes[0]).toEqual({
			code: 'pool_full',
			pool: `runner:${MACHINE}`,
			active: 2,
			limit: 2
		});
	});

	it('closes again when the machine goes, so a new run waits for it', async () => {
		const s = setup();
		const { credential } = pair();
		const fake = hangingExecutor();
		start(fake.executor);
		await lose(await connect(credential));

		const run = s.queue(s.machinePool);
		await flush();

		expect(s.state(run)).toBe('queued');
		expect(causeCodes(run)).toEqual(['machine_offline']);
	});
});

describe('fail-closed pools of machines', () => {
	it('gives a runner pool without a connected machine no slot in the claim and the wait reason, even without a pairing, while other pools keep the default', () => {
		const s = setup();
		const ghost = runs.createProfile(db, user, {
			name: 'ghost',
			executor: 'builtin',
			provider: 'anthropic',
			model: 'm',
			pool: 'runner:ghost'
		}).id;
		const gpu = runs.createProfile(db, user, {
			name: 'gpu',
			executor: 'builtin',
			provider: 'anthropic',
			model: 'm',
			pool: 'gpu'
		}).id;
		pair(); // a paired machine that is not connected
		const limits = { global: 10, pools: {} };
		const [never, unpaired, other] = [s.queue(s.machinePool), s.queue(ghost), s.queue(gpu)];

		expect(runs.claimRun(db, system, limits)?.id).toBe(other);
		expect(runs.claimRun(db, system, limits)).toBeUndefined();

		for (const run of [never, unpaired]) {
			const reason = runs.waitReason(db, run, limits)!;
			expect(reason.poolLimit).toBe(0);
			expect(reason.causes.map((cause) => cause.code)).not.toContain('pool_full');
		}
		expect(runs.DEFAULT_POOL_SLOTS).toBe(1);
		const second = s.queue(gpu);
		expect(runs.waitReason(db, second, limits)).toMatchObject({ poolLimit: 1 });
	});
});

describe('why a run of a machine waits', () => {
	const WAY_OUT =
		'Ausweg: Dort `kabai-studio runner start` ausführen (bzw. unter Einstellungen → Rechner koppeln) oder den Run abbrechen und mit einem anderen Profil starten.';

	it('names the machine and the way out, never a full pool of 0: never connected, not connected since, not paired', async () => {
		const s = setup();
		const { credential } = pair();
		const ghost = runs.createProfile(db, user, {
			name: 'ghost',
			executor: 'builtin',
			provider: 'anthropic',
			model: 'm',
			pool: 'runner:ghost'
		}).id;
		const [mine, other] = [s.queue(s.machinePool), s.queue(ghost)];
		const reason = (run: number) => runs.waitReason(db, run, limits())!;

		expect(reason(mine).causes).toEqual([{ code: 'machine_never_connected', machine: MACHINE }]);
		expect(reason(mine).text).toBe(
			`Wartet auf Rechner „${MACHINE}“ – noch nie verbunden. ${WAY_OUT}`
		);
		expect(reason(other).causes).toEqual([{ code: 'machine_unpaired', machine: 'ghost' }]);
		expect(reason(other).text).toBe(`Rechner „ghost“ ist nicht gekoppelt. ${WAY_OUT}`);

		await lose(await connect(credential));
		const seen = db.prepare('SELECT last_seen_at FROM runners WHERE name = ?').get(MACHINE)!
			.last_seen_at as string;
		const since = `${seen.slice(0, 16)} UTC`;
		expect(reason(mine).causes).toEqual([{ code: 'machine_offline', machine: MACHINE, since }]);
		expect(reason(mine).text).toBe(
			`Wartet auf Rechner „${MACHINE}“ – nicht verbunden seit ${since}. ${WAY_OUT}`
		);
	});

	it('adds the other causes after the machine', () => {
		const s = setup();
		pair();
		s.queue(s.machinePool);
		const second = s.queue(s.machinePool);
		const reason = runs.waitReason(db, second, { global: 0, pools: {} })!;
		expect(reason.text).toBe(
			`Wartet auf Rechner „${MACHINE}“ – noch nie verbunden. Außerdem: das globale Limit ist erreicht (0 von 0 aktiv), vor ihm in der Queue: 1 Run. ${WAY_OUT}`
		);
	});

	it.each(['en', 'de'] as const)(
		'tells the board (%s) which machine it waits for and the way out, cancelling the run included',
		(locale) => {
			const causes: WaitCause[] = [
				{ code: 'machine_offline', machine: MACHINE, since: '2026-10-18 15:02 UTC' },
				{ code: 'machine_never_connected', machine: MACHINE },
				{ code: 'machine_unpaired', machine: MACHINE }
			];
			const cancel = locale === 'en' ? 'cancel the run' : 'den Run abbrechen';
			const texts = causes.map(({ code, ...params }) =>
				translate(locale, `lage.wait.${code}`, params)
			);
			const quoted = locale === 'en' ? `"${MACHINE}"` : `„${MACHINE}“`;
			for (const text of texts) {
				expect(text).toContain(quoted);
				expect(text).toContain(cancel);
			}
			expect(texts[0]).toContain('2026-10-18 15:02 UTC');
			expect(texts[0]).toContain('kabai-studio runner start');
			expect(texts[1]).toContain('kabai-studio runner start');
		}
	);
});

describe('the server dead-man for a lost machine', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	});

	/** Two active runs on the machine (one waiting for an approval), one queued behind them and one cloud run. */
	async function busyMachine() {
		const s = setup();
		const { credential } = pair();
		const fake = hangingExecutor();
		const approve: ApprovalPolicy = () => new Promise(() => {}); // the approval never comes
		start(fake.executor, approve);
		const [running, waiting, queued] = [
			s.queue(s.machinePool),
			s.queue(s.machinePool),
			s.queue(s.machinePool)
		];
		const cloud = s.queue(s.cloud);
		const socket = await connect(credential, 2);
		await vi.waitFor(() => expect(fake.calls).toHaveLength(3));
		void fake.call(waiting).io.approval({ key: 'call-1', kind: 'execute', title: 'ls' });
		expect([running, waiting, queued, cloud].map(s.state)).toEqual([
			'running',
			'waiting_approval',
			'queued',
			'running'
		]);
		return { s, fake, credential, socket, running, waiting, queued, cloud };
	}

	it('fails the active runs of the pool 40 s after the loss with runner_disconnected and a way out, revoking their tokens before the executor sees the signal', async () => {
		const m = await busyMachine();
		await lose(m.socket);

		vi.advanceTimersByTime(DEADLINE_MS - 1);
		await flush();
		expect([m.running, m.waiting].map(m.s.state)).toEqual(['running', 'waiting_approval']);

		vi.advanceTimersByTime(1);
		await flush();

		for (const run of [m.running, m.waiting]) {
			expect(m.s.state(run)).toBe('failed');
			expect(m.s.error(run)).toBe(
				`[runner_disconnected] Rechner „${MACHINE}“ war länger als 40 s nicht verbunden; seine Agents wurden dort beendet.`
			);
			const call = m.fake.call(run);
			expect(call.io.signal.aborted).toBe(true);
			expect(call.abortedWithToken).toBe(false);
			expect(runs.runForToken(db, call.run.token)).toBeUndefined();
		}
		const comments = db
			.prepare('SELECT author_kind, run_id, body FROM comments ORDER BY id')
			.all()
			.filter((comment) => String(comment.body).includes('runner_disconnected'));
		expect(comments.map((comment) => comment.run_id)).toEqual([m.running, m.waiting]);
		for (const comment of comments) {
			expect(comment.author_kind).toBe('system');
			expect(comment.body).toMatch(
				/\nAusweg: Rechner wieder verbinden \(dort `kabai-studio runner start`\) und den Run neu starten\.$/
			);
		}
		expect(m.s.state(m.queued)).toBe('queued'); // its pool has room now, but no machine
		expect(causeCodes(m.queued)).toEqual(['machine_offline']);
		expect(m.s.state(m.cloud)).toBe('running');
		expect(m.fake.call(m.cloud).io.signal.aborted).toBe(false);
	});

	it('lets the runs go on when the machine is back after 39 s', async () => {
		const m = await busyMachine();
		await lose(m.socket);

		vi.advanceTimersByTime(DEADLINE_MS - 1000);
		await connect(m.credential, 2);
		vi.advanceTimersByTime(10 * DEADLINE_MS);
		await flush();

		expect([m.running, m.waiting, m.queued].map(m.s.state)).toEqual([
			'running',
			'waiting_approval',
			'queued'
		]);
		expect(m.fake.call(m.running).io.signal.aborted).toBe(false);
	});

	it('starts the deadline afresh when the machine is lost again after a reconnect', async () => {
		const m = await busyMachine();
		await lose(m.socket);
		vi.advanceTimersByTime(DEADLINE_MS / 2);
		const again = await connect(m.credential, 2);
		vi.advanceTimersByTime(1000);
		await lose(again);
		vi.advanceTimersByTime(DEADLINE_MS - 1);
		await flush();
		expect(m.s.state(m.running)).toBe('running');
		vi.advanceTimersByTime(1);
		await flush();
		expect(m.s.state(m.running)).toBe('failed');
	});

	it('leaves an answer that a run lost before its first sign of life never showed to the next run', async () => {
		const s = setup();
		const { credential } = pair();
		const fake = hangingExecutor();
		const runner = start(fake.executor);
		const ticketId = s.newTicket();
		const socket = await connect(credential);
		const asking = s.queue(s.machinePool, ticketId);
		await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
		const questionId = requestHuman(db, { kind: 'agent', runId: asking }, ticketId, {
			question: 'Export all columns or only id and title?',
			options: [{ label: 'All' }, { label: 'Only id and title' }]
		}).id;
		fake.call(asking).done();
		await vi.waitFor(() => expect(s.state(asking)).toBe('paused'));
		expect(answerQuestion(db, user, questionId, { option: 2 }).resumesRun).toBe(true);
		const collected = () =>
			db.prepare('SELECT collected_at FROM questions WHERE id = ?').get(questionId)!.collected_at;
		const resumed = db.prepare('SELECT max(id) AS id FROM runs').get()!.id as number;
		// past the answer's undo window, without faking the clock the claim compares not_before against
		db.prepare('UPDATE runs SET not_before = NULL WHERE id = ?').run(resumed);
		runner.wake();
		await vi.waitFor(() => expect(s.state(resumed)).toBe('running'));
		fake.call(resumed).io.emit({ type: 'log', payload: { kind: 'prompt' } }); // no sign of life

		await lose(socket);
		vi.advanceTimersByTime(DEADLINE_MS);
		await flush();

		expect(s.error(resumed)).toMatch(/^\[runner_disconnected\] /);
		expect(collected()).toBeNull();
		const next = runs.createRun(db, user, { ticketId, profileId: s.cloud }).id;
		const prompt = assemblePrompt(db, {
			id: next,
			ticketId,
			profile: runs.getProfile(db, s.cloud)
		}).user;
		expect(prompt).toContain('Answer: 2. Only id and title');
	});
});
