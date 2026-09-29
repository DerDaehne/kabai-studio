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

beforeEach(() => {
	vi.useFakeTimers();
	FakeEventSource.instances = [];
	toasts.length = 0;
	vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const latest = () => FakeEventSource.instances.at(-1)!;

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

	it('erhöht die Wartezeit exponentiell bis zur Obergrenze', () => {
		connectLiveUpdates(1, { onReload: vi.fn() });
		for (const expectedDelay of [1000, 2000, 4000, 8000]) {
			const countBefore = FakeEventSource.instances.length;
			latest().onerror?.();
			vi.advanceTimersByTime(expectedDelay - 1);
			expect(FakeEventSource.instances).toHaveLength(countBefore); // kurz vor Ablauf noch kein Reconnect
			vi.advanceTimersByTime(1);
			expect(FakeEventSource.instances).toHaveLength(countBefore + 1); // genau jetzt
		}
	});

	it('zeigt erst nach mehreren Fehlversuchen einen Hinweis, blendet ihn nach Reconnect wieder aus', () => {
		connectLiveUpdates(1, { onReload: vi.fn() });
		latest().onerror?.();
		vi.advanceTimersByTime(1000);
		expect(toasts).toHaveLength(0); // ein Fehlversuch ist noch kein dauerhafter Ausfall

		latest().onerror?.();
		vi.advanceTimersByTime(2000);
		latest().onerror?.();
		vi.advanceTimersByTime(4000);
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({ tone: 'error', message: expect.stringContaining('Verbindung unterbrochen') });

		latest().onopen?.();
		expect(toasts).toHaveLength(0);
	});

	it('close() beendet die Verbindung endgültig — kein weiterer Reconnect', () => {
		const handle = connectLiveUpdates(1, { onReload: vi.fn() });
		const first = latest();
		handle.close();
		expect(first.closed).toBe(true);

		first.onerror?.(); // spät eintreffender Fehler einer bereits geschlossenen Verbindung
		vi.advanceTimersByTime(60_000);
		expect(FakeEventSource.instances).toHaveLength(1);
	});

	it('reicht eingehende Events an onEvent weiter', () => {
		const onEvent = vi.fn();
		connectLiveUpdates(1, { onReload: vi.fn(), onEvent });
		latest().onmessage?.({ data: JSON.stringify({ type: 'ticket.updated', projectId: 1 }) } as MessageEvent);
		expect(onEvent).toHaveBeenCalledWith({ type: 'ticket.updated', projectId: 1 });
	});
});
