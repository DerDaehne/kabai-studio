// Renders server-side: $effect does not run here, so `:run`, `x`/`y`, the ticking duration and live updates are covered
// by a headless-browser check; this file covers what the run control shows for given runs and profiles.
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import type { RunStart, RunTab } from './run-control';
import RunControl from './RunControl.svelte';

const tab = (overrides: Partial<RunTab>): RunTab => ({
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

const profiles: RunStart = {
	profiles: [
		{ id: 1, name: 'Cloud' },
		{ id: 2, name: 'Lokal' }
	],
	preselected: 2
};

type Props = { runs?: RunTab[]; start?: RunStart; selected?: number; form?: unknown };
const html = ({ runs = [], start = profiles, selected, form = null }: Props = {}) =>
	render(RunControl, { props: { runs, start, selected, form } as never }).body;
const text = (body: string) =>
	body
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ');

it('offers to start a run with the preselected profile chosen', () => {
	const body = html();
	expect(body).toMatch(/<form[^>]*action="\?\/start"/);
	expect(body).toMatch(/<option value="2"[^>]*selected[^>]*>Lokal<\/option>/);
	expect(body).not.toMatch(/<option value="1"[^>]*selected/);
	expect(text(body)).toContain('Run starten');
});

it('leads to creating a profile instead of a start without any profile', () => {
	const body = html({ start: { profiles: [] } });
	expect(text(body)).toContain('Noch kein Agent-Profil');
	expect(body).toMatch(/<a[^>]*href="\/settings\/profiles"[^>]*>Agent-Profil anlegen<\/a>/);
	expect(body).not.toContain('?/start');
});

it('shows each run as a tab with state as symbol and text, profile, duration, tokens and cost', () => {
	const runs = [
		tab({ id: 9, state: 'running', profile: 'Cloud', finishedAt: null }),
		tab({ id: 8, tokensIn: 12300, tokensOut: 800, cost: 0.25 }),
		tab({ id: 7, state: 'failed', profile: null })
	];
	const body = html({ runs, selected: 8 });
	const tabs = body.split('<li').slice(1);
	expect(tabs).toHaveLength(3);
	expect(tabs[0]).toMatch(/href="\?run=9"/);
	expect(tabs[0]).toMatch(
		/data-tone="running">(<!--[^>]*-->|\s)*<span class="dot[^>]*><\/span>(<!--[^>]*-->|\s)*läuft/
	);
	expect(text(tabs[0])).toContain('Cloud');
	expect(text(tabs[1])).toContain('Run 8');
	expect(text(tabs[1])).toContain('fertig');
	expect(text(tabs[1])).toContain('Lokal · 1:05 · Tokens 12.300 ein · 800 aus · 0,25 $');
	expect(text(tabs[2])).toContain('fehlgeschlagen');
	expect(text(tabs[2])).toContain('Profil gelöscht');
	expect(tabs[1]).toMatch(/aria-current="page"/);
	expect(tabs[0]).not.toMatch(/aria-current/);
});

it('names where a continuation run comes from and links its predecessor', () => {
	const runs = [
		tab({ id: 5, resumedFrom: 4, resumeReason: 'recovery' }),
		tab({ id: 4, resumedFrom: 3 }),
		tab({ id: 3 })
	];
	const tabs = html({ runs }).split('<li').slice(1);
	expect(text(tabs[0])).toContain('frischer Run nach Stillstand oder Längenlimit · aus Run 4');
	expect(tabs[0]).toMatch(/<a href="\?run=4"[^>]*>aus Run 4<\/a>/);
	expect(text(tabs[1])).toContain('Fortsetzung nach deiner Antwort · aus Run 3');
	expect(text(tabs[2])).not.toContain('aus Run');
});

it('says why a queued run waits', () => {
	const runs = [
		tab({
			id: 2,
			state: 'queued',
			startedAt: null,
			finishedAt: null,
			waitText: 'wartet: Pool „local“ ist voll (1 von 1 aktiv).'
		})
	];
	const body = html({ runs });
	expect(text(body)).toContain('wartet: Pool „local“ ist voll (1 von 1 aktiv).');
	expect(text(body)).toContain('wartet auf Start');
});

it('stops only after a confirmation: an active run offers „Stoppen“, but no stop form outside the dialog', () => {
	const runs = [
		tab({ id: 3, state: 'running', finishedAt: null }),
		tab({ id: 2, state: 'waiting_approval', finishedAt: null }),
		tab({ id: 1 })
	];
	const body = html({ runs, selected: 3 });
	const tabs = body.split('<li').slice(1);
	expect(text(tabs[0])).toContain('Stoppen (x)');
	expect(text(tabs[1])).toContain('Stoppen');
	expect(text(tabs[1])).not.toContain('(x)');
	expect(text(tabs[2])).not.toContain('Stoppen');
	expect(body).not.toContain('?/stop');
});

it('shows message and hint of a refused start at the start form', () => {
	const form = {
		action: 'start',
		code: 'not_found',
		message: 'Die Nachricht.',
		hint: 'Der Ausweg.'
	};
	expect(text(html({ form }))).toContain('Die Nachricht. Der Ausweg.');
	expect(text(html({ form: { ...form, action: 'move' } }))).not.toContain('Die Nachricht.');
});
