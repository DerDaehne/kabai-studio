import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, isLiveConnection, open, test } from './fixtures.ts';

type LiveStreamCounter = { origin: string; open: () => number; close: () => Promise<void> };

/**
 * A proxy in front of the server that counts the live connections still open on the wire. The browser cannot report
 * them: it sends no network events for a page in the back/forward cache, and that page is where a stream would leak.
 */
async function countLiveStreams(target: string): Promise<LiveStreamCounter> {
	let openStreams = 0;
	const server = createServer((incoming, outgoing) => {
		if (isLiveConnection(new URL(incoming.url!, target).href)) {
			openStreams++;
			outgoing.on('close', () => openStreams--);
		}
		forward(target, incoming, outgoing);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		open: () => openStreams,
		close: () => {
			server.closeAllConnections();
			return new Promise((resolve) => server.close(() => resolve()));
		}
	};
}

function forward(target: string, incoming: IncomingMessage, outgoing: ServerResponse) {
	const upstream = request(new URL(incoming.url!, target), {
		method: incoming.method,
		headers: incoming.headers
	});
	upstream.on('response', (response) => {
		outgoing.writeHead(response.statusCode!, response.headers);
		response.pipe(outgoing);
	});
	upstream.on('error', () => outgoing.destroy());
	outgoing.on('close', () => upstream.destroy());
	incoming.pipe(upstream);
}

const proxiedTest = test.extend<{ streams: LiveStreamCounter }>({
	streams: async ({ baseURL }, use) => {
		const streams = await countLiveStreams(baseURL!);
		await use(streams);
		await streams.close();
	}
});

proxiedTest(
	'ten full navigations leave exactly one live connection open, also after a page returns from the back/forward cache',
	async ({ page, streams }) => {
		await page.addInitScript(() =>
			addEventListener('pageshow', (event) => {
				document.documentElement.dataset.restoredFromCache = String(event.persisted);
			})
		);
		const paths = ['/', '/takt', '/board', '/settings'];

		for (let navigation = 0; navigation < 10; navigation++) {
			await open(page, streams.origin + paths[navigation % paths.length]);
			await expect.poll(streams.open).toBe(1);
		}

		const reconnected = page.waitForResponse((response) => isLiveConnection(response.url()));
		await page.goBack({ waitUntil: 'commit' });
		await expect(page.locator('html')).toHaveAttribute('data-restored-from-cache', 'true');
		await reconnected;
		await expect.poll(streams.open).toBe(1);
	}
);
