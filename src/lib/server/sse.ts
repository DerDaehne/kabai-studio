import { subscribe, type StudioEvent } from './events';

const encoder = new TextEncoder();
const frame = (event: StudioEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
const HEARTBEAT = encoder.encode(': heartbeat\n\n');
const CONNECTED = encoder.encode(': connected\n\n');
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
 *
 * `alive` läuft vor jedem Event und jedem Heartbeat (Route: Session noch gültig?). Ist es falsch oder wirft,
 * schließt der Stream sofort und räumt auf — so bekommt ein offener Stream nach Logout/Reset/Ablauf nichts mehr.
 */
export function eventStream(
	filter: (event: StudioEvent) => boolean,
	{ alive = () => true, heartbeatMs = HEARTBEAT_MS }: { alive?: () => boolean; heartbeatMs?: number } = {}
): ReadableStream<Uint8Array> {
	let stop = () => {};
	return new ReadableStream({
		start(controller) {
			// Wirft nie: läuft im Bus-Listener, und Listener dürfen nicht werfen (Fehler landete sonst beim Aufrufer der Mutation).
			const send = (event?: StudioEvent) => {
				try {
					if (event && !filter(event)) return;
					if (alive()) return controller.enqueue(event ? frame(event) : HEARTBEAT);
				} catch {
					// DB-Fehler in alive(), kaputtes Event oder Verbindung schon zu → schließen, der Client verbindet neu und lädt neu
				}
				stop();
				try {
					controller.close();
				} catch {
					// schon geschlossen
				}
			};
			const unsubscribe = subscribe(send);
			const timer = setInterval(send, heartbeatMs);
			stop = () => {
				clearInterval(timer);
				unsubscribe();
			};
			// Node schickt die Response-Header erst mit dem ersten Chunk — ohne diese Zeile feuerte `onopen` im Browser
			// erst beim ersten Event oder Heartbeat (bis 25 s), und `onReload` nach einem Reconnect käme so spät.
			controller.enqueue(CONNECTED);
		},
		cancel() {
			stop();
		}
	});
}
