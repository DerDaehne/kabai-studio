import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { migrate, openDb } from './db';
import { disconnectRunner, issuePairingCode, pairRunner } from './domain/runners';
import { subscribe, type StudioEvent } from './events';
import { createRunnerChannel, PING_INTERVAL_MS, type RunnerChannel } from './runner-channel';
import { CLOSE, DEAD_AFTER_MS } from './runner-protocol';

let db: ReturnType<typeof openDb>;
let server: Server;
let channel: RunnerChannel;
let port: number;
let origin: string | undefined;
let events: StudioEvent[];
let unsubscribe: () => void;
const sockets: WebSocket[] = [];

beforeEach(async () => {
	db = openDb(':memory:');
	migrate(db);
	origin = 'http://127.0.0.1:3000';
	channel = createRunnerChannel(db, { origin: () => origin });
	server = createServer().on('upgrade', channel.handleUpgrade);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = (server.address() as AddressInfo).port;
	events = [];
	unsubscribe = subscribe((event) => events.push(event));
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	unsubscribe();
	for (const socket of sockets.splice(0)) socket.terminate();
	channel.close();
	await new Promise((resolve) => server.close(resolve));
	db.close();
});

const pair = (name = 'workstation') => {
	const { code } = issuePairingCode();
	return pairRunner(db, { code, name });
};

const HELLO = {
	type: 'hello',
	protocol: 1,
	version: '1.2.3',
	slots: 2,
	workspaces: ['site'],
	agents: ['claude']
};

type Attempt = { headers?: Record<string, string>; autoPong?: boolean };

/** The status and body of a refused upgrade, or the open socket of an accepted one. */
function attempt({ headers = {}, autoPong }: Attempt) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/runner`, {
		headers,
		...(autoPong === undefined ? {} : { autoPong })
	});
	sockets.push(socket);
	return new Promise<
		{ status: 101; socket: WebSocket } | { status: number; body: string; socket: WebSocket }
	>((resolve, reject) => {
		socket.on('open', () => resolve({ status: 101, socket }));
		socket.on('unexpected-response', (_request, response) => {
			let body = '';
			response.on('data', (chunk: Buffer) => (body += chunk.toString()));
			response.on('end', () => resolve({ status: response.statusCode ?? 0, body, socket }));
		});
		socket.on('error', reject);
	});
}

const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` });
const nextMessage = (socket: WebSocket) =>
	new Promise<string>((resolve) => socket.once('message', (data) => resolve(data.toString())));
const closed = (socket: WebSocket) =>
	new Promise<{ code: number; reason: string }>((resolve) =>
		socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
	);

async function join(runner = pair(), hello: unknown = HELLO) {
	const result = await attempt({ headers: bearer(runner.credential) });
	if (result.status !== 101) throw new Error(`refused with ${result.status}`);
	const welcome = nextMessage(result.socket);
	result.socket.send(JSON.stringify(hello));
	return { socket: result.socket, welcome: await welcome, runner };
}

describe('upgrade', () => {
	it('answers 401 without a credential', async () => {
		expect(await attempt({})).toMatchObject({ status: 401 });
	});

	it('answers 401 for a wrong credential', async () => {
		pair();
		expect(await attempt({ headers: bearer('x'.repeat(43)) })).toMatchObject({ status: 401 });
	});

	it('answers 401 for a credential that was revoked', async () => {
		const runner = pair();
		disconnectRunner(db, runner.id);
		expect(await attempt({ headers: bearer(runner.credential) })).toMatchObject({ status: 401 });
	});

	it('answers 403 to a browser Origin even with a valid credential', async () => {
		const runner = pair();
		const result = await attempt({
			headers: { ...bearer(runner.credential), origin: 'https://evil.example' }
		});
		expect(result).toMatchObject({ status: 403 });
		expect(JSON.parse((result as { body: string }).body).code).toBe('browser_origin_forbidden');
	});

	it('refuses a remote studio that is not behind https', async () => {
		origin = 'http://studio.example';
		const runner = pair();
		expect(await attempt({ headers: bearer(runner.credential) })).toMatchObject({ status: 403 });
	});

	it('accepts a valid credential with 101', async () => {
		const runner = pair();
		expect(await attempt({ headers: bearer(runner.credential) })).toMatchObject({ status: 101 });
	});

	it('answers 404 on any other path', async () => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/elsewhere`).on('error', () => {});
		sockets.push(socket);
		const status = await new Promise((resolve) =>
			socket.on('unexpected-response', (_request, response) => resolve(response.statusCode))
		);
		expect(status).toBe(404);
	});
});

describe('hello and welcome', () => {
	it('welcomes with the machine name, registers it and publishes the connection', async () => {
		const { welcome } = await join();
		expect(JSON.parse(welcome)).toEqual({ type: 'welcome', name: 'workstation' });
		const entry = channel.connected().get('workstation');
		expect(entry).toMatchObject({
			slots: 2,
			workspaces: ['site'],
			agents: ['claude'],
			version: '1.2.3'
		});
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'machine.connected', name: 'workstation' })
		);
		const row = db.prepare('SELECT last_seen_at FROM runners').get() as {
			last_seen_at: string | null;
		};
		expect(row.last_seen_at).not.toBeNull();
	});

	it('forgets the machine, stamps last seen and publishes when it drops', async () => {
		const { socket } = await join();
		db.prepare('UPDATE runners SET last_seen_at = NULL').run();
		socket.close();
		await closed(socket);
		await vi.waitFor(() => expect(channel.connected().size).toBe(0));
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'machine.disconnected', name: 'workstation' })
		);
		const row = db.prepare('SELECT last_seen_at FROM runners').get() as {
			last_seen_at: string | null;
		};
		expect(row.last_seen_at).not.toBeNull();
	});

	it.each([
		['text that is not JSON', 'hello'],
		['another frame type', JSON.stringify({ type: 'spawn', command: 'rm -rf /' })],
		['a hello with a path in it', JSON.stringify({ ...HELLO, workspaces: [{ path: '/home' }] })],
		['a hello with zero slots', JSON.stringify({ ...HELLO, slots: 0 })]
	])('closes the connection on %s', async (_label, frame) => {
		const result = await attempt({ headers: bearer(pair().credential) });
		const end = closed(result.socket);
		result.socket.send(frame);
		expect((await end).code).toBe(CLOSE.badFrame);
		expect(channel.connected().size).toBe(0);
	});

	it('closes the connection on a binary frame', async () => {
		const result = await attempt({ headers: bearer(pair().credential) });
		const end = closed(result.socket);
		result.socket.send(Buffer.from(JSON.stringify(HELLO)));
		expect((await end).code).toBe(CLOSE.badFrame);
	});

	it('closes the connection on any frame after hello', async () => {
		const { socket } = await join();
		const end = closed(socket);
		socket.send(JSON.stringify(HELLO));
		expect((await end).code).toBe(CLOSE.badFrame);
		await vi.waitFor(() => expect(channel.connected().size).toBe(0));
	});

	it('closes a different protocol version with its own code', async () => {
		const result = await attempt({ headers: bearer(pair().credential) });
		const end = closed(result.socket);
		result.socket.send(JSON.stringify({ ...HELLO, protocol: 2 }));
		expect((await end).code).toBe(CLOSE.badProtocol);
		expect(channel.connected().size).toBe(0);
	});

	it('replaces an older connection of the same machine', async () => {
		const runner = pair();
		const first = await join(runner);
		const replaced = closed(first.socket);
		await join(runner);
		expect((await replaced).code).toBe(CLOSE.replaced);
		expect(channel.connected().size).toBe(1);
	});
});

describe('revoking', () => {
	it('closes the open socket at once', async () => {
		const { socket } = await join();
		const end = closed(socket);
		channel.revoke('workstation');
		expect((await end).code).toBe(CLOSE.revoked);
	});
});

// vi.waitFor would move the faked clock on its own, so these tests poll with the real setTimeout.
async function until(condition: () => boolean) {
	for (let tries = 0; tries < 200 && !condition(); tries++)
		await new Promise((resolve) => setTimeout(resolve, 10));
	expect(condition()).toBe(true);
}

describe('heartbeat', () => {
	it('drops a peer that stays silent within 30 s', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
		const result = await attempt({ headers: bearer(pair().credential), autoPong: false });
		result.socket.send(JSON.stringify(HELLO));
		await until(() => channel.connected().size === 1);
		const end = closed(result.socket);

		vi.advanceTimersByTime(DEAD_AFTER_MS - PING_INTERVAL_MS);
		expect(channel.connected().size).toBe(1);
		vi.advanceTimersByTime(PING_INTERVAL_MS);
		expect((await end).code).toBe(1006);
		await until(() => channel.connected().size === 0);
	});

	it('keeps a peer that answers', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
		const { socket } = await join();
		let pings = 0;
		socket.on('ping', () => pings++);
		for (let round = 1; round <= 4; round++) {
			vi.advanceTimersByTime(PING_INTERVAL_MS);
			await until(() => pings === round);
			await new Promise((resolve) => setTimeout(resolve, 30)); // the pong travels back
		}
		expect(channel.connected().size).toBe(1);
	});
});

describe('secrets', () => {
	it('never sends the credential back and never logs it', async () => {
		const logged: string[] = [];
		for (const method of ['log', 'error', 'warn', 'info'] as const)
			vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args.join(' ')));
		const runner = pair();
		const refused = await attempt({
			headers: { ...bearer(runner.credential), origin: 'https://x.example' }
		});
		const { welcome } = await join(runner);
		const wrong = await attempt({ headers: bearer(`${runner.credential}x`) });

		const seen = [
			(refused as { body: string }).body,
			welcome,
			(wrong as { body: string }).body,
			...logged,
			JSON.stringify(events)
		];
		for (const text of seen) expect(text).not.toContain(runner.credential);
	});
});
