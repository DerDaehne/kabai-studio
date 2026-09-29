import { dismiss, toast } from './ui/toast.svelte';

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1000;
/** Ab dieser Zahl aufeinanderfolgender gescheiterter Reconnect-Versuche gilt die Verbindung als dauerhaft weg (UX-Kriterium #770). */
const PERSISTENT_FAILURE_THRESHOLD = 3;

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
 * Nach `PERSISTENT_FAILURE_THRESHOLD` gescheiterten Versuchen in Folge zeigt ein Fehler-Toast „Verbindung
 * unterbrochen — Daten evtl. veraltet" (UX-Kriterium #770, bleibt bis zum Reconnect oder manuellem Schließen).
 */
export function connectLiveUpdates(
	projectId: number,
	options: { onReload: () => void; onEvent?: (event: Record<string, unknown>) => void }
): LiveUpdatesHandle {
	let es: EventSource | null = null;
	let attempt = 0;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let toastId: number | undefined;
	let closed = false;

	function hideDisconnectNotice() {
		if (toastId !== undefined) {
			dismiss(toastId);
			toastId = undefined;
		}
	}

	function connect() {
		es = new EventSource(`/api/events?project=${projectId}`);
		es.onopen = () => {
			const wasReconnect = attempt > 0;
			attempt = 0;
			hideDisconnectNotice();
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
			if (attempt >= PERSISTENT_FAILURE_THRESHOLD && toastId === undefined)
				toastId = toast('Verbindung unterbrochen — Daten evtl. veraltet', 'error');
			const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
			retryTimer = setTimeout(connect, delay);
		};
	}
	connect();

	return {
		close() {
			closed = true;
			clearTimeout(retryTimer);
			es?.close();
			hideDisconnectNotice();
		}
	};
}
