import { subscribe, type StudioEvent } from './events';

const encoder = new TextEncoder();
const frame = (event: StudioEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
const HEARTBEAT = encoder.encode(': heartbeat\n\n');
const HEARTBEAT_MS = 25_000;

export const SSE_HEADERS = {
	'Content-Type': 'text/event-stream',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive',
	'X-Accel-Buffering': 'no' // Proxy-Puffer aus, sonst kommen Events verzögert an
} as const;

/**
 * SSE-Stream für den Event-Bus, gefiltert durch `filter` — für Projekte hier `e => e.projectId === id`,
 * später von Run-Events mit eigenem Filter wiederverwendbar (#770-Out-Klausel). Heartbeat hält Proxys/Browser
 * am Leben; `cancel` (Verbindungsende) meldet den Bus-Listener ab und stoppt den Timer — sonst ein Leck pro
 * offener Verbindung, siehe `events.ts`.
 */
export function eventStream(filter: (event: StudioEvent) => boolean, heartbeatMs = HEARTBEAT_MS): ReadableStream<Uint8Array> {
	let unsubscribe: () => void;
	let timer: ReturnType<typeof setInterval>;
	return new ReadableStream({
		start(controller) {
			const send = (chunk: Uint8Array) => {
				try {
					controller.enqueue(chunk);
				} catch {
					// Verbindung schon zu — cancel() räumt gleich auf, der Client kümmert sich ums Reconnect
				}
			};
			unsubscribe = subscribe((event) => {
				if (filter(event)) send(frame(event));
			});
			timer = setInterval(() => send(HEARTBEAT), heartbeatMs);
		},
		cancel() {
			clearInterval(timer);
			unsubscribe();
		}
	});
}
