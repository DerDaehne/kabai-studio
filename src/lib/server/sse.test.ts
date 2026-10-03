import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenerCount, publish, type StudioEvent } from './events';
import { eventStream } from './sse';

const decoder = new TextDecoder();
const evt = (over: Partial<StudioEvent> = {}): StudioEvent => ({
	type: 'ticket.updated',
	projectId: 1,
	actor: { kind: 'user' },
	...over
});

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
	const { value } = await reader.read();
	return decoder.decode(value);
}

/** Opens a stream and consumes the immediate `: connected` line. */
async function open(
	filter: (e: StudioEvent) => boolean,
	options: Parameters<typeof eventStream>[1] = { heartbeatMs: 60_000 }
) {
	const reader = eventStream(filter, options).getReader();
	expect(await readChunk(reader)).toBe(': connected\n\n');
	return reader;
}

afterEach(() => void vi.useRealTimers());

describe('eventStream', () => {
	it('sends a comment line at once, before any event or heartbeat, so the headers go out immediately', async () => {
		vi.useFakeTimers();
		const reader = eventStream(() => true, { heartbeatMs: 60_000 }).getReader();
		expect(await readChunk(reader)).toBe(': connected\n\n'); // fake timers: no heartbeat can have run
		await reader.cancel();
	});

	it('forwards a matching event as an SSE message', async () => {
		const reader = await open((e) => e.projectId === 1);
		const event = evt({ ticketId: 7 });
		publish(event);
		const chunk = await readChunk(reader);
		expect(chunk.startsWith('data: ') && chunk.endsWith('\n\n')).toBe(true);
		expect(JSON.parse(chunk.slice('data: '.length, -2))).toEqual(event);
		await reader.cancel();
	});

	it('filters out events of other projects', async () => {
		const reader = await open((e) => e.projectId === 1);
		publish(evt({ projectId: 2, ticketId: 1 })); // outside the filter, must not arrive
		publish(evt({ projectId: 1, ticketId: 9 })); // passes the filter
		const chunk = await readChunk(reader);
		expect(JSON.parse(chunk.slice('data: '.length, -2))).toMatchObject({
			projectId: 1,
			ticketId: 9
		});
		await reader.cancel();
	});

	it('removes the bus listener and the heartbeat timer on close', async () => {
		vi.useFakeTimers();
		const before = listenerCount();
		const reader = await open(() => true);
		expect(listenerCount()).toBe(before + 1);
		expect(vi.getTimerCount()).toBe(1);
		await reader.cancel();
		expect(listenerCount()).toBe(before);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('sends a heartbeat comment at the interval', async () => {
		const reader = await open(() => false, { heartbeatMs: 5 });
		expect(await readChunk(reader)).toBe(': heartbeat\n\n');
		await reader.cancel();
	});

	it('stops events, ends the stream and cleans up once alive turns false', async () => {
		vi.useFakeTimers();
		const before = listenerCount();
		let alive = true;
		const reader = await open(() => true, { alive: () => alive, heartbeatMs: 60_000 });
		alive = false; // e.g. logout in another tab
		publish(evt({ ticketId: 3 }));
		expect(await reader.read()).toEqual({ done: true, value: undefined });
		expect(listenerCount()).toBe(before);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('closes a revoked stream on the heartbeat when no events arrive', async () => {
		vi.useFakeTimers();
		let alive = true;
		const reader = await open(() => false, { alive: () => alive, heartbeatMs: 1000 });
		alive = false;
		vi.advanceTimersByTime(1000);
		expect(await reader.read()).toEqual({ done: true, value: undefined });
		expect(vi.getTimerCount()).toBe(0);
	});

	it('closes the stream when alive throws (e.g. a DB error) without passing the error to the publisher', async () => {
		const reader = await open(() => true, {
			alive: () => {
				throw new Error('database is locked');
			}
		});
		expect(() => publish(evt())).not.toThrow();
		expect(await reader.read()).toEqual({ done: true, value: undefined });
	});
});
