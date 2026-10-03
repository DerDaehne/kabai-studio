import { subscribe, type StudioEvent } from './events';
import { mask } from './secrets';

const encoder = new TextEncoder();
// Events leave for the browser here, so this masks even what a producer forgot to mask.
const frame = (event: StudioEvent) => encoder.encode(`data: ${JSON.stringify(mask(event))}\n\n`);
const HEARTBEAT = encoder.encode(': heartbeat\n\n');
const CONNECTED = encoder.encode(': connected\n\n');
const HEARTBEAT_MS = 25_000;

export const SSE_HEADERS = {
	'Content-Type': 'text/event-stream',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive',
	'X-Accel-Buffering': 'no' // no proxy buffering, otherwise events arrive late
} as const;

/**
 * SSE stream for the event bus, filtered by `filter` (for a project: `e => e.projectId === id`). A heartbeat keeps
 * proxies and browsers alive; `cancel` (connection end) unsubscribes the bus listener and stops the timer —
 * otherwise every open connection would leak one.
 *
 * `alive` runs before every event and every heartbeat (the route checks the session). If it is false or throws, the
 * stream closes at once and cleans up, so an open stream gets nothing after logout, password reset or expiry.
 */
export function eventStream(
	filter: (event: StudioEvent) => boolean,
	{
		alive = () => true,
		heartbeatMs = HEARTBEAT_MS
	}: { alive?: () => boolean; heartbeatMs?: number } = {}
): ReadableStream<Uint8Array> {
	let stop = () => {};
	return new ReadableStream({
		start(controller) {
			// Never throws: it runs in the bus listener, and a throwing listener hands its error to whoever made the mutation.
			const send = (event?: StudioEvent) => {
				try {
					if (event && !filter(event)) return;
					if (alive()) return controller.enqueue(event ? frame(event) : HEARTBEAT);
				} catch {
					// DB error in alive(), broken event or closed connection → close; the client reconnects and reloads
				}
				stop();
				try {
					controller.close();
				} catch {
					// already closed
				}
			};
			const unsubscribe = subscribe(send);
			const timer = setInterval(send, heartbeatMs);
			stop = () => {
				clearInterval(timer);
				unsubscribe();
			};
			// Node sends the response headers only with the first chunk — without this line the browser's `onopen` would
			// fire only on the first event or heartbeat (up to 25 s), and `onReload` after a reconnect would come as late.
			controller.enqueue(CONNECTED);
		},
		cancel() {
			stop();
		}
	});
}
