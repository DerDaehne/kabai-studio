import { afterEach, describe, expect, it } from 'vitest';
import { standingBanner } from './banner.svelte';
import { connection } from './connection.svelte';
import { live } from './live.svelte';

afterEach(() => {
	live.halt = null;
	connection.lost = null;
});

describe('the standing banner', () => {
	it('shows nothing while nothing stands', () => {
		expect(standingBanner()).toBeNull();
	});

	it.each([
		['a stop', 'stop', null, 'Gestoppt', 'error'],
		['a lost session', null, 'expired', 'Abgemeldet', 'error'],
		['a pause', 'pause', null, 'Angehalten', 'warning'],
		['a lost connection', null, 'offline', 'Getrennt', 'warning']
	] as const)('names %s in a word and a severity', (_name, halt, lost, word, status) => {
		live.halt = halt;
		connection.lost = lost;
		expect(standingBanner()).toMatchObject({ word, status });
	});

	it('shows the most severe state first: stop, lost session, pause, lost connection', () => {
		live.halt = 'pause';
		connection.lost = 'offline';
		expect(standingBanner()?.word).toBe('Angehalten');
		connection.lost = 'expired';
		expect(standingBanner()?.word).toBe('Abgemeldet');
		live.halt = 'stop';
		expect(standingBanner()?.word).toBe('Gestoppt');
	});

	it('interrupts a screen reader for a stop only', () => {
		const alerting = (halt: typeof live.halt, lost: typeof connection.lost) => {
			live.halt = halt;
			connection.lost = lost;
			return standingBanner()?.alert;
		};
		expect(alerting('stop', null)).toBe(true);
		expect(alerting(null, 'expired')).toBe(false);
		expect(alerting('pause', null)).toBe(false);
		expect(alerting(null, 'offline')).toBe(false);
	});

	it('offers a way out in every state', () => {
		live.halt = null;
		connection.lost = 'expired';
		expect(standingBanner()?.action).toEqual({ label: 'Neu anmelden', href: '/login' });
		connection.lost = 'offline';
		expect(standingBanner()?.action).toMatchObject({ label: 'Neu laden' });
		live.halt = 'pause';
		expect(standingBanner()?.action).toMatchObject({ label: 'Fortsetzen' });
	});
});
