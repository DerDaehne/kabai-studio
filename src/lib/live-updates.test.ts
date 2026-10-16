import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectLiveUpdates } from './live-updates';
import { connection } from './shell/connection.svelte';

/** Replaces the browser `EventSource` with a controllable fake for reconnect and backoff tests. */
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	url: string;
	onopen: (() => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	private readonly listeners = new Map<string, () => void>();
	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, listener: () => void) {
		this.listeners.set(type, listener);
	}
	emit(type: string) {
		this.listeners.get(type)?.();
	}
	close() {
		this.closed = true;
	}
}

// answer to the status probe from the threshold on; default: server unreachable (network error)
let probe: () => Promise<Response>;

beforeEach(() => {
	vi.useFakeTimers();
	FakeEventSource.instances = [];
	connection.lost = null;
	probe = () => Promise.reject(new TypeError('Failed to fetch'));
	vi.stubGlobal('EventSource', FakeEventSource);
	vi.stubGlobal('window', new EventTarget());
	vi.stubGlobal(
		'fetch',
		vi.fn(() => probe())
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const latest = () => FakeEventSource.instances.at(-1)!;

/** `persisted`: the page goes into or comes back from the back/forward cache instead of being unloaded or loaded. */
const pageTransition = (type: 'pagehide' | 'pageshow', persisted: boolean) =>
	window.dispatchEvent(Object.assign(new Event(type), { persisted }));

/** Lets `n` connection attempts fail in a row (including the backoff wait and the status probe). */
async function fail(n: number) {
	for (let i = 0; i < n; i++) {
		latest().onerror?.();
		await vi.advanceTimersByTimeAsync(30_000);
	}
}

describe('connectLiveUpdates', () => {
	it('does not reload on the first connect, but after every reconnect', () => {
		const onReload = vi.fn();
		connectLiveUpdates(1, { onReload });
		latest().onopen?.();
		expect(onReload).not.toHaveBeenCalled();

		latest().onerror?.(); // drop → backoff reconnect scheduled
		vi.advanceTimersByTime(1000);
		expect(FakeEventSource.instances).toHaveLength(2);
		latest().onopen?.();
		expect(onReload).toHaveBeenCalledTimes(1);
	});

	it('closes the failed connection itself, so the native reconnect does not run in parallel', () => {
		connectLiveUpdates(1, { onReload: vi.fn() });
		const first = latest();
		first.onerror?.();
		expect(first.closed).toBe(true);
	});

	it('increases the wait exponentially up to the cap', () => {
		connectLiveUpdates(1, { onReload: vi.fn() });
		for (const expectedDelay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
			const countBefore = FakeEventSource.instances.length;
			latest().onerror?.();
			vi.advanceTimersByTime(expectedDelay - 1);
			expect(FakeEventSource.instances).toHaveLength(countBefore); // no reconnect just before the wait ends
			vi.advanceTimersByTime(1);
			expect(FakeEventSource.instances).toHaveLength(countBefore + 1); // exactly now
		}
	});

	it('starts again at 1 s after a successful reconnect', () => {
		connectLiveUpdates(1, { onReload: vi.fn() });
		latest().onerror?.();
		vi.advanceTimersByTime(1000);
		latest().onerror?.();
		vi.advanceTimersByTime(2000);
		latest().onopen?.(); // connected again → counter reset

		latest().onerror?.();
		const countBefore = FakeEventSource.instances.length;
		vi.advanceTimersByTime(1000);
		expect(FakeEventSource.instances).toHaveLength(countBefore + 1);
	});

	it('reports a lost connection only after several failed attempts, and clears it after the reconnect', async () => {
		connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(2);
		expect(connection.lost).toBeNull(); // two failed attempts are not a lasting outage yet

		await fail(1);
		expect(connection.lost).toBe('offline');

		await fail(2);
		expect(connection.lost).toBe('offline');

		latest().onopen?.();
		expect(connection.lost).toBeNull();
	});

	it('reports an expired session on 401 (logout, reset, expiry) and stops retrying', async () => {
		probe = async () => new Response(null, { status: 401 });
		connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(3);
		expect(fetch).toHaveBeenCalledWith('/api/events?project=1', expect.anything());
		expect(connection.lost).toBe('expired');

		const count = FakeEventSource.instances.length;
		expect(latest().closed).toBe(true);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(FakeEventSource.instances).toHaveLength(count); // gave up
	});

	it('keeps retrying with the connection reported lost when the server is reachable but the stream drops (no 401)', async () => {
		probe = async () => new Response(null, { status: 200 });
		connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(3);
		expect(connection.lost).toBe('offline');
		expect(FakeEventSource.instances).toHaveLength(4); // every failed attempt reconnected
		expect(latest().closed).toBe(false);
		expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true); // the probe keeps no second stream open
	});

	it.each([
		['reconnected', 200, () => latest().onopen?.()],
		['closed', 401, (h: { close(): void }) => h.close()]
	])(
		'reports no stale loss when the probe answers after the connection was already %s',
		async (_, status, meanwhile) => {
			let answer!: (res: Response) => void;
			probe = () => new Promise((resolve) => (answer = resolve));
			const handle = connectLiveUpdates(1, { onReload: vi.fn() });
			await fail(3); // the third probe is still pending
			meanwhile(handle);
			answer(new Response(null, { status }));
			await vi.advanceTimersByTimeAsync(0);
			expect(connection.lost).toBeNull();
		}
	);

	it('ends the connection for good on close(), without another reconnect', () => {
		const handle = connectLiveUpdates(1, { onReload: vi.fn() });
		const first = latest();
		handle.close();
		expect(first.closed).toBe(true);

		first.onerror?.(); // a late error of an already closed connection
		vi.advanceTimersByTime(60_000);
		expect(FakeEventSource.instances).toHaveLength(1);
	});

	it('leaves no zombie reconnect and clears the loss when closed during the backoff wait', async () => {
		const handle = connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(2);
		latest().onerror?.(); // third failed attempt → notice, reconnect scheduled in 4 s
		await vi.advanceTimersByTimeAsync(0);
		expect(connection.lost).toBe('offline');
		const count = FakeEventSource.instances.length;

		handle.close();
		expect(connection.lost).toBeNull();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(FakeEventSource.instances).toHaveLength(count);
	});

	it('passes incoming events to onEvent', () => {
		const onEvent = vi.fn();
		connectLiveUpdates(1, { onReload: vi.fn(), onEvent });
		latest().onmessage?.({
			data: JSON.stringify({ type: 'ticket.updated', projectId: 1 })
		} as MessageEvent);
		expect(onEvent).toHaveBeenCalledWith({ type: 'ticket.updated', projectId: 1 });
	});

	describe('back/forward cache', () => {
		it('closes the connection when the page is hidden, so a cached page holds no connection to the server', () => {
			connectLiveUpdates(null, { onReload: vi.fn() });
			pageTransition('pagehide', true);
			expect(latest().closed).toBe(true);
		});

		it('reconnects and reloads when the page comes back, because events were missed meanwhile', () => {
			const onReload = vi.fn();
			connectLiveUpdates(null, { onReload });
			latest().onopen?.();
			pageTransition('pagehide', true);
			pageTransition('pageshow', true);

			expect(FakeEventSource.instances).toHaveLength(2);
			expect(onReload).not.toHaveBeenCalled(); // only once connected, or events in between would be missed again
			latest().onopen?.();
			expect(onReload).toHaveBeenCalledTimes(1);
		});

		it('opens no second connection on the pageshow of the first load', () => {
			connectLiveUpdates(null, { onReload: vi.fn() });
			pageTransition('pageshow', false);
			expect(FakeEventSource.instances).toHaveLength(1);
		});

		it('drops a reconnect scheduled before the page was hidden, so it comes back with one connection', async () => {
			connectLiveUpdates(null, { onReload: vi.fn() });
			latest().onerror?.(); // reconnect scheduled in 1 s
			pageTransition('pagehide', true);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(FakeEventSource.instances).toHaveLength(1);

			pageTransition('pageshow', true);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(FakeEventSource.instances).toHaveLength(2);
		});

		it('stays closed when the page comes back after close()', () => {
			const handle = connectLiveUpdates(null, { onReload: vi.fn() });
			handle.close();
			pageTransition('pagehide', true);
			pageTransition('pageshow', true);
			expect(FakeEventSource.instances).toHaveLength(1);
		});
	});
	describe('a lost network', () => {
		const STALL_MS = 35_000;
		const networkEvent = (type: 'offline' | 'online') => window.dispatchEvent(new Event(type));

		it('shows the connection as lost at once on the offline event, before any error', () => {
			connectLiveUpdates(null, { onReload: vi.fn() });
			latest().onopen?.();
			networkEvent('offline');
			expect(connection.lost).toBe('offline');
			expect(FakeEventSource.instances[0].closed).toBe(true);
		});

		it('on the online event clears the state at the first message and opens the stream again with a reload', () => {
			const onReload = vi.fn();
			connectLiveUpdates(null, { onReload });
			latest().onopen?.();
			networkEvent('offline');
			networkEvent('online');
			expect(FakeEventSource.instances).toHaveLength(2);
			latest().onopen?.();
			expect(connection.lost).toBeNull();
			expect(onReload).toHaveBeenCalledTimes(1);
		});

		it('takes a stream with no data for longer than a heartbeat and its grace as lost', () => {
			connectLiveUpdates(null, { onReload: vi.fn() });
			latest().onopen?.();
			vi.advanceTimersByTime(STALL_MS - 1);
			expect(connection.lost).toBeNull();
			vi.advanceTimersByTime(1);
			expect(connection.lost).toBe('offline');
			expect(FakeEventSource.instances[0].closed).toBe(true);
		});

		it('does not take a stream as lost while heartbeats or messages keep coming', () => {
			connectLiveUpdates(null, { onReload: vi.fn(), onEvent: vi.fn() });
			latest().onopen?.();
			for (let beat = 0; beat < 4; beat++) {
				vi.advanceTimersByTime(25_000);
				latest().emit('heartbeat');
			}
			latest().onmessage?.({ data: '{}' } as MessageEvent);
			vi.advanceTimersByTime(25_000);
			expect(connection.lost).toBeNull();
		});

		it('stops watching after close()', () => {
			const handle = connectLiveUpdates(null, { onReload: vi.fn() });
			handle.close();
			vi.advanceTimersByTime(STALL_MS * 2);
			expect(connection.lost).toBeNull();
			networkEvent('offline');
			expect(connection.lost).toBeNull();
		});
	});
});
