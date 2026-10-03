import { dismiss, toast } from './ui/toast.svelte';

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1000;
/** Ab dieser Zahl aufeinanderfolgender gescheiterter Reconnect-Versuche gilt die Verbindung als dauerhaft weg (UX-Kriterium #770). */
const PERSISTENT_FAILURE_THRESHOLD = 3;
const DISCONNECTED =
	'Verbindung unterbrochen — Daten evtl. veraltet. Studio versucht es weiter; Seite neu laden holt den aktuellen Stand.';
const EXPIRED = 'Sitzung abgelaufen — Live-Updates gestoppt.';

export type LiveUpdatesHandle = { close(): void };

/**
 * Verbindet mit dem projektbezogenen SSE-Endpunkt (`/api/events?project=<id>`) und hält die Verbindung offen.
 * Natives `EventSource`-Reconnect reicht nicht: fester ~3s-Takt ohne Backoff und kein Signal für „gibt endgültig
 * auf" — das übernimmt dieser Helfer, indem er die Verbindung bei jedem Fehler selbst schließt und mit
 * exponentiellem Backoff neu aufbaut.
 *
 * `onReload` läuft nach jedem *Reconnect* (nicht beim ersten Verbindungsaufbau) — zwischen Abbruch und
 * Wiederverbindung gehen Events verloren (kein Replay im Bus, siehe `events.ts`), der Aufrufer holt den
 * betroffenen Zustand daher frisch vom Server.
 * `onEvent`, falls angegeben, bekommt jedes eintreffende Event roh für granulare Updates ohne vollen Reload.
 *
 * Ab `PERSISTENT_FAILURE_THRESHOLD` gescheiterten Versuchen in Folge fragt ein `fetch` nach dem Grund
 * (`EventSource` verrät keinen HTTP-Status): 401 → Sitzung weg, Versuche enden, Fehler-Toast mit Link zu /login;
 * sonst Fehler-Toast „Verbindung unterbrochen" (UX-Kriterium #770, bleibt bis zum Reconnect oder Schließen).
 */
export function connectLiveUpdates(
	projectId: number,
	options: { onReload: () => void; onEvent?: (event: Record<string, unknown>) => void }
): LiveUpdatesHandle {
	const url = `/api/events?project=${projectId}`;
	let es: EventSource | null = null;
	let attempt = 0;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let toastId: number | undefined;
	let closed = false;

	function hideNotice() {
		if (toastId !== undefined) {
			dismiss(toastId);
			toastId = undefined;
		}
	}

	function close() {
		closed = true;
		clearTimeout(retryTimer);
		es?.close();
		hideNotice();
	}

	async function explainFailure() {
		const abort = new AbortController();
		const status = await fetch(url, { signal: abort.signal }).then(
			(res) => res.status,
			() => 0
		);
		abort.abort(); // bei 200 nicht als zweiten Stream offen halten
		if (closed || attempt < PERSISTENT_FAILURE_THRESHOLD) return; // inzwischen geschlossen oder wieder verbunden
		if (status === 401) {
			close();
			toastId = toast(EXPIRED, 'error', 0, { label: 'Neu anmelden', href: '/login' });
		} else toastId ??= toast(DISCONNECTED, 'error');
	}

	function connect() {
		es = new EventSource(url);
		es.onopen = () => {
			const wasReconnect = attempt > 0;
			attempt = 0;
			hideNotice();
			if (wasReconnect) options.onReload();
		};
		es.onmessage = (ev) => {
			if (!options.onEvent) return;
			try {
				options.onEvent(JSON.parse(ev.data));
			} catch {
				// unerwartete Nachricht (z. B. Heartbeat käme als Kommentarzeile nie hier an) — ignorieren
			}
		};
		es.onerror = () => {
			es?.close();
			es = null;
			if (closed) return;
			attempt++;
			retryTimer = setTimeout(
				connect,
				Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1))
			);
			if (attempt >= PERSISTENT_FAILURE_THRESHOLD) void explainFailure();
		};
	}
	connect();

	return { close };
}
