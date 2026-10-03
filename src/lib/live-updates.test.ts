import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectLiveUpdates } from './live-updates';
import { toasts } from './ui/toast.svelte';

/** Replaces the browser `EventSource` with a controllable fake for reconnect and backoff tests. */
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	url: string;
	onopen: (() => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
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
	toasts.length = 0;
	probe = () => Promise.reject(new TypeError('Failed to fetch'));
	vi.stubGlobal('EventSource', FakeEventSource);
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

	it('shows a notice with a way out only after several failed attempts, and hides it after the reconnect', async () => {
		connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(2);
		expect(toasts).toHaveLength(0); // two failed attempts are not a lasting outage yet

		await fail(1);
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({
			tone: 'error',
			message: expect.stringMatching(/Verbindung unterbrochen.*versucht es weiter.*neu laden/)
		});

		await fail(2); // further failed attempts stack no second notice
		expect(toasts).toHaveLength(1);

		latest().onopen?.();
		expect(toasts).toHaveLength(0);
	});

	it('reports "Sitzung abgelaufen" with a link to /login on 401 (logout, reset, expiry) and stops retrying', async () => {
		probe = async () => new Response(null, { status: 401 });
		connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(3);
		expect(fetch).toHaveBeenCalledWith('/api/events?project=1', expect.anything());
		expect(toasts).toEqual([
			expect.objectContaining({
				tone: 'error',
				message: expect.stringContaining('Sitzung abgelaufen'),
				action: { label: 'Neu anmelden', href: '/login' }
			})
		]);

		const count = FakeEventSource.instances.length;
		expect(latest().closed).toBe(true);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(FakeEventSource.instances).toHaveLength(count); // gave up
	});

	it('keeps retrying with the notice "Verbindung unterbrochen" when the server is reachable but the stream drops (no 401)', async () => {
		probe = async () => new Response(null, { status: 200 });
		connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(3);
		expect(toasts).toEqual([
			expect.objectContaining({ message: expect.stringContaining('Verbindung unterbrochen') })
		]);
		expect(FakeEventSource.instances).toHaveLength(4); // every failed attempt reconnected
		expect(latest().closed).toBe(false);
		expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true); // the probe keeps no second stream open
	});

	it.each([
		['reconnected', 200, () => latest().onopen?.()],
		['closed', 401, (h: { close(): void }) => h.close()]
	])(
		'shows no stale notice when the probe answers after the connection was already %s',
		async (_, status, meanwhile) => {
			let answer!: (res: Response) => void;
			probe = () => new Promise((resolve) => (answer = resolve));
			const handle = connectLiveUpdates(1, { onReload: vi.fn() });
			await fail(3); // the third probe is still pending
			meanwhile(handle);
			answer(new Response(null, { status }));
			await vi.advanceTimersByTimeAsync(0);
			expect(toasts).toHaveLength(0);
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

	it('leaves no zombie reconnect and hides the notice when closed during the backoff wait', async () => {
		const handle = connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(2);
		latest().onerror?.(); // third failed attempt → notice, reconnect scheduled in 4 s
		await vi.advanceTimersByTimeAsync(0);
		expect(toasts).toHaveLength(1);
		const count = FakeEventSource.instances.length;

		handle.close();
		expect(toasts).toHaveLength(0);
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
});
