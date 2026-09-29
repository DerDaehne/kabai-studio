import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismiss, toast, toasts } from './toast.svelte';

describe('toast', () => {
	afterEach(() => {
		toasts.length = 0;
		vi.useRealTimers();
	});

	it('blendet Info/Erfolg nach 5 s aus, Fehler bleiben bis zum Schließen', () => {
		vi.useFakeTimers();
		toast('Gespeichert', 'success');
		const err = toast('Speichern fehlgeschlagen', 'error');
		expect(toasts.map((t) => t.tone)).toEqual(['success', 'error']);

		vi.advanceTimersByTime(5000);
		expect(toasts.map((t) => t.id)).toEqual([err]);

		dismiss(err);
		expect(toasts).toEqual([]);
	});

	it('dismiss mit unbekannter ID ist harmlos (Timer nach manuellem Schließen)', () => {
		vi.useFakeTimers();
		const id = toast('Hallo');
		dismiss(id);
		vi.advanceTimersByTime(5000);
		expect(toasts).toEqual([]);
	});
});
