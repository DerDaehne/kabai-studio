/** One stored or live run event, in seq order; the server has masked the payload already. */
export type TraceEvent = {
	seq: number;
	type: string;
	key: string | null;
	payload: Record<string, unknown>;
};

export type RunTraceState =
	'queued' | 'running' | 'waiting_approval' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

/** One run of a ticket as the Run-Akte loads it. */
export type RunTrace = {
	id: number;
	state: RunTraceState;
	/** Only for a failed run; `wayOut` is '' when the failure comment is missing. */
	failure?: { code: string; message: string; wayOut: string };
	/** The run that continues this paused one. */
	continuedBy?: number;
	/** Whether this run holds on a question the human has not answered yet. */
	waitsForAnswer: boolean;
	events: TraceEvent[];
};

/** A transient `run.phase` of the live stream; phases are never stored. */
export type Phase = {
	name: string;
	elapsedMs: number;
	tokens?: number;
	tokensPerSecond?: number;
	lastLine?: string;
};

export type TraceCall = {
	/** The tool call id; the result arrives under the key `<id>:result`. */
	id: string;
	tool: string;
	target: string;
	reason: string;
	reasonSource: string;
	args: unknown;
	result?: { summary: string; text: string; isError: boolean };
};

export type TraceStep = {
	number: number;
	reasoning?: { text: string; charsTotal: number };
	message?: string;
	calls: TraceCall[];
};

export type Intervention = {
	kind: string;
	attempt: number;
	max: number;
	reason: string;
	hint: string;
};

export type TraceItem =
	| { kind: 'step'; seq: number; step: TraceStep }
	| { kind: 'intervention'; seq: number; intervention: Intervention }
	| { kind: 'loading'; seq: number; text: string; hint: string };

export type Trace = {
	items: TraceItem[];
	/** The handoff; `generated` when the system wrote it because the agent left none. */
	report?: { text: string; generated: boolean };
	/** The hint of the newest model loading notice, for the ticker of a loading phase. */
	loadingHint?: string;
};

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');
const numberOf = (value: unknown) => (typeof value === 'number' ? value : 0);
const numbers = new Intl.NumberFormat('de-DE');

/** Groups a run's events into steps and the notices between them; events the trace does not show are left out. */
export function buildTrace(events: TraceEvent[]): Trace {
	const trace: Trace = { items: [] };
	const steps = new Map<number, TraceStep>();
	for (const event of events) {
		if (event.key === 'handoff') trace.report = reportOf(event.payload);
		else if (event.type === 'intervention') addIntervention(trace, event);
		else if (event.type === 'log' && event.payload.phase === 'model_loading')
			addLoading(trace, event);
		else if (typeof event.payload.step === 'number') addToStep(stepOf(trace, steps, event), event);
	}
	return trace;
}

const reportOf = (payload: TraceEvent['payload']) => ({
	text: textOf(payload.text),
	generated: payload.generated === true
});

function addIntervention(trace: Trace, { seq, payload }: TraceEvent) {
	const intervention: Intervention = {
		kind: textOf(payload.kind),
		attempt: numberOf(payload.attempt),
		max: numberOf(payload.max),
		reason: textOf(payload.reason),
		hint: textOf(payload.hint)
	};
	trace.items.push({ kind: 'intervention', seq, intervention });
}

function addLoading(trace: Trace, { seq, payload }: TraceEvent) {
	const hint = textOf(payload.hint);
	trace.items.push({ kind: 'loading', seq, text: textOf(payload.text), hint });
	trace.loadingHint = hint;
}

function stepOf(trace: Trace, steps: Map<number, TraceStep>, { seq, payload }: TraceEvent) {
	const number = payload.step as number;
	const known = steps.get(number);
	if (known) return known;
	const step: TraceStep = { number, calls: [] };
	steps.set(number, step);
	trace.items.push({ kind: 'step', seq, step });
	return step;
}

function addToStep(step: TraceStep, event: TraceEvent) {
	const { type, payload } = event;
	if (type === 'reasoning')
		step.reasoning = { text: textOf(payload.text), charsTotal: numberOf(payload.charsTotal) };
	else if (type === 'message') step.message = textOf(payload.text);
	else if (type === 'tool_call') step.calls.push(callOf(event));
	else if (type === 'tool_result') addResult(step, event);
}

const callOf = ({ seq, key, payload }: TraceEvent): TraceCall => ({
	id: key ?? `seq-${seq}`,
	tool: textOf(payload.tool),
	target: textOf(payload.target),
	reason: textOf(payload.reason),
	reasonSource: textOf(payload.reason_source),
	args: payload.args
});

function addResult(step: TraceStep, { key, payload }: TraceEvent) {
	const call = step.calls.find((c) => `${c.id}:result` === key);
	if (!call) return;
	call.result = {
		summary: textOf(payload.result_summary),
		text: textOf(payload.result),
		isError: payload.isError === true
	};
}

/** The reason of a call as the trace says it: honestly empty, or marked when it came from the reasoning. */
export function reasonText({ reason, reasonSource }: Pick<TraceCall, 'reason' | 'reasonSource'>) {
	if (!reason) return 'ohne Begründung';
	return reasonSource === 'reasoning' ? `denkt: ${reason}` : reason;
}

/** The short result of a call; '' while it runs or when its tool family has no summary. */
export function resultText(result: TraceCall['result']): string {
	if (!result) return '';
	return result.summary || (result.isError ? 'Fehler' : '');
}

export const firstLine = (text: string) =>
	text
		.split('\n')
		.find((line) => line.trim())
		?.trim() ?? '';

/** What a step without a call does, for the compact line. */
export function stepGist(step: TraceStep): string {
	if (step.message) return firstLine(step.message);
	if (step.reasoning) return `denkt: ${firstLine(step.reasoning.text)}`;
	return `Schritt ${step.number}`;
}

const PHASES: Record<string, string> = {
	thinking: 'denkt',
	writing: 'schreibt',
	tool: 'Werkzeug läuft',
	compacting: 'verdichtet den Kontext',
	model_loading: 'Modell lädt',
	model_downloading: 'Modell wird heruntergeladen'
};
const LOADING_PHASES = new Set(['model_loading', 'model_downloading']);

/** The ticker line of a running run's current phase. */
export function tickerText(phase: Phase, loadingHint = ''): string {
	const parts = [`${PHASES[phase.name] ?? phase.name} seit ${clock(phase.elapsedMs)}`];
	if (phase.tokens !== undefined) parts.push(`${numbers.format(phase.tokens)} Tok`);
	if (phase.tokensPerSecond !== undefined)
		parts.push(`${numbers.format(phase.tokensPerSecond)} Tok/s`);
	const line = LOADING_PHASES.has(phase.name) ? loadingHint : phase.lastLine;
	return line ? `${parts.join(' · ')} — ${line}` : parts.join(' · ');
}

function clock(ms: number) {
	const seconds = Math.floor(ms / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const formatCount = (n: number) => numbers.format(n);

const INTERVENTIONS: Record<string, string> = {
	length_stop: 'Längenlimit',
	stagnation: 'Stillstand',
	context_budget: 'Kontextgrenze',
	quota: 'Kontingent'
};
export const interventionLabel = (kind: string) => INTERVENTIONS[kind] ?? kind;

/** The stored event a live `run.event` carries. */
export const liveTraceEvent = (event: Record<string, unknown>): TraceEvent => ({
	seq: event.seq as number,
	type: event.eventType as string,
	key: (event.key as string | undefined) ?? null,
	payload: event.payload as TraceEvent['payload']
});

/**
 * The run's events with a live one added. `undefined` means events before it were missed (between load and
 * subscription, or while the connection was down): the caller loads the trace again.
 */
export function withLiveEvent(events: TraceEvent[], event: TraceEvent): TraceEvent[] | undefined {
	const last = events.at(-1)?.seq ?? 0;
	if (event.seq <= last) return events;
	return event.seq === last + 1 ? [...events, event] : undefined;
}
