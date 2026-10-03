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

/** Öffnet einen Stream und liest die sofortige `: connected`-Zeile schon weg. */
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
	it('schickt sofort eine Kommentarzeile — ohne Event und ohne Heartbeat (Header gehen damit gleich raus)', async () => {
		vi.useFakeTimers();
		const reader = eventStream(() => true, { heartbeatMs: 60_000 }).getReader();
		expect(await readChunk(reader)).toBe(': connected\n\n'); // Fake-Timer: kein Heartbeat kann gelaufen sein
		await reader.cancel();
	});

	it('gibt ein passendes Event als SSE-Nachricht weiter', async () => {
		const reader = await open((e) => e.projectId === 1);
		const event = evt({ ticketId: 7 });
		publish(event);
		const chunk = await readChunk(reader);
		expect(chunk.startsWith('data: ') && chunk.endsWith('\n\n')).toBe(true);
		expect(JSON.parse(chunk.slice('data: '.length, -2))).toEqual(event);
		await reader.cancel();
	});

	it('filtert Events anderer Projekte heraus (Projektfilter)', async () => {
		const reader = await open((e) => e.projectId === 1);
		publish(evt({ projectId: 2, ticketId: 1 })); // gehört nicht zum Filter, darf nicht ankommen
		publish(evt({ projectId: 1, ticketId: 9 })); // passiert den Filter
		const chunk = await readChunk(reader);
		expect(JSON.parse(chunk.slice('data: '.length, -2))).toMatchObject({
			projectId: 1,
			ticketId: 9
		});
		await reader.cancel();
	});

	it('meldet beim Schließen Bus-Listener und Heartbeat-Timer ab (kein Leck)', async () => {
		vi.useFakeTimers();
		const before = listenerCount();
		const reader = await open(() => true);
		expect(listenerCount()).toBe(before + 1);
		expect(vi.getTimerCount()).toBe(1);
		await reader.cancel();
		expect(listenerCount()).toBe(before);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('schickt einen Heartbeat-Kommentar im Intervall', async () => {
		const reader = await open(() => false, { heartbeatMs: 5 });
		expect(await readChunk(reader)).toBe(': heartbeat\n\n');
		await reader.cancel();
	});

	it('widerrufen (alive falsch): kein Event mehr, Stream endet, Listener und Timer weg', async () => {
		vi.useFakeTimers();
		const before = listenerCount();
		let alive = true;
		const reader = await open(() => true, { alive: () => alive, heartbeatMs: 60_000 });
		alive = false; // z. B. Logout in einem anderen Tab
		publish(evt({ ticketId: 3 }));
		expect(await reader.read()).toEqual({ done: true, value: undefined });
		expect(listenerCount()).toBe(before);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('widerrufen ohne Events: der Heartbeat prüft und schließt den Stream', async () => {
		vi.useFakeTimers();
		let alive = true;
		const reader = await open(() => false, { alive: () => alive, heartbeatMs: 1000 });
		alive = false;
		vi.advanceTimersByTime(1000);
		expect(await reader.read()).toEqual({ done: true, value: undefined });
		expect(vi.getTimerCount()).toBe(0);
	});

	it('wirft alive (z. B. DB-Fehler), schließt der Stream — der Fehler erreicht den Publisher nicht', async () => {
		const reader = await open(() => true, {
			alive: () => {
				throw new Error('database is locked');
			}
		});
		expect(() => publish(evt())).not.toThrow();
		expect(await reader.read()).toEqual({ done: true, value: undefined });
	});
});
