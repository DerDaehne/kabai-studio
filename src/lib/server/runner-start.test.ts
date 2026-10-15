import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { migrate, openDb } from './db';
import { disconnectRunner, issuePairingCode, pairRunner } from './domain/runners';
import { createRunnerChannel, type RunnerChannel } from './runner-channel';
import { CREDENTIAL_FILE, FLOOR_FILE } from './runner-pair';
import { CLOSE, DEAD_AFTER_MS } from './runner-protocol';
import {
	MAX_BACKOFF_MS,
	MIN_BACKOFF_MS,
	runnerStartCommand,
	type StartContext
} from './runner-start';

let home: string;
let configDir: string;
let workspaceDir: string;
let lines: string[];
let stop: AbortController;
const servers: Server[] = [];
const channels: RunnerChannel[] = [];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'studio-runner-start-'));
	configDir = join(home, 'config', 'kabai-studio');
	workspaceDir = join(home, 'private-workspace');
	mkdirSync(workspaceDir);
	lines = [];
	stop = new AbortController();
});

afterEach(async () => {
	vi.useRealTimers();
	stop.abort();
	for (const channel of channels.splice(0)) channel.close();
	await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
	rmSync(home, { recursive: true, force: true });
});

const ctx = (extra: Partial<StartContext> = {}): StartContext => ({
	env: { HOME: home, XDG_CONFIG_HOME: join(home, 'config') },
	platform: 'linux',
	locale: 'en',
	version: '9.9.9',
	log: (line) => lines.push(line),
	signal: stop.signal,
	random: () => 0,
	...extra
});

/** What `runner pair` leaves behind, with a floor that has a private path and a command studio must never learn. */
function writeConfig(origin: string, credential = 'c'.repeat(43)) {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, CREDENTIAL_FILE),
		JSON.stringify({ studioOrigin: origin, name: 'workstation', credential })
	);
	writeFileSync(
		join(configDir, FLOOR_FILE),
		JSON.stringify({
			studioOrigin: origin,
			slots: 3,
			workspaces: { site: { path: workspaceDir } },
			agents: { claude: { command: 'secret-agent-binary', args: ['--token=abc'] } }
		})
	);
}

async function listen(server: Server, port = 0) {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
	return (server.address() as AddressInfo).port;
}

/** A real studio channel over a database of its own. */
async function studio(port = 0) {
	const db = openDb(':memory:');
	migrate(db);
	return startChannel(db, port);
}

async function startChannel(db: ReturnType<typeof openDb>, port = 0) {
	const channel = createRunnerChannel(db, { origin: () => 'http://127.0.0.1:3000' });
	channels.push(channel);
	const server = createServer().on('upgrade', channel.handleUpgrade);
	const actual = await listen(server, port);
	const pair = (name = 'workstation') => {
		const { code } = issuePairingCode();
		return pairRunner(db, { code, name });
	};
	return { db, channel, server, port: actual, origin: `http://127.0.0.1:${actual}`, pair };
}

/** A server that answers every upgrade with a fixed status, to play studio versions and proxies. */
async function refusingStudio(status: number, body: object) {
	const text = JSON.stringify(body);
	const server = createServer().on('upgrade', (_request, socket) =>
		socket.end(
			`HTTP/1.1 ${status} X\r\ncontent-length: ${text.length}\r\nconnection: close\r\n\r\n${text}`
		)
	);
	const port = await listen(server);
	return `http://127.0.0.1:${port}`;
}

const trackedSockets = () => {
	const urls: string[] = [];
	const sent: string[] = [];
	return {
		urls,
		sent,
		createSocket: (url: string, headers: Record<string, string>) => {
			urls.push(url);
			const socket = new WebSocket(url, { headers });
			const send = socket.send.bind(socket) as (data: string) => void;
			socket.send = ((data: string) => (sent.push(data), send(data))) as typeof socket.send;
			return socket;
		}
	};
};

const everything = (...texts: string[]) => texts.join('\n');

describe('start-up checks', () => {
	it('tells a machine that was never paired how to pair it', async () => {
		const result = await runnerStartCommand(ctx());
		expect(result.exitCode).toBe(1);
		expect(result.message).toMatch(/^\[not_paired\] /);
		expect(result.message).toContain('kabai-studio runner pair');
	});

	it('refuses ws:// to a studio that is not on this machine, with the way out', async () => {
		writeConfig('http://studio.example');
		const createSocket = vi.fn();
		const result = await runnerStartCommand(ctx({ createSocket }));
		expect(result.exitCode).toBe(1);
		expect(result.message).toMatch(/^\[insecure_url\] /);
		expect(result.message).toContain('https://');
		expect(createSocket).not.toHaveBeenCalled();
	});

	it('names the field of a broken runner.json before it connects', async () => {
		const { origin } = await studio();
		writeConfig(origin);
		writeFileSync(join(configDir, FLOOR_FILE), JSON.stringify({ studioOrigin: origin, slots: 0 }));
		const createSocket = vi.fn();
		const result = await runnerStartCommand(ctx({ createSocket }));
		expect(result.message).toMatch(/^\[runner_json_invalid\] /);
		expect(result.message).toContain('slots');
		expect(createSocket).not.toHaveBeenCalled();
	});

	it('speaks the catalogue language', async () => {
		const result = await runnerStartCommand(ctx({ locale: 'de' }));
		expect(result.message).toContain('noch nicht gekoppelt');
	});
});

describe('hello', () => {
	it('carries only keys, numbers and the version, never a path or a command', async () => {
		const { origin, pair, channel } = await studio();
		const runner = pair();
		writeConfig(origin, runner.credential);
		const sockets = trackedSockets();
		const running = runnerStartCommand(ctx({ createSocket: sockets.createSocket }));
		await vi.waitFor(() => expect(channel.connected().get('workstation')).toBeDefined());

		expect(JSON.parse(sockets.sent[0])).toEqual({
			type: 'hello',
			protocol: 1,
			version: '9.9.9',
			slots: 3,
			workspaces: ['site'],
			agents: ['claude']
		});
		expect(sockets.sent.join('')).not.toContain(workspaceDir);
		expect(sockets.sent.join('')).not.toContain('secret-agent-binary');
		stop.abort();
		expect((await running).exitCode).toBe(0);
	});

	it('never sends or logs the credential beyond the Authorization header', async () => {
		const { origin, pair, channel } = await studio();
		const runner = pair();
		writeConfig(origin, runner.credential);
		const sockets = trackedSockets();
		const running = runnerStartCommand(ctx({ createSocket: sockets.createSocket }));
		await vi.waitFor(() => expect(channel.connected().size).toBe(1));
		stop.abort();
		const result = await running;
		expect(everything(...sockets.sent, ...sockets.urls, ...lines, result.message)).not.toContain(
			runner.credential
		);
	});
});

describe('refusals end the runner', () => {
	it('exits on 401 for an unknown credential and does not loop', async () => {
		const { origin } = await studio();
		writeConfig(origin, 'u'.repeat(43));
		const sockets = trackedSockets();
		const result = await runnerStartCommand(ctx({ createSocket: sockets.createSocket }));
		expect(result.exitCode).toBe(1);
		expect(result.message).toMatch(/^\[credential_rejected\] /);
		expect(result.message).toContain(`kabai-studio runner pair ${origin} <code>`);
		expect(sockets.urls).toHaveLength(1);
	});

	it('exits when the credential was revoked while the runner is away', async () => {
		const { origin, pair, db } = await studio();
		const runner = pair();
		disconnectRunner(db, runner.id);
		writeConfig(origin, runner.credential);
		const result = await runnerStartCommand(ctx());
		expect(result.message).toMatch(/^\[credential_rejected\] /);
	});

	it('exits at once when studio disconnects the machine, without a reconnect loop', async () => {
		const { origin, pair, db, channel } = await studio();
		const runner = pair();
		writeConfig(origin, runner.credential);
		const sockets = trackedSockets();
		const running = runnerStartCommand(ctx({ createSocket: sockets.createSocket }));
		await vi.waitFor(() => expect(channel.connected().size).toBe(1));

		disconnectRunner(db, runner.id);
		channel.revoke('workstation');
		const result = await running;
		expect(result.exitCode).toBe(1);
		expect(result.message).toMatch(/^\[credential_revoked\] /);
		expect(result.message).toContain(`kabai-studio runner pair ${origin} <code>`);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(sockets.urls).toHaveLength(1);
	});

	it.each([
		['browser_origin_forbidden', 'browser Origin'],
		['insecure_transport', 'only over https'],
		['whatever', 'refused the connection']
	])('explains a 403 (%s) with a way out and ends', async (code, phrase) => {
		const origin = await refusingStudio(403, { code });
		writeConfig(origin);
		const result = await runnerStartCommand(ctx());
		expect(result.exitCode).toBe(1);
		expect(result.message).toContain(phrase);
		expect(result.message).toMatch(/kabai-studio runner start/);
	});

	it('exits when studio speaks another protocol, telling who to update', async () => {
		const server = createServer();
		const wss = new WebSocketServer({ noServer: true });
		server.on('upgrade', (request, socket, head) =>
			wss.handleUpgrade(request, socket, head, (ws) =>
				ws.close(CLOSE.badProtocol, 'protocol_1_required')
			)
		);
		const port = await listen(server);
		writeConfig(`http://127.0.0.1:${port}`);
		const result = await runnerStartCommand(ctx());
		expect(result.message).toMatch(/^\[protocol_mismatch\] /);
		expect(result.message).toContain('Update studio');
		wss.close();
	});
});

describe('frames from the server', () => {
	it('accepts welcome only: any other frame is logged as frame_not_supported and closes the connection', async () => {
		const server = createServer();
		const wss = new WebSocketServer({ noServer: true });
		const closes: number[] = [];
		server.on('upgrade', (request, socket, head) =>
			wss.handleUpgrade(request, socket, head, (ws) => {
				ws.on('close', (code) => closes.push(code));
				ws.on('message', () => {
					ws.send(JSON.stringify({ type: 'welcome', name: 'workstation' }));
					ws.send(JSON.stringify({ type: 'spawn', command: 'rm -rf /' }));
				});
			})
		);
		const port = await listen(server);
		writeConfig(`http://127.0.0.1:${port}`);
		const floorBefore = readFileSync(join(configDir, FLOOR_FILE), 'utf8');

		const running = runnerStartCommand(ctx());
		await vi.waitFor(() => expect(closes).toEqual([1008]));
		expect(lines.some((line) => line.includes('[frame_not_supported]'))).toBe(true);
		expect(readFileSync(join(configDir, FLOOR_FILE), 'utf8')).toBe(floorBefore);
		stop.abort();
		await running;
		wss.close();
	});

	it('does not count a first frame other than welcome as connected', async () => {
		const server = createServer();
		const wss = new WebSocketServer({ noServer: true });
		const closes: number[] = [];
		server.on('upgrade', (request, socket, head) =>
			wss.handleUpgrade(request, socket, head, (ws) => {
				ws.on('close', (code) => closes.push(code));
				ws.on('message', () => ws.send(JSON.stringify({ type: 'prepare', workspace: 'site' })));
			})
		);
		writeConfig(`http://127.0.0.1:${await listen(server)}`);
		const running = runnerStartCommand(ctx());
		await vi.waitFor(() => expect(closes).toEqual([1008]));
		expect(lines.some((line) => line.startsWith('Connected'))).toBe(false);
		stop.abort();
		await running;
		wss.close();
	});

	it('treats a second welcome like any other unsupported frame', async () => {
		const server = createServer();
		const wss = new WebSocketServer({ noServer: true });
		const closes: number[] = [];
		server.on('upgrade', (request, socket, head) =>
			wss.handleUpgrade(request, socket, head, (ws) => {
				ws.on('close', (code) => closes.push(code));
				ws.on('message', () => {
					ws.send(JSON.stringify({ type: 'welcome', name: 'a' }));
					ws.send(JSON.stringify({ type: 'welcome', name: 'a' }));
				});
			})
		);
		writeConfig(`http://127.0.0.1:${await listen(server)}`);
		const running = runnerStartCommand(ctx());
		await vi.waitFor(() => expect(closes).toEqual([1008]));
		stop.abort();
		await running;
		wss.close();
	});
});

describe('reconnect', () => {
	it('connects again by itself after the server restarted, and studio sees it connected', async () => {
		const first = await studio();
		const runner = first.pair();
		writeConfig(first.origin, runner.credential);
		const running = runnerStartCommand(ctx());
		await vi.waitFor(() => expect(first.channel.connected().size).toBe(1));

		first.channel.close();
		await new Promise((resolve) => first.server.close(resolve));
		const second = await startChannel(first.db, first.port);
		await vi.waitFor(() => expect(second.channel.connected().get('workstation')).toBeDefined(), {
			timeout: 5000
		});
		expect(lines.filter((line) => line.startsWith('Connection lost')).length).toBeGreaterThan(0);
		stop.abort();
		await running;
	});
});

/** A socket the test drives by hand; it never touches the network. */
class FakeSocket extends EventEmitter {
	sent: string[] = [];
	terminated = false;
	send = (data: string) => void this.sent.push(data);
	close = (code?: number) => this.emit('close', code ?? 1005, Buffer.alloc(0));
	terminate = () => {
		this.terminated = true;
		this.emit('close', 1006, Buffer.alloc(0));
	};
}

function fakeNetwork() {
	const sockets: FakeSocket[] = [];
	const openedAt: number[] = [];
	return {
		sockets,
		openedAt,
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			openedAt.push(Date.now());
			return socket as unknown as WebSocket;
		}
	};
}

describe('timers', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		writeConfig('http://127.0.0.1:3000');
	});

	it('treats 30 s without a ping or a frame as a lost connection and reconnects', async () => {
		const network = fakeNetwork();
		const running = runnerStartCommand(
			ctx({ createSocket: network.createSocket, random: () => 0 })
		);
		network.sockets[0].emit('open');
		vi.advanceTimersByTime(DEAD_AFTER_MS - 1);
		expect(network.sockets[0].terminated).toBe(false);
		vi.advanceTimersByTime(1);
		expect(network.sockets[0].terminated).toBe(true);
		vi.advanceTimersByTime(MIN_BACKOFF_MS);
		expect(network.sockets).toHaveLength(2);
		stop.abort();
		await running;
	});

	it('keeps a connection alive while pings and frames arrive', async () => {
		const network = fakeNetwork();
		const running = runnerStartCommand(ctx({ createSocket: network.createSocket }));
		const socket = network.sockets[0];
		socket.emit('open');
		for (let round = 0; round < 6; round++) {
			vi.advanceTimersByTime(DEAD_AFTER_MS - 1000);
			socket.emit(round % 2 ? 'ping' : 'message', Buffer.from('{"type":"welcome"}'));
		}
		expect(socket.terminated).toBe(false);
		stop.abort();
		await running;
	});

	it('backs off from 1 s up to 30 s and starts over after a welcome', async () => {
		const network = fakeNetwork();
		const running = runnerStartCommand(
			ctx({ createSocket: network.createSocket, random: () => 1 })
		);
		const waits: number[] = [];
		for (let attempt = 0; attempt < 8; attempt++) {
			const before = Date.now();
			network.sockets.at(-1)!.emit('close', 1006, Buffer.alloc(0));
			const count = network.sockets.length;
			while (network.sockets.length === count) vi.advanceTimersByTime(100);
			waits.push(Date.now() - before);
		}
		expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
		expect(MAX_BACKOFF_MS).toBe(30_000);

		const socket = network.sockets.at(-1)!;
		socket.emit('open');
		socket.emit('message', Buffer.from(JSON.stringify({ type: 'welcome', name: 'workstation' })));
		const before = Date.now();
		socket.emit('close', 1006, Buffer.alloc(0));
		const count = network.sockets.length;
		while (network.sockets.length === count) vi.advanceTimersByTime(100);
		expect(Date.now() - before).toBe(1000);
		stop.abort();
		await running;
	});

	it('jitters the wait but never beyond the ceiling', async () => {
		for (const [random, expected] of [
			[0, 500],
			[0.5, 750]
		] as const) {
			const network = fakeNetwork();
			const running = runnerStartCommand(
				ctx({ createSocket: network.createSocket, random: () => random })
			);
			network.sockets[0].emit('close', 1006, Buffer.alloc(0));
			const before = Date.now();
			while (network.sockets.length === 1) vi.advanceTimersByTime(10);
			expect(Date.now() - before).toBe(expected);
			stop.abort();
			await running;
			stop = new AbortController();
		}
	});
});
