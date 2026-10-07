import type { FinishReason } from 'ai';

/** One tool call of a step; `target` is what it works on (file, command, note, ticket) and empty when the call names none. */
export type CallRecord = { tool: string; target: string; isError: boolean; progress: boolean };
/** What one step did, for deciding how the run ends and for spotting a stuck run. */
export type StepRecord = {
	step: number;
	finishReason: FinishReason;
	inputTokens?: number;
	reasoningTokens?: number;
	calls: CallRecord[];
};
export type GuardLimits = { reasoningBudget?: number };
export type StallCause = 'length_stop' | 'failing_calls' | 'no_progress' | 'reasoning_budget';
/** What got a run stuck: `cause` picks the hint, `kind` is the kind of its intervention event. */
export type Stall = {
	kind: 'length_stop' | 'stagnation';
	cause: StallCause;
	reason: string;
	stepTokens?: number;
};

// ponytail: fixed thresholds from the coding pilot; move them into the model catalog once measured runs ask for per-model values
const FAILED_CALLS_IN_A_ROW = 3;
const CALLS_WITHOUT_PROGRESS = 6;
const STEPS_AT_REASONING_BUDGET = 3;
const REASONING_BUDGET_SHARE = 0.95;
// ponytail: a fixed recovery policy for every project; make it configurable once practice asks for it
export const RECOVERY = { hintsPerRun: 2, freshRunsPerChain: 1 } as const;

const HINTS: Record<StallCause, string> = {
	length_stop:
		'Your answer hit the output limit. Your plan was good, do not re-plan: think briefly, then take the smallest next action. Decide, change, verify.',
	failing_calls:
		'The same call keeps failing: do not repeat or inspect it again. Read the error and take another route; for an exact edit, replace by line number or rewrite the block.',
	no_progress:
		'You keep working on the same target without changing anything. You know enough: take the smallest action that makes progress, then verify it.',
	reasoning_budget:
		'You keep thinking up to the reasoning budget. Your plan was good, do not re-plan: take the smallest next action. Decide, change, verify.'
};

/** The fixed hint a stuck run gets as its next user message. */
export const recoveryHint = (cause: StallCause): string => HINTS[cause];

/** The first rule the given steps break, or nothing while the run makes headway; pass only the steps since the last hint. */
export function detectStagnation(
	records: readonly StepRecord[],
	limits: GuardLimits
): Stall | undefined {
	const calls = records.flatMap((record) => record.calls);
	return (
		failingCalls(calls) ??
		callsWithoutProgress(calls) ??
		stepsAtReasoningBudget(records, limits) ??
		lengthStop(records)
	);
}

const subjectOf = (call: CallRecord) => call.target || call.tool;
const sameSubject = (call: CallRecord, previous: CallRecord) =>
	subjectOf(call) === subjectOf(previous);

function failingCalls(calls: CallRecord[]): Stall | undefined {
	const row = longestRow(calls, (call) => call.isError, sameSubject);
	if (row.length < FAILED_CALLS_IN_A_ROW) return undefined;
	const reason = `${row.length} failed calls in a row on "${subjectOf(row[0])}".`;
	return { kind: 'stagnation', cause: 'failing_calls', reason };
}

function callsWithoutProgress(calls: CallRecord[]): Stall | undefined {
	const row = longestRow(calls, (call) => !call.progress, sameSubject);
	if (row.length < CALLS_WITHOUT_PROGRESS) return undefined;
	const reason = `${row.length} calls in a row on "${subjectOf(row[0])}" without progress.`;
	return { kind: 'stagnation', cause: 'no_progress', reason };
}

function stepsAtReasoningBudget(records: readonly StepRecord[], limits: GuardLimits) {
	const atBudget = ({ finishReason, reasoningTokens = 0 }: StepRecord) =>
		finishReason === 'length' ||
		(limits.reasoningBudget !== undefined &&
			reasoningTokens >= REASONING_BUDGET_SHARE * limits.reasoningBudget);
	const row = longestRow(records, atBudget);
	if (row.length < STEPS_AT_REASONING_BUDGET) return undefined;
	const budget = limits.reasoningBudget ? ` of ${limits.reasoningBudget} tokens` : '';
	return {
		kind: 'stagnation',
		cause: 'reasoning_budget',
		reason: `${row.length} steps in a row ended at the reasoning budget${budget} or the output limit.`,
		stepTokens: row[row.length - 1].reasoningTokens
	} satisfies Stall;
}

function lengthStop(records: readonly StepRecord[]): Stall | undefined {
	const cut = records.findLast((record) => record.finishReason === 'length');
	if (!cut) return undefined;
	return {
		kind: 'length_stop',
		cause: 'length_stop',
		reason: `Step ${cut.step} hit the output limit before it finished.`,
		stepTokens: cut.reasoningTokens
	};
}

/** The longest row of consecutive items that each count and each belong with the one before. */
function longestRow<T>(
	items: readonly T[],
	counts: (item: T) => boolean,
	belongs: (item: T, previous: T) => boolean = () => true
): T[] {
	let longest: T[] = [];
	let row: T[] = [];
	for (const item of items) {
		const previous = row.at(-1);
		if (!counts(item)) row = [];
		else if (previous !== undefined && belongs(item, previous)) row.push(item);
		else row = [item];
		if (row.length > longest.length) longest = row;
	}
	return longest;
}
