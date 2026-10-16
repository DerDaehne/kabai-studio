import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Toaster from './Toaster.svelte';
import { dismiss, hold, runAction, toast, toastMs, toasts } from './toast.svelte';

describe('toast', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('document', { documentElement: {} });
		vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '10000ms' }));
	});
	afterEach(() => {
		toasts.length = 0;
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('takes its window from the --rk-duration-toast token, for errors too', () => {
		expect(toastMs()).toBe(10_000);
		toast('Speichern fehlgeschlagen', 'error');
		vi.advanceTimersByTime(9_999);
		expect(toasts).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(toasts).toEqual([]);
	});

	it('follows the token, not a number of its own', () => {
		vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '7s' }));
		toast('Hallo');
		vi.advanceTimersByTime(6_999);
		expect(toasts).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(toasts).toEqual([]);
	});

	it('shows one toast at a time: a new one replaces the open one and restarts the window', () => {
		toast('Erstes');
		vi.advanceTimersByTime(6_000);
		toast('Zweites', 'success');
		expect(toasts.map((t) => t.message)).toEqual(['Zweites']);
		vi.advanceTimersByTime(6_000);
		expect(toasts).toHaveLength(1);
	});

	it('counts the window down once a second and stands still while held', () => {
		toast('Gesendet', 'success', 5_000, { label: 'Rückgängig', run: vi.fn(), countdown: true });
		vi.advanceTimersByTime(2_000);
		expect(toasts[0].left).toBe(3_000);

		hold('pointer', true);
		vi.advanceTimersByTime(60_000);
		expect(toasts[0].left).toBe(3_000);

		hold('pointer', false);
		vi.advanceTimersByTime(3_000);
		expect(toasts).toEqual([]);
	});

	it('holds as long as either the pointer or focus is on the toast', () => {
		toast('Gesendet', 'success', 5_000, { label: 'Rückgängig', run: vi.fn(), countdown: true });
		hold('focus', true);
		hold('pointer', true);
		hold('pointer', false);
		vi.advanceTimersByTime(60_000);
		expect(toasts[0].left).toBe(5_000);

		hold('pointer', true);
		hold('focus', false);
		vi.advanceTimersByTime(60_000);
		expect(toasts[0].left).toBe(5_000);

		hold('pointer', false);
		vi.advanceTimersByTime(5_000);
		expect(toasts).toEqual([]);
	});

	it('keeps the window it announces to a screen reader while the visible count ticks down', () => {
		toast('Gesendet', 'success', 10_000, { label: 'Rückgängig', run: vi.fn(), countdown: true });
		vi.advanceTimersByTime(2_000);
		expect(toasts[0].left).toBe(8_000);
		expect(render(Toaster).body).toMatch(/rk-toast-sr[^>]*>, 10 Sekunden zum/);
	});

	it('offers an action as a button that closes the notice and runs it, e.g. taking an answer back', () => {
		const run = vi.fn();
		const id = toast('Antwort gesendet', 'success', 10_000, {
			label: 'Rückgängig',
			run,
			countdown: true
		});
		const html = render(Toaster).body;
		expect(html).toMatch(/Rückgängig[\s\S]*rk-toast-count[^>]*>10</);

		runAction(toasts.find((t) => t.id === id)!);
		expect(run).toHaveBeenCalledOnce();
		expect(toasts).toEqual([]);
	});

	it('ignores dismiss with an unknown id (a timer after closing by hand)', () => {
		const id = toast('Hallo');
		dismiss(id);
		vi.advanceTimersByTime(10_000);
		expect(toasts).toEqual([]);
	});
});
