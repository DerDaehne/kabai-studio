export type Lage = 'waiting' | 'working' | 'open' | 'acceptance' | 'done';
export type LagePhase = 'open' | 'work' | 'acceptance' | 'done';
export type LageRun = 'queued' | 'running' | 'paused' | 'failed';

export type LageInput = {
	phase: LagePhase;
	/** The state of the newest run; successful and cancelled runs count as `null`. */
	run: LageRun | null;
	openQuestions: number;
	pendingApproval: boolean;
	openProposals: number;
	/** Refs of the `blocks` predecessors that are still open. */
	openPredecessors: string[];
	autoAccepted: boolean;
	/** Why the queued run does not start yet; set when `run` is `queued`. */
	capacityText: string | null;
};

export type LageReason =
	| { kind: 'done' | 'auto_accepted' | 'acceptance' | 'working' }
	| { kind: 'question' | 'approval' | 'proposal' | 'failure' }
	| { kind: 'predecessors'; refs: string[] }
	| { kind: 'capacity'; text: string }
	| { kind: 'paused' | 'not_prioritized' | 'ready' };

export type LageResult = { lage: Lage; reason: LageReason };

const waitingFor = (input: LageInput): LageReason['kind'] | null => {
	if (input.openQuestions > 0) return 'question';
	if (input.pendingApproval) return 'approval';
	if (input.openProposals > 0) return 'proposal';
	if (input.run === 'failed') return 'failure';
	return null;
};

function whyOpen(input: LageInput): LageReason {
	if (input.openPredecessors.length) return { kind: 'predecessors', refs: input.openPredecessors };
	if (input.run === 'queued') return { kind: 'capacity', text: input.capacityText ?? 'queued' };
	if (input.run === 'paused') return { kind: 'paused' };
	if (input.phase === 'open') return { kind: 'not_prioritized' };
	return { kind: 'ready' };
}

/** The human state of a ticket, derived; the first matching row of the rule table wins. */
export function lageOf(input: LageInput): LageResult {
	if (input.phase === 'done')
		return { lage: 'done', reason: { kind: input.autoAccepted ? 'auto_accepted' : 'done' } };
	const waiting = waitingFor(input);
	if (waiting) return { lage: 'waiting', reason: { kind: waiting } as LageReason };
	if (input.phase === 'acceptance') return { lage: 'acceptance', reason: { kind: 'acceptance' } };
	if (input.run === 'running') return { lage: 'working', reason: { kind: 'working' } };
	return { lage: 'open', reason: whyOpen(input) };
}

export type Progress = { index: number; total: number };

/** The place of a step among the work and acceptance steps of its variant, e.g. 3 of 5; backlog is 0, done is the last. */
export function progressOf(steps: readonly string[], step: string): Progress {
	const counted = steps.filter((s) => s !== 'backlog' && s !== 'done');
	if (step === 'done') return { index: counted.length, total: counted.length };
	return { index: counted.indexOf(step) + 1, total: counted.length };
}
