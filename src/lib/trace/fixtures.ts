import type { TraceEvent } from './trace';

const event = (
	seq: number,
	type: string,
	key: string | null,
	payload: Record<string, unknown>
): TraceEvent => ({ seq, type, key, payload });

/**
 * The events of a builtin run as the executor writes them: a prompt log, a step that reads the ticket (reason from
 * the reasoning), a step with two calls whose results arrive out of order, a call written before the trace fields
 * existed, an intervention, a model loading notice and the closing report.
 */
export const RUN_EVENTS: TraceEvent[] = [
	event(1, 'log', null, { kind: 'prompt', estimate: 1200, toolTokens: 300 }),
	event(2, 'reasoning', 'step:1:reasoning', {
		step: 1,
		text: '\nThe ticket asks for a CSV export.\nI read the ticket first.',
		charsTotal: 4321
	}),
	event(3, 'tool_call', 'call-1', {
		step: 1,
		tool: 'get_ticket',
		args: {},
		target: '',
		reason: 'I read the ticket first.',
		reason_source: 'reasoning',
		next_hint: ''
	}),
	event(4, 'tool_result', 'call-1:result', {
		step: 1,
		tool: 'get_ticket',
		result: '{"ref":"STU-1","title":"Export"}',
		isError: false,
		result_summary: ''
	}),
	event(5, 'log', 'step:1', { kind: 'step', step: 1, finishReason: 'tool-calls', ms: 900 }),
	event(6, 'message', 'step:2:message', { step: 2, text: 'I complete the first task.' }),
	event(7, 'tool_call', 'call-2', {
		step: 2,
		tool: 'complete_tasks',
		args: { task_ids: [1] },
		target: '',
		reason: 'I complete the first task.',
		reason_source: 'text',
		next_hint: ''
	}),
	event(8, 'tool_call', 'call-3', {
		step: 2,
		tool: 'notes_search',
		args: { query: 'csv export' },
		target: 'csv export',
		reason: '',
		reason_source: '',
		next_hint: ''
	}),
	event(9, 'tool_result', 'call-3:result', {
		step: 2,
		tool: 'notes_search',
		result: '{"notes":[]}',
		isError: true,
		result_summary: 'Fehler: not_found'
	}),
	event(10, 'tool_result', 'call-2:result', {
		step: 2,
		tool: 'complete_tasks',
		result: '{"completed":[1]}',
		isError: false,
		result_summary: '1 erledigt · 1 offen'
	}),
	event(11, 'intervention', null, {
		kind: 'stagnation',
		attempt: 1,
		max: 2,
		reason: 'Drei Aufrufe in Folge auf dasselbe Ziel sind fehlgeschlagen.',
		hint: 'exact edit keeps failing: replace by line number'
	}),
	event(12, 'log', 'model_loading', {
		phase: 'model_loading',
		text: 'Modell wird geladen …',
		hint: 'Das Modell hat nach 30 s noch nicht geantwortet.'
	}),
	event(13, 'tool_call', 'call-4', { step: 3, tool: 'move_ticket', args: { column: 'Review' } }),
	event(14, 'message', 'handoff', { text: 'Export gebaut, Ticket in Review.', generated: true })
];
