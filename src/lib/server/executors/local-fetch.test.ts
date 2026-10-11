import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLD_START_LIMITS } from '../../agents/model-catalog';
import { createLocalFetch } from './local-fetch';

const fetchBeforeImports = vi.hoisted(() => globalThis.fetch);
const servers: Server[] = [];

async function slowServer() {
	let respond = () => {};
	let requestSeen = () => {};
	const received = new Promise<void>((seen) => (requestSeen = seen));
	const server = createServer((_, response) => {
		respond = () => response.writeHead(200).end('loaded');
		requestSeen();
	});
	servers.push(server);
	await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	return { url, received, answer: () => respond() };
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

	it('leaves the process-wide fetch untouched', () => {
		expect(globalThis.fetch).toBe(fetchBeforeImports);
	});
});
