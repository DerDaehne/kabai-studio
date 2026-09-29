import { describe, expect, it } from 'vitest';
import { listenerCount, publish, type StudioEvent } from './events';
import { eventStream } from './sse';

const decoder = new TextDecoder();
const evt = (over: Partial<StudioEvent> = {}): StudioEvent => ({ type: 'ticket.updated', projectId: 1, actor: { kind: 'user' }, ...over });

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
	const { value } = await reader.read();
	return decoder.decode(value);
}

describe('eventStream', () => {
	it('gibt ein passendes Event als SSE-Nachricht weiter', async () => {
		const reader = eventStream((e) => e.projectId === 1, 60_000).getReader();
		const event = evt({ ticketId: 7 });
		publish(event);
		const chunk = await readChunk(reader);
		expect(chunk.startsWith('data: ') && chunk.endsWith('\n\n')).toBe(true);
		expect(JSON.parse(chunk.slice('data: '.length, -2))).toEqual(event);
		await reader.cancel();
	});

	it('filtert Events anderer Projekte heraus (Projektfilter)', async () => {
		const reader = eventStream((e) => e.projectId === 1, 60_000).getReader();
		publish(evt({ projectId: 2, ticketId: 1 })); // gehört nicht zum Filter, darf nicht ankommen
		publish(evt({ projectId: 1, ticketId: 9 })); // passiert den Filter
		const chunk = await readChunk(reader);
		expect(JSON.parse(chunk.slice('data: '.length, -2))).toMatchObject({ projectId: 1, ticketId: 9 });
		await reader.cancel();
	});

	it('meldet den Bus-Listener beim Schließen ab (kein Leak)', async () => {
		const before = listenerCount();
		const reader = eventStream(() => true, 60_000).getReader();
		expect(listenerCount()).toBe(before + 1);
		await reader.cancel();
		expect(listenerCount()).toBe(before);
	});

	it('schickt einen Heartbeat-Kommentar im Intervall', async () => {
		const reader = eventStream(() => false, 5).getReader();
		const chunk = await readChunk(reader);
		expect(chunk).toBe(': heartbeat\n\n');
		await reader.cancel();
	});
});
