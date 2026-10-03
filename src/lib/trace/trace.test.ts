import { describe, expect, it } from 'vitest';
import { RUN_EVENTS } from './fixtures';
import {
	buildTrace,
	firstLine,
	liveTraceEvent,
	reasonText,
	resultText,
	stepGist,
	tickerText,
	withLiveEvent,
	type TraceStep
} from './trace';

const steps = () =>
	buildTrace(RUN_EVENTS).items.flatMap((item) => (item.kind === 'step' ? [item.step] : []));

describe('buildTrace', () => {
	it('groups the events by step and pairs every result with its call by the call id, even out of order', () => {
		const [first, second] = steps();
		expect(first.number).toBe(1);
		expect(first.reasoning).toEqual({
			text: '\nThe ticket asks for a CSV export.\nI read the ticket first.',
			charsTotal: 4321
		});
		expect(first.calls).toEqual([
			{
				id: 'call-1',
				tool: 'get_ticket',
				target: '',
				reason: 'I read the ticket first.',
				reasonSource: 'reasoning',
				args: {},
				result: { summary: '', text: '{"ref":"STU-1","title":"Export"}', isError: false }
			}
		]);
		expect(second.message).toBe('I complete the first task.');
		expect(
			second.calls.map((c) => [c.tool, c.target, c.result?.summary, c.result?.isError])
		).toEqual([
			['complete_tasks', '', '1 erledigt · 1 offen', false],
			['notes_search', 'csv export', 'Fehler: not_found', true]
		]);
	});

	it('leaves trace fields an older or foreign executor did not write honestly empty instead of guessing them', () => {
		const third = steps()[2];
		expect(third.calls).toEqual([
			{
				id: 'call-4',
				tool: 'move_ticket',
				target: '',
				reason: '',
				reasonSource: '',
				args: { column: 'Review' }
			}
		]);
	});

	it('keeps interventions and model loading notices between the steps in event order and the report apart', () => {
		const trace = buildTrace(RUN_EVENTS);
		expect(trace.items.map((item) => [item.kind, item.seq])).toEqual([
			['step', 2],
			['step', 6],
			['intervention', 11],
			['loading', 12],
			['step', 13]
		]);
		expect(trace.items[2]).toMatchObject({
			intervention: {
				kind: 'stagnation',
				attempt: 1,
				max: 2,
				reason: 'Drei Aufrufe in Folge auf dasselbe Ziel sind fehlgeschlagen.',
				hint: 'exact edit keeps failing: replace by line number'
			}
		});
		expect(trace.items[3]).toMatchObject({
			text: 'Modell wird geladen …',
			hint: 'Das Modell hat nach 30 s noch nicht geantwortet.'
		});
		expect(trace.loadingHint).toBe('Das Modell hat nach 30 s noch nicht geantwortet.');
		expect(trace.report).toEqual({ text: 'Export gebaut, Ticket in Review.', generated: true });
	});

	it('marks a report the agent wrote itself as not generated', () => {
		const own = buildTrace([
			{ seq: 1, type: 'message', key: 'handoff', payload: { text: 'Fertig.' } }
		]);
		expect(own.report).toEqual({ text: 'Fertig.', generated: false });
		expect(own.items).toEqual([]);
	});
});

describe('the words of a step', () => {
	it('says „ohne Begründung“ for an empty reason and prefixes one taken from the reasoning with „denkt:“', () => {
		expect(reasonText({ reason: '', reasonSource: '' })).toBe('ohne Begründung');
		expect(reasonText({ reason: 'I read it.', reasonSource: 'reasoning' })).toBe(
			'denkt: I read it.'
		);
		expect(reasonText({ reason: 'I read it.', reasonSource: 'text' })).toBe('I read it.');
	});

	it('shows the short result, „Fehler“ for a failure without one and nothing while the call still runs', () => {
		expect(resultText({ summary: '2 Treffer', text: '', isError: false })).toBe('2 Treffer');
		expect(resultText({ summary: '', text: 'boom', isError: true })).toBe('Fehler');
		expect(resultText({ summary: '', text: '{}', isError: false })).toBe('');
		expect(resultText(undefined)).toBe('');
	});

	it('takes the first non-empty line of a text', () => {
		expect(firstLine('\n  \n  The ticket asks.\nNext.')).toBe('The ticket asks.');
		expect(firstLine('')).toBe('');
	});

	it('sums up a step without a call by its message, else its reasoning, else its number', () => {
		const step: TraceStep = { number: 4, calls: [] };
		expect(stepGist(step)).toBe('Schritt 4');
		expect(stepGist({ ...step, reasoning: { text: 'Hm.\nMore.', charsTotal: 9 } })).toBe(
			'denkt: Hm.'
		);
		expect(stepGist({ ...step, message: 'Done.', reasoning: { text: 'Hm.', charsTotal: 3 } })).toBe(
			'Done.'
		);
	});
});

describe('tickerText', () => {
	it('shows the phase with its duration, tokens, rate and last line', () => {
		expect(
			tickerText({
				name: 'thinking',
				elapsedMs: 42_900,
				tokens: 1200,
				tokensPerSecond: 31,
				lastLine: 'So the export needs a header row.'
			})
		).toBe('denkt seit 0:42 · 1.200 Tok · 31 Tok/s — So the export needs a header row.');
		expect(tickerText({ name: 'writing', elapsedMs: 192_000 })).toBe('schreibt seit 3:12');
	});

	it('names a loading model with the hint of the loading notice', () => {
		expect(tickerText({ name: 'model_loading', elapsedMs: 31_000 }, 'Warten oder abbrechen.')).toBe(
			'Modell lädt seit 0:31 — Warten oder abbrechen.'
		);
		expect(tickerText({ name: 'model_loading', elapsedMs: 1000 })).toBe('Modell lädt seit 0:01');
	});
});

describe('live events', () => {
	const loaded = RUN_EVENTS.slice(0, 3);

	it('reads the stored event out of a live run.event, key included', () => {
		expect(
			liveTraceEvent({
				type: 'run.event',
				runId: 1,
				seq: 4,
				eventType: 'tool_result',
				key: 'call-1:result',
				payload: { step: 1 }
			})
		).toEqual({ seq: 4, type: 'tool_result', key: 'call-1:result', payload: { step: 1 } });
		expect(
			liveTraceEvent({ type: 'run.event', seq: 1, eventType: 'log', payload: {} }).key
		).toBeNull();
	});

	it('appends the next event, ignores one the load already had and reports missed ones', () => {
		expect(withLiveEvent(loaded, RUN_EVENTS[3])).toEqual(RUN_EVENTS.slice(0, 4));
		expect(withLiveEvent(loaded, RUN_EVENTS[2])).toBe(loaded);
		expect(withLiveEvent(loaded, RUN_EVENTS[4])).toBeUndefined();
		expect(withLiveEvent([], RUN_EVENTS[0])).toEqual([RUN_EVENTS[0]]);
	});
});
