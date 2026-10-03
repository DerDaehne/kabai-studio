// Renders server-side: $effect does not run here, so live arrival, the ticker of a live phase and expanding by keyboard
// are covered by a headless-browser check; this file covers what the trace shows for a given set of events.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { RUN_EVENTS } from './fixtures';
import RunTrace from './RunTrace.svelte';
import { buildTrace, type RunTrace as Trace } from './trace';
import TraceStep from './TraceStep.svelte';

const base: Trace = { id: 7, state: 'running', waitsForAnswer: false, events: RUN_EVENTS };
const html = (trace: Partial<Trace> = {}) =>
	render(RunTrace, { props: { trace: { ...base, ...trace }, reload: () => {} } }).body;
const text = (body: string) =>
	body
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ');
const [first, second] = buildTrace(RUN_EVENTS).items.flatMap((i) =>
	i.kind === 'step' ? [i.step] : []
);

describe('steps', () => {
	it('shows every call as tool · target · reason · short result, an empty reason as „ohne Begründung“', () => {
		const shown = text(html());
		expect(shown).toContain('Schritt 1');
		expect(shown).toContain('get_ticket · denkt: I read the ticket first.');
		expect(shown).toContain('complete_tasks · I complete the first task. · 1 erledigt · 1 offen');
		expect(shown).toContain('notes_search · csv export · ohne Begründung · ✗ Fehler: not_found');
		expect(shown).toContain('move_ticket · ohne Begründung');
	});

	it('marks a failed call with a symbol besides the „Fehler“ text', () => {
		expect(html()).toMatch(
			/class="result[^"]* error">(<!--[^>]*-->|\s)*<span aria-hidden="true">✗<\/span>/
		);
	});

	it('shows the message of a step as a line of its own', () => {
		expect(html()).toMatch(/<p class="message[^"]*">I complete the first task\.<\/p>/);
	});
});

describe('details', () => {
	it('puts arguments and result of every call into a closed native disclosure, opened by click or keyboard', () => {
		const body = html();
		const calls = [...body.matchAll(/<details class="call[^"]*">([\s\S]*?)<\/details>/g)];
		expect(calls).toHaveLength(4);
		expect(calls[1][1]).toMatch(/<summary[^>]*>[\s\S]*complete_tasks[\s\S]*<\/summary>/);
		expect(calls[1][1]).toContain('Argumente');
		expect(calls[1][1]).toContain(JSON.stringify({ task_ids: [1] }, null, 2));
		expect(calls[1][1]).toContain('Ergebnis');
		expect(calls[1][1]).toContain('{"completed":[1]}');
		expect(body).not.toMatch(/<details[^>]* open/);
	});

	it('says so when a call has no result yet', () => {
		const calls = [...html().matchAll(/<details class="call[^"]*">([\s\S]*?)<\/details>/g)];
		expect(calls[3][1]).toContain('Noch kein Ergebnis.');
	});

	it('folds the reasoning away behind its first line and its length', () => {
		const reasoning = html().match(/<details class="reasoning[^"]*">([\s\S]*?)<\/details>/)![1];
		expect(text(reasoning)).toContain('denkt: The ticket asks for a CSV export. (4.321 Zeichen)');
		expect(reasoning).toContain('I read the ticket first.');
		expect(text(reasoning)).toContain('Gekürzt: gespeichert sind die letzten');
	});
});

describe('ticker', () => {
	it('says only „läuft“ for a running run until the first phase arrives, as after a reload', () => {
		const body = html();
		expect(body).not.toContain('class="ticker');
		expect(text(body).match(/läuft/g)).toHaveLength(1);
	});

	it('shows no ticker once the run has ended', () => {
		expect(html({ state: 'succeeded' })).not.toContain('class="ticker');
	});
});

describe('interventions and notices', () => {
	it('shows an intervention with kind, reason, the hint the agent got and „fortgesetzt attempt/max“', () => {
		const shown = text(html());
		expect(shown).toContain('Eingriff: Stillstand');
		expect(shown).toContain('fortgesetzt 1/2');
		expect(shown).toContain('Drei Aufrufe in Folge auf dasselbe Ziel sind fehlgeschlagen.');
		expect(shown).toContain(
			'Hinweis an den Agent: exact edit keeps failing: replace by line number'
		);
	});

	it('shows the model loading notice with its hint', () => {
		expect(text(html())).toContain(
			'Modell wird geladen … Das Modell hat nach 30 s noch nicht geantwortet.'
		);
	});
});

describe('end of a run', () => {
	it('names the run and its state with symbol and text', () => {
		const body = html();
		expect(text(body)).toContain('Run 7');
		expect(body).toMatch(
			/data-tone="running">(<!--[^>]*-->|\s)*<span class="dot[^>]*><\/span>(<!--[^>]*-->|\s)*läuft/
		);
	});

	it('highlights the closing report of a succeeded run and marks a generated one as „erzeugt“', () => {
		const body = html({ state: 'succeeded' });
		const report = body.match(/<section class="report[^"]*"[^>]*>([\s\S]*?)<\/section>/)![1];
		expect(text(report)).toContain('Abschlussbericht');
		expect(text(report)).toContain('erzeugt');
		expect(text(report)).toContain('Export gebaut, Ticket in Review.');
		expect(text(body)).toContain('fertig');
	});

	it('shows a report the agent wrote itself without the „erzeugt“ mark', () => {
		const events = [{ seq: 1, type: 'message', key: 'handoff', payload: { text: 'Fertig.' } }];
		const report = html({ state: 'succeeded', events }).match(
			/<section class="report[^"]*"[^>]*>([\s\S]*?)<\/section>/
		)![1];
		expect(text(report)).not.toContain('erzeugt');
	});

	it('shows code, message and way out of a failed run', () => {
		const shown = text(
			html({
				state: 'failed',
				failure: {
					code: 'step_limit',
					message: 'Der Run hat nach 24 Schritten aufgehört.',
					wayOut: 'Erhöhe max_steps im Agent-Profil.'
				}
			})
		);
		expect(shown).toContain('fehlgeschlagen');
		expect(shown).toContain('step_limit Der Run hat nach 24 Schritten aufgehört.');
		expect(shown).toContain('Ausweg: Erhöhe max_steps im Agent-Profil.');
	});

	it('shows no way-out line when the failure comment is missing', () => {
		const shown = text(
			html({ state: 'failed', failure: { code: 'executor_error', message: 'boom', wayOut: '' } })
		);
		expect(shown).toContain('executor_error boom');
		expect(shown).not.toContain('Ausweg');
	});

	it('points a paused run that waits for the human to the Takt, and one with a follow-up to that run', () => {
		const waiting = html({ state: 'paused', waitsForAnswer: true });
		expect(waiting).toMatch(/<a href="\/takt"[^>]*>wartet auf deine Antwort → Takt<\/a>/);
		const continued = html({ state: 'paused', continuedBy: 9 });
		expect(continued).toMatch(/<a href="\?run=9"[^>]*>setzt fort in Run 9<\/a>/);
		expect(continued).not.toContain('/takt');
		expect(text(continued)).toContain('Übergabe');
	});

	it('says „gestoppt“ for a cancelled run', () => {
		expect(html({ state: 'cancelled' })).toMatch(/data-tone="neutral">(<!--[^>]*-->|\s)*gestoppt/);
	});

	it('says so when a run has no steps yet', () => {
		expect(text(html({ state: 'queued', events: [] }))).toContain('Noch keine Schritte.');
	});
});

describe('TraceStep', () => {
	it('renders the full step with its calls and details', () => {
		const body = render(TraceStep, { props: { step: second } }).body;
		expect(text(body)).toContain('Schritt 2');
		expect(body.match(/<details class="call/g)).toHaveLength(2);
	});

	it('renders the compact line of the current call only, without details, as the Stellwerk shows it', () => {
		const body = render(TraceStep, { props: { step: second, compact: true } }).body;
		expect(text(body).trim()).toBe('notes_search · csv export · ohne Begründung');
		expect(body).not.toContain('<details');
		expect(body).not.toContain('Schritt 2');
	});

	it('sums up a compact step without a call by what it says or thinks', () => {
		const body = render(TraceStep, {
			props: { step: { ...first, calls: [] }, compact: true }
		}).body;
		expect(text(body).trim()).toBe('denkt: The ticket asks for a CSV export.');
	});
});
