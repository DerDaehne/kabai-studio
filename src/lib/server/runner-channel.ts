// The server end of the runner channel: a WebSocket on /runner that only a paired machine may open. adapter-node's
// handler never sees an upgrade request, so this runs from a 'server.on("upgrade")' hook that server.ts attaches.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, type WebSocket } from 'ws';
import { isLoopbackHost } from './auth';
import { runnerByCredential } from './domain/runners';
import { publish } from './events';

import { CLOSE, DEAD_AFTER_MS, PROTOCOL_VERSION, RUNNER_PATH } from './runner-protocol';

export const PING_INTERVAL_MS = 10_000;
export const HELLO_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_KEYS = 200;
const MAX_KEY_LENGTH = 128;

export type ConnectedRunner = {
	connectedAt: number;
	slots: number;
	workspaces: string[];
	agents: string[];
	version: string;
};

export type RunnerChannel = {
	handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
	connected: () => ReadonlyMap<string, ConnectedRunner>;
	/** Closes the open socket of a runner whose credential was just revoked. */
	revoke: (name: string) => void;
	close: () => void;
};

type Hello = Omit<ConnectedRunner, 'connectedAt'> & { protocol: number };

const refuse = (socket: Duplex, status: 401 | 403 | 404, code: string) => {
	const body = JSON.stringify({ code });
	socket.end(
		`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'}\r\n` +
			`content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
			`cache-control: no-store\r\nconnection: close\r\n\r\n${body}`
	);
};

const bearer = (request: IncomingMessage): string | null => {
	const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
	return match ? match[1] : null;
};

const keyList = (value: unknown): string[] | null =>
	Array.isArray(value) &&
	value.length <= MAX_KEYS &&
	value.every((key) => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH)
		? value
		: null;

/** Null unless the frame is a well-formed `hello`; only keys, numbers and the version are ever accepted. */
function parseHello(data: string): Hello | null {
	let frame: Record<string, unknown>;
	try {
		frame = JSON.parse(data);
	} catch {
		return null;
	}
	const { type, protocol, version, slots, workspaces, agents } = frame ?? {};
	const workspaceKeys = keyList(workspaces);
	const agentKeys = keyList(agents);
	if (
		type !== 'hello' ||
		typeof protocol !== 'number' ||
		typeof version !== 'string' ||
		version.length > MAX_KEY_LENGTH ||
		!Number.isInteger(slots) ||
		(slots as number) < 1 ||
		!workspaceKeys ||
		!agentKeys
	)
		return null;
	return {
		protocol,
		version,
		slots: slots as number,
		workspaces: workspaceKeys,
		agents: agentKeys
	};
}

class Channel implements RunnerChannel {
	private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
	private readonly runners = new Map<string, ConnectedRunner>();
	private readonly sockets = new Map<string, WebSocket>();
	private readonly db: DatabaseSync;
	private readonly origin: () => string | undefined;

	constructor(db: DatabaseSync, origin: () => string | undefined) {
		this.db = db;
		this.origin = origin;
	}

	connected = () => this.runners;

	// An arrow property, because it is handed to server.on('upgrade') detached from this object.
	handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		socket.on('error', () => socket.destroy());
		if (new URL(request.url ?? '/', 'http://studio').pathname !== RUNNER_PATH)
			return refuse(socket, 404, 'not_found');
		// A browser always sends Origin on a WebSocket; the runner is no browser, so any Origin is a page after the credential.
		if ('origin' in request.headers) return refuse(socket, 403, 'browser_origin_forbidden');
		if (this.plainRemote()) return refuse(socket, 403, 'insecure_transport');
		const credential = bearer(request);
		const runner = credential === null ? null : runnerByCredential(this.db, credential);
		if (runner === null) return refuse(socket, 401, 'credential_rejected');
		this.wss.handleUpgrade(request, socket, head, (ws) => this.admit(ws, runner.name));
	};

	revoke(name: string) {
		this.sockets.get(name)?.close(CLOSE.revoked, 'credential_revoked');
	}

	close() {
		for (const socket of this.sockets.values()) socket.terminate();
		this.wss.close();
	}

	// The credential never travels in clear text to a remote studio; ORIGIN is what the operator says studio is.
	private plainRemote() {
		const url = URL.parse(this.origin() ?? '');
		return url !== null && url.protocol === 'http:' && !isLoopbackHost(url.hostname);
	}

	// Runs inside socket events, where a throw would take the whole server down; a missed stamp only shows a stale time.
	private touchLastSeen(name: string) {
		try {
			this.db.prepare("UPDATE runners SET last_seen_at = datetime('now') WHERE name = ?").run(name);
		} catch (err) {
			console.error('runner channel: could not store last seen', err);
		}
	}

	private admit(socket: WebSocket, name: string) {
		let lastHeard = Date.now();
		const heard = () => (lastHeard = Date.now());
		const helloTimer = setTimeout(
			() => socket.close(CLOSE.badFrame, 'hello_timeout'),
			HELLO_TIMEOUT_MS
		);
		const pinger = setInterval(() => {
			if (Date.now() - lastHeard >= DEAD_AFTER_MS) return socket.terminate();
			socket.ping();
		}, PING_INTERVAL_MS);
		let greeted = false;

		socket.on('pong', heard);
		socket.on('message', (data, isBinary) => {
			heard();
			const hello = greeted ? null : parseHello(isBinary ? '' : data.toString());
			if (hello === null) return socket.close(CLOSE.badFrame, 'frame_not_supported');
			if (hello.protocol !== PROTOCOL_VERSION)
				return socket.close(CLOSE.badProtocol, `protocol_${PROTOCOL_VERSION}_required`);
			greeted = true;
			clearTimeout(helloTimer);
			this.register(socket, name, hello);
		});
		socket.on('close', () => {
			clearTimeout(helloTimer);
			clearInterval(pinger);
			this.unregister(socket, name);
		});
		socket.on('error', () => socket.terminate());
	}

	private register(socket: WebSocket, name: string, hello: Hello) {
		this.sockets.get(name)?.close(CLOSE.replaced, 'replaced');
		this.sockets.set(name, socket);
		const { protocol: _protocol, ...summary } = hello;
		this.runners.set(name, { connectedAt: Date.now(), ...summary });
		this.touchLastSeen(name);
		publish({ type: 'machine.connected', actor: { kind: 'system' }, name });
		socket.send(JSON.stringify({ type: 'welcome', name }));
	}

	private unregister(socket: WebSocket, name: string) {
		if (this.sockets.get(name) !== socket) return;
		this.sockets.delete(name);
		this.runners.delete(name);
		this.touchLastSeen(name);
		publish({ type: 'machine.disconnected', actor: { kind: 'system' }, name });
	}
}

export const createRunnerChannel = (
	db: DatabaseSync,
	{ origin = () => process.env.ORIGIN }: { origin?: () => string | undefined } = {}
): RunnerChannel => new Channel(db, origin);

let installed: RunnerChannel | null = null;
const none: RunnerChannel = {
	handleUpgrade: (_request, socket) => refuse(socket, 404, 'not_found'),
	connected: () => new Map(),
	revoke: () => {},
	close: () => {}
};

/** Called once by the init hook; server.ts attaches the handler to the HTTP server after the bundle has loaded. */
export const installRunnerChannel = (db: DatabaseSync): RunnerChannel => {
	installed?.close();
	return (installed = createRunnerChannel(db));
};

/** The installed channel, or an empty one where none runs (vite dev, tests). */
export const runnerChannel = (): RunnerChannel => installed ?? none;
