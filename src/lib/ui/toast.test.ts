import { afterEach, describe, expect, it, vi } from 'vitest';
import { dismiss, toast, toasts } from './toast.svelte';

describe('toast', () => {
	afterEach(() => {
		toasts.length = 0;
		vi.useRealTimers();
	});

	it('hides info and success after 5 s while errors stay until closed', () => {
		vi.useFakeTimers();
		toast('Gespeichert', 'success');
		const err = toast('Speichern fehlgeschlagen', 'error');
		expect(toasts.map((t) => t.tone)).toEqual(['success', 'error']);

		vi.advanceTimersByTime(5000);
		expect(toasts.map((t) => t.id)).toEqual([err]);

		dismiss(err);
		expect(toasts).toEqual([]);
	});

	it('ignores dismiss with an unknown id (a timer after closing by hand)', () => {
		vi.useFakeTimers();
		const id = toast('Hallo');
		dismiss(id);
		vi.advanceTimersByTime(5000);
		expect(toasts).toEqual([]);
	});
});
