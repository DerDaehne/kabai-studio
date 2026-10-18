export type Lage = 'waiting' | 'working' | 'open' | 'acceptance' | 'done';
export type LagePhase = 'open' | 'work' | 'acceptance' | 'done';
export type LageRun = 'queued' | 'running' | 'paused' | 'failed' | 'stalled';

/** Why a queued run does not start yet, as a code with parameters; the UI translates it. */
export type WaitCause =
	| { code: 'halt_stop' | 'halt_pause' | 'claim' }
	| { code: 'pool_full'; pool: string; active: number; limit: number }
	| { code: 'global_full'; active: number; limit: number }
	| { code: 'ahead'; count: number }
	| { code: 'machine_offline'; machine: string; since: string }
	| { code: 'machine_never_connected' | 'machine_unpaired'; machine: string };

export type LageInput = {
	phase: LagePhase;
	/** The state that counts of the ticket's runs; `stalled` is a run that ended without finishing its step, other successful and cancelled runs count as `null`. */
	run: LageRun | null;
	openQuestions: number;
	pendingApproval: boolean;
	openProposals: number;
	/** Refs of the `blocks` predecessors that are still open. */
	openPredecessors: string[];
	autoAccepted: boolean;
	/** Why the queued run does not start yet; set when `run` is `queued`. */
	capacity: WaitCause[] | null;
};

export type LageReason =
	| { kind: 'done' | 'auto_accepted' | 'acceptance' | 'working' }
	| { kind: 'question' | 'approval' | 'proposal' | 'failure' | 'stalled' }
	| { kind: 'predecessors'; refs: string[] }
	| { kind: 'capacity'; causes: WaitCause[] }
	| { kind: 'paused' | 'not_prioritized' | 'ready' };

export type LageResult = { lage: Lage; reason: LageReason };

const waitingFor = (input: LageInput): LageReason['kind'] | null => {
	if (input.openQuestions > 0) return 'question';
	if (input.pendingApproval) return 'approval';
	if (input.openProposals > 0) return 'proposal';
	if (input.run === 'failed') return 'failure';
	if (input.run === 'stalled') return 'stalled';
	return null;
};

function whyOpen(input: LageInput): LageReason {
	if (input.openPredecessors.length) return { kind: 'predecessors', refs: input.openPredecessors };
	if (input.run === 'queued')
		return { kind: 'capacity', causes: input.capacity ?? [{ code: 'claim' }] };
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
