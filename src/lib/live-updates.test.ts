import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectLiveUpdates } from './live-updates';
import { toasts } from './ui/toast.svelte';

/** Ersetzt den Browser-`EventSource` durch eine steuerbare Fake-Implementierung für Reconnect/Backoff-Tests. */
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	url: string;
	onopen: (() => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}
	close() {
		this.closed = true;
	}
}

// Antwort der Status-Nachfrage ab der Schwelle; Standard: Server nicht erreichbar (Netzfehler)
let probe: () => Promise<Response>;

beforeEach(() => {
	vi.useFakeTimers();
	FakeEventSource.instances = [];
	toasts.length = 0;
	probe = () => Promise.reject(new TypeError('Failed to fetch'));
	vi.stubGlobal('EventSource', FakeEventSource);
	vi.stubGlobal(
		'fetch',
		vi.fn(() => probe())
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const latest = () => FakeEventSource.instances.at(-1)!;

/** Lässt `n` Verbindungsversuche nacheinander scheitern (inkl. Backoff-Wartezeit und Status-Nachfrage). */
async function fail(n: number) {
	for (let i = 0; i < n; i++) {
		latest().onerror?.();
		await vi.advanceTimersByTimeAsync(30_000);
	}
}

describe('connectLiveUpdates', () => {
	it('lädt beim ersten Verbindungsaufbau nicht neu, aber nach jedem Reconnect', () => {
		const onReload = vi.fn();
		connectLiveUpdates(1, { onReload });
		latest().onopen?.();
		expect(onReload).not.toHaveBeenCalled();

		latest().onerror?.(); // Abbruch → Backoff-Reconnect eingeplant
		vi.advanceTimersByTime(1000);
		expect(FakeEventSource.instances).toHaveLength(2);
		latest().onopen?.();
		expect(onReload).toHaveBeenCalledTimes(1);
	});

	it('schließt die fehlerhafte Verbindung selbst — sonst liefe das native Reconnect parallel', () => {
		connectLiveUpdates(1, { onReload: vi.fn() });
		const first = latest();
		first.onerror?.();
		expect(first.closed).toBe(true);
	});

	it('erhöht die Wartezeit exponentiell bis zur Obergrenze', () => {
		connectLiveUpdates(1, { onReload: vi.fn() });
		for (const expectedDelay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
			const countBefore = FakeEventSource.instances.length;
			latest().onerror?.();
			vi.advanceTimersByTime(expectedDelay - 1);
			expect(FakeEventSource.instances).toHaveLength(countBefore); // kurz vor Ablauf noch kein Reconnect
			vi.advanceTimersByTime(1);
			expect(FakeEventSource.instances).toHaveLength(countBefore + 1); // genau jetzt
		}
	});

	it('beginnt nach erfolgreichem Reconnect wieder bei 1 s', () => {
		connectLiveUpdates(1, { onReload: vi.fn() });
		latest().onerror?.();
		vi.advanceTimersByTime(1000);
		latest().onerror?.();
		vi.advanceTimersByTime(2000);
		latest().onopen?.(); // wieder verbunden → Zähler zurück

		latest().onerror?.();
		const countBefore = FakeEventSource.instances.length;
		vi.advanceTimersByTime(1000);
		expect(FakeEventSource.instances).toHaveLength(countBefore + 1);
	});

	it('zeigt erst nach mehreren Fehlversuchen einen Hinweis mit Ausweg, blendet ihn nach Reconnect wieder aus', async () => {
		connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(2);
		expect(toasts).toHaveLength(0); // zwei Fehlversuche sind noch kein dauerhafter Ausfall

		await fail(1);
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({
			tone: 'error',
			message: expect.stringMatching(/Verbindung unterbrochen.*versucht es weiter.*neu laden/)
		});

		await fail(2); // weitere Fehlversuche stapeln keine zweite Meldung
		expect(toasts).toHaveLength(1);

		latest().onopen?.();
		expect(toasts).toHaveLength(0);
	});

	it('401 (Logout, Reset, Ablauf): Meldung „Sitzung abgelaufen" mit Link zu /login, keine weiteren Versuche', async () => {
		probe = async () => new Response(null, { status: 401 });
		connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(3);
		expect(fetch).toHaveBeenCalledWith('/api/events?project=1', expect.anything());
		expect(toasts).toEqual([
			expect.objectContaining({
				tone: 'error',
				message: expect.stringContaining('Sitzung abgelaufen'),
				action: { label: 'Neu anmelden', href: '/login' }
			})
		]);

		const count = FakeEventSource.instances.length;
		expect(latest().closed).toBe(true);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(FakeEventSource.instances).toHaveLength(count); // aufgegeben
	});

	it('Server erreichbar, aber Stream bricht ab (kein 401): weiter versuchen, Hinweis „Verbindung unterbrochen"', async () => {
		probe = async () => new Response(null, { status: 200 });
		connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(3);
		expect(toasts).toEqual([
			expect.objectContaining({ message: expect.stringContaining('Verbindung unterbrochen') })
		]);
		expect(FakeEventSource.instances).toHaveLength(4); // jeder Fehlversuch hat neu verbunden
		expect(latest().closed).toBe(false);
		expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true); // Nachfrage hält keinen zweiten Stream offen
	});

	it.each([
		['wieder verbunden', 200, () => latest().onopen?.()],
		['geschlossen', 401, (h: { close(): void }) => h.close()]
	])(
		'Nachfrage antwortet erst, wenn schon %s: kein veralteter Hinweis',
		async (_, status, meanwhile) => {
			let answer!: (res: Response) => void;
			probe = () => new Promise((resolve) => (answer = resolve));
			const handle = connectLiveUpdates(1, { onReload: vi.fn() });
			await fail(3); // dritte Nachfrage hängt noch
			meanwhile(handle);
			answer(new Response(null, { status }));
			await vi.advanceTimersByTimeAsync(0);
			expect(toasts).toHaveLength(0);
		}
	);

	it('close() beendet die Verbindung endgültig — kein weiterer Reconnect', () => {
		const handle = connectLiveUpdates(1, { onReload: vi.fn() });
		const first = latest();
		handle.close();
		expect(first.closed).toBe(true);

		first.onerror?.(); // spät eintreffender Fehler einer bereits geschlossenen Verbindung
		vi.advanceTimersByTime(60_000);
		expect(FakeEventSource.instances).toHaveLength(1);
	});

	it('close() während der Backoff-Wartezeit: kein Zombie-Reconnect, Hinweis verschwindet', async () => {
		const handle = connectLiveUpdates(1, { onReload: vi.fn() });
		await fail(2);
		latest().onerror?.(); // dritter Fehlversuch → Hinweis, Reconnect in 4 s eingeplant
		await vi.advanceTimersByTimeAsync(0);
		expect(toasts).toHaveLength(1);
		const count = FakeEventSource.instances.length;

		handle.close();
		expect(toasts).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(FakeEventSource.instances).toHaveLength(count);
	});

	it('reicht eingehende Events an onEvent weiter', () => {
		const onEvent = vi.fn();
		connectLiveUpdates(1, { onReload: vi.fn(), onEvent });
		latest().onmessage?.({
			data: JSON.stringify({ type: 'ticket.updated', projectId: 1 })
		} as MessageEvent);
		expect(onEvent).toHaveBeenCalledWith({ type: 'ticket.updated', projectId: 1 });
	});
});
