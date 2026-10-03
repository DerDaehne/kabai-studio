import { describe, expect, it, vi } from 'vitest';
import {
	durationText,
	originText,
	runCommands,
	stopTarget,
	usageText,
	type RunTab
} from './run-control';

const tab = (overrides: Partial<RunTab> = {}): RunTab => ({
	id: 1,
	state: 'succeeded',
	profile: 'Lokal',
	startedAt: '2026-10-03T10:00:00Z',
	finishedAt: '2026-10-03T10:01:05Z',
	tokensIn: 0,
	tokensOut: 0,
	cost: 0,
	resumedFrom: null,
	resumeReason: null,
	...overrides
});

describe('originText', () => {
	it('names why a continuation run exists, and nothing for a run the human started', () => {
		expect(originText(tab())).toBeUndefined();
		expect(originText(tab({ resumedFrom: 3 }))).toBe('Fortsetzung nach deiner Antwort');
		expect(originText(tab({ resumedFrom: 3, resumeReason: 'context_budget' }))).toBe(
			'frischer Run nach Kontextgrenze'
		);
		expect(originText(tab({ resumedFrom: 3, resumeReason: 'recovery' }))).toBe(
			'frischer Run nach Stillstand oder Längenlimit'
		);
		expect(originText(tab({ resumedFrom: 3, resumeReason: 'quota' }))).toBe(
			'Fortsetzung nach Kontingent-Pause'
		);
	});
});

describe('durationText', () => {
	const now = Date.parse('2026-10-03T10:02:00Z');

	it('measures a finished run from start to end', () => {
		expect(durationText(tab(), now)).toBe('1:05');
	});

	it('measures a running run up to now', () => {
		expect(durationText(tab({ state: 'running', finishedAt: null }), now)).toBe('2:00');
	});

	it('is empty for a run that never started', () => {
		expect(durationText(tab({ state: 'queued', startedAt: null, finishedAt: null }), now)).toBe('');
	});
});

describe('usageText', () => {
	it('names tokens in and out and the cost in dollars, a local run at zero', () => {
		expect(usageText(tab({ tokensIn: 12300, tokensOut: 800 }))).toBe(
			'Tokens 12.300 ein · 800 aus · 0,00\u00a0$'
		);
	});

	it('keeps a fraction of a cent visible', () => {
		expect(usageText(tab({ cost: 0.0123 }))).toBe('Tokens 0 ein · 0 aus · 0,0123\u00a0$');
	});
});

describe('stopTarget', () => {
	const tabs = [
		tab({ id: 9, state: 'succeeded' }),
		tab({ id: 8, state: 'running' }),
		tab({ id: 7, state: 'queued' })
	];

	it('stops the selected run while it is active', () => {
		expect(stopTarget(tabs, 7)?.id).toBe(7);
	});

	it('falls back to the newest active run when the selected one has ended', () => {
		expect(stopTarget(tabs, 9)?.id).toBe(8);
	});

	it('treats a run waiting for approval as active and an ended one as not', () => {
		expect(stopTarget([tab({ id: 4, state: 'waiting_approval' })], 4)?.id).toBe(4);
		expect(stopTarget([tab({ state: 'paused' }), tab({ state: 'cancelled' })], 1)).toBeUndefined();
	});
});

describe('runCommands', () => {
	const profiles = [
		{ id: 1, name: 'Cloud' },
		{ id: 2, name: 'Lokal' }
	];

	it('offers :run with the chosen profile first and one :run per other profile', () => {
		const startWith = vi.fn();
		const found = runCommands(profiles, 2, startWith);
		expect(found.map((c) => [c.id, c.label, c.detail])).toEqual([
			['run', ':run', 'Run starten mit „Lokal“'],
			['run-1', ':run Cloud', 'Run mit diesem Profil starten']
		]);
		expect(found.every((c) => c.available !== false)).toBe(true);
		found[0].run?.();
		found[1].run?.();
		expect(startWith.mock.calls).toEqual([[2], [1]]);
	});

	it('leads to the profile settings while there is no profile', () => {
		expect(runCommands([], undefined, vi.fn())).toEqual([
			{
				id: 'run',
				label: ':run',
				detail: 'Erst ein Agent-Profil anlegen',
				href: '/settings/profiles'
			}
		]);
	});
});
