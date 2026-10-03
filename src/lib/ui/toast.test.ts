import { render } from 'svelte/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Toaster from './Toaster.svelte';
import { dismiss, runAction, toast, toasts } from './toast.svelte';

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

	it('offers an action as a button that closes the notice and runs it, e.g. taking an answer back', () => {
		const run = vi.fn();
		const id = toast('Antwort gesendet', 'success', 10_000, { label: 'Rückgängig', run });
		expect(render(Toaster).body).toMatch(/<button[^>]*>\s*Rückgängig\s*<\/button>/);

		runAction(toasts.find((t) => t.id === id)!);
		expect(run).toHaveBeenCalledOnce();
		expect(toasts).toEqual([]);
	});

	it('keeps a link as the way out of a notice', () => {
		toast('Sitzung abgelaufen', 'error', 0, { label: 'Neu anmelden', href: '/login' });
		expect(render(Toaster).body).toMatch(/<a href="\/login">Neu anmelden<\/a>/);
	});

	it('ignores dismiss with an unknown id (a timer after closing by hand)', () => {
		vi.useFakeTimers();
		const id = toast('Hallo');
		dismiss(id);
		vi.advanceTimersByTime(5000);
		expect(toasts).toEqual([]);
	});
});
