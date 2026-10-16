import { HEARTBEAT_GRACE_MS, HEARTBEAT_MS } from './live';
import { connection } from './shell/connection.svelte';

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1000;
/** After this many failed reconnects in a row the connection counts as lost for good. */
const PERSISTENT_FAILURE_THRESHOLD = 3;
/** A silent network loss leaves the stream hanging without an error; no data for this long means it is gone. */
const STALL_MS = HEARTBEAT_MS + HEARTBEAT_GRACE_MS;

export type LiveUpdatesHandle = { close(): void };
type LiveUpdatesOptions = {
	onReload: () => void;
	onEvent?: (event: Record<string, unknown>) => void;
};

/**
 * Connects to the SSE endpoint for one project (`/api/events?project=<id>`) or, with `null`, for all projects, and keeps
 * the connection open.
 * Native `EventSource` reconnects are not enough: a fixed ~3 s rhythm without backoff and no signal for
 * "gave up for good" — so this helper closes the connection on every error and reconnects with exponential backoff.
 *
 * `onReload` runs after every *reconnect* (not on the first connect): events sent while disconnected are lost
 * (the bus has no replay), so the caller fetches the affected state again. `onEvent`, if given, receives every
 * incoming event raw for granular updates without a full reload.
 *
 * After `PERSISTENT_FAILURE_THRESHOLD` failed attempts in a row a `fetch` asks for the reason (`EventSource`
 * exposes no HTTP status): 401 → session gone, attempts stop, the banner offers a new sign-in; otherwise the banner
 * says the connection is lost until the reconnect.
 *
 * A page that goes into the back/forward cache closes its connection and reconnects (with `onReload`) when it comes
 * back: the browser would otherwise keep the frozen stream open, and a few cached pages use up the HTTP/1.1
 * connections per origin until every request hangs.
 */
export function connectLiveUpdates(
	projectId: number | null,
	options: LiveUpdatesOptions
): LiveUpdatesHandle {
	const url = projectId === null ? '/api/events' : `/api/events?project=${projectId}`;
	const connection = new LiveConnection(url, options);
	connection.open();
	return { close: () => connection.close() };
}

class LiveConnection {
	private readonly url: string;
	private readonly options: LiveUpdatesOptions;
	private es: EventSource | null = null;
	private attempt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	private suspended = false;
	/** Hidden in the back/forward cache: nothing to watch until the page comes back. */
	private frozen = false;
	private stallTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(url: string, options: LiveUpdatesOptions) {
		this.url = url;
		this.options = options;
	}

	open() {
		window.addEventListener('pagehide', this.suspend);
		window.addEventListener('pageshow', this.resume);
		window.addEventListener('offline', this.lost);
		window.addEventListener('online', this.backOnline);
		this.connect();
	}

	private connect() {
		this.es = new EventSource(this.url);
		this.es.onopen = () => this.opened();
		this.es.onmessage = (ev) => this.received(ev);
		this.es.addEventListener('heartbeat', () => this.watch());
		this.es.onerror = () => this.failed();
		this.watch();
	}

	/** Starts the countdown to "nothing came" anew; every sign of life calls it. */
	private watch() {
		clearTimeout(this.stallTimer);
		this.stallTimer = setTimeout(this.lost, STALL_MS);
	}

	close() {
		this.closed = true;
		window.removeEventListener('pagehide', this.suspend);
		window.removeEventListener('pageshow', this.resume);
		window.removeEventListener('offline', this.lost);
		window.removeEventListener('online', this.backOnline);
		clearTimeout(this.retryTimer);
		clearTimeout(this.stallTimer);
		this.es?.close();
		this.hideNotice();
	}

	private readonly suspend = () => {
		this.suspended = true;
		this.frozen = true;
		clearTimeout(this.retryTimer);
		clearTimeout(this.stallTimer);
		this.es?.close();
	};

	/** The network is gone or the stream went quiet: say so at once and keep trying in the background. */
	private readonly lost = () => {
		if (this.closed || this.frozen) return;
		connection.lost ??= 'offline';
		clearTimeout(this.retryTimer);
		this.failed();
	};

	private readonly backOnline = () => {
		if (this.closed || this.frozen) return;
		clearTimeout(this.retryTimer);
		this.es?.close();
		this.connect();
	};

	private readonly resume = (event: PageTransitionEvent) => {
		if (!event.persisted) return;
		this.frozen = false;
		this.connect();
	};

	private opened() {
		const missedEvents = this.attempt > 0 || this.suspended;
		this.attempt = 0;
		this.suspended = false;
		this.watch();
		this.hideNotice();
		if (missedEvents) this.options.onReload();
	}

	private received(ev: MessageEvent) {
		this.watch();
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
		clearTimeout(this.stallTimer);
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
			connection.lost = 'expired';
		} else connection.lost ??= 'offline';
	}

	private hideNotice() {
		connection.lost = null;
	}
}
