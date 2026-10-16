import { connection } from './connection.svelte';
import { haltDetail, haltWord, resumeAll } from './halt';
import { live } from './live.svelte';

export type BannerState = {
	word: string;
	text: string;
	status: 'error' | 'warning';
	/** Only a halt interrupts a screen reader; the other states are announced politely. */
	alert: boolean;
	action: { label: string; run: () => void } | { label: string; href: string };
};

/** The one lasting state the banner shows, the most severe first: a stop, a lost session, a pause, a lost connection. */
export function standingBanner(): BannerState | null {
	const resume = { label: 'Fortsetzen', run: () => void resumeAll() };
	if (live.halt === 'stop')
		return {
			word: haltWord('stop'),
			text: haltDetail('stop', live.runs),
			status: 'error',
			alert: true,
			action: resume
		};
	if (connection.lost === 'expired')
		return {
			word: 'Abgemeldet',
			text: 'Sitzung abgelaufen, Live-Updates gestoppt.',
			status: 'error',
			alert: false,
			action: { label: 'Neu anmelden', href: '/login' }
		};
	if (live.halt === 'pause')
		return {
			word: haltWord('pause'),
			text: haltDetail('pause', live.runs),
			status: 'warning',
			alert: false,
			action: resume
		};
	if (connection.lost === 'offline')
		return {
			word: 'Getrennt',
			text: 'Verbindung unterbrochen, Daten evtl. veraltet. Studio versucht es weiter.',
			status: 'warning',
			alert: false,
			action: { label: 'Neu laden', run: () => location.reload() }
		};
	return null;
}
