import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLD_START_LIMITS } from '../../agents/model-catalog';
import { createLocalFetch } from './local-fetch';

const fetchBeforeImports = vi.hoisted(() => globalThis.fetch);
// undici runs body timeouts on its own clock, which fake timers do not move; its test hook does (a timer starts on one tick and expires on a later one)
const undiciFastTimers: { tick(ms: number): void } = createRequire(import.meta.url)(
	'undici/lib/util/timers.js'
);
const servers: Server[] = [];

async function slowServer() {
	let respond = () => {};
	let requestSeen = () => {};
	let flushHeaders = () => {};
	let sendBody = () => {};
	const received = new Promise<void>((seen) => (requestSeen = seen));
	const server = createServer((_, response) => {
		respond = () => response.writeHead(200).end('loaded');
		flushHeaders = () => response.writeHead(200).flushHeaders();
		sendBody = () => response.end('loaded');
		requestSeen();
	});
	servers.push(server);
	await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	return {
		url,
		received,
		answer: () => respond(),
		flushHeaders: () => flushHeaders(),
		sendBody: () => sendBody()
	};
}

type SlowServer = Awaited<ReturnType<typeof slowServer>>;

/** The wait for headers starts only once the server has the request, so the clock moves after that. */
async function startRequest(localFetch: typeof fetch, server: SlowServer) {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	const response = localFetch(server.url);
	await server.received;
	return { response };
}

afterEach(() => {
	vi.useRealTimers();
	servers.splice(0).forEach((server) => {
		server.closeAllConnections();
		server.close();
	});
});

describe('local provider fetch', () => {
	it('waits for response headers through the whole cold start limit, far beyond the Node default of five minutes', async () => {
		const server = await slowServer();
		const { response } = await startRequest(
			createLocalFetch(COLD_START_LIMITS.failAfterMs),
			server
		);
		await vi.advanceTimersByTimeAsync(COLD_START_LIMITS.failAfterMs);
		server.answer();

		await expect((await response).text()).resolves.toBe('loaded');
	});

	it('waits for the response body past the Node default of five minutes when the headers came at once', async () => {
		const server = await slowServer();
		const { response } = await startRequest(
			createLocalFetch(COLD_START_LIMITS.failAfterMs),
			server
		);
		server.flushHeaders();
		const answer = await response;
		undiciFastTimers.tick(400_000);
		undiciFastTimers.tick(400_000);
		server.sendBody();

		await expect(answer.text()).resolves.toBe('loaded');
	});

	it('leaves the process-wide fetch untouched', () => {
		expect(globalThis.fetch).toBe(fetchBeforeImports);
	});
});
