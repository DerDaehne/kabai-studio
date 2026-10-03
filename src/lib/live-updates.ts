import { dismiss, toast } from './ui/toast.svelte';

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1000;
/** After this many failed reconnects in a row the connection counts as lost for good. */
const PERSISTENT_FAILURE_THRESHOLD = 3;
const DISCONNECTED =
	'Verbindung unterbrochen — Daten evtl. veraltet. Studio versucht es weiter; Seite neu laden holt den aktuellen Stand.';
const EXPIRED = 'Sitzung abgelaufen — Live-Updates gestoppt.';

export type LiveUpdatesHandle = { close(): void };
type LiveUpdatesOptions = {
	onReload: () => void;
	onEvent?: (event: Record<string, unknown>) => void;
};

/**
 * Connects to the project's SSE endpoint (`/api/events?project=<id>`) and keeps the connection open.
 * Native `EventSource` reconnects are not enough: a fixed ~3 s rhythm without backoff and no signal for
 * "gave up for good" — so this helper closes the connection on every error and reconnects with exponential backoff.
 *
 * `onReload` runs after every *reconnect* (not on the first connect): events sent while disconnected are lost
 * (the bus has no replay), so the caller fetches the affected state again. `onEvent`, if given, receives every
 * incoming event raw for granular updates without a full reload.
 *
 * After `PERSISTENT_FAILURE_THRESHOLD` failed attempts in a row a `fetch` asks for the reason (`EventSource`
 * exposes no HTTP status): 401 → session gone, attempts stop, error toast with a link to /login; otherwise an
 * error toast "connection lost" that stays until the reconnect or until closed.
 */
export function connectLiveUpdates(
	projectId: number,
	options: LiveUpdatesOptions
): LiveUpdatesHandle {
	const connection = new LiveConnection(`/api/events?project=${projectId}`, options);
	connection.connect();
	return { close: () => connection.close() };
}

class LiveConnection {
	private readonly url: string;
	private readonly options: LiveUpdatesOptions;
	private es: EventSource | null = null;
	private attempt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private toastId: number | undefined;
	private closed = false;

	constructor(url: string, options: LiveUpdatesOptions) {
		this.url = url;
		this.options = options;
	}

	connect() {
		this.es = new EventSource(this.url);
		this.es.onopen = () => this.opened();
		this.es.onmessage = (ev) => this.received(ev);
		this.es.onerror = () => this.failed();
	}

	close() {
		this.closed = true;
		clearTimeout(this.retryTimer);
		this.es?.close();
		this.hideNotice();
	}

	private opened() {
		const wasReconnect = this.attempt > 0;
		this.attempt = 0;
		this.hideNotice();
		if (wasReconnect) this.options.onReload();
	}

	private received(ev: MessageEvent) {
		if (!this.options.onEvent) return;
		try {
			this.options.onEvent(JSON.parse(ev.data));
		} catch {
			// an unexpected message is ignored; heartbeats are comment lines and never arrive here
		}
	}

	private failed() {
		this.es?.close();
		this.es = null;
		if (this.closed) return;
		this.attempt++;
		const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.attempt - 1));
		this.retryTimer = setTimeout(() => this.connect(), backoff);
		if (this.attempt >= PERSISTENT_FAILURE_THRESHOLD) void this.explainFailure();
	}

	private async explainFailure() {
		const abort = new AbortController();
		const status = await fetch(this.url, { signal: abort.signal }).then(
			(res) => res.status,
			() => 0
		);
		abort.abort(); // on 200, don't keep it open as a second stream
		const reconnectedOrClosed = this.closed || this.attempt < PERSISTENT_FAILURE_THRESHOLD;
		if (reconnectedOrClosed) return;
		if (status === 401) {
			this.close();
			this.toastId = toast(EXPIRED, 'error', 0, { label: 'Neu anmelden', href: '/login' });
		} else this.toastId ??= toast(DISCONNECTED, 'error');
	}

	private hideNotice() {
		if (this.toastId === undefined) return;
		dismiss(this.toastId);
		this.toastId = undefined;
	}
}
