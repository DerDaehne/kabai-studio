import type { Stall } from '../agents/loop-guard';
import type { appendEvent, Profile, Usage } from '../domain/runs';

export type RunContext = {
	id: number;
	ticketId: number;
	projectId: number;
	token: string;
	profile: Profile & { id: number };
};
export type EmitRunEvent = (event: Parameters<typeof appendEvent>[3]) => {
	seq: number;
	duplicate: boolean;
};
export type PhaseName =
	'thinking' | 'writing' | 'tool' | 'compacting' | 'model_loading' | 'model_downloading';
/** Raw progress of a phase; the runner counts it per step and phase and publishes it paced, as `run.phase` on the bus. */
export type PhaseReport = {
	name: PhaseName;
	/** The step the phase belongs to: the counters start anew with each step. */
	step: number;
	/** The text of this phase in the step so far; the runner shows its last complete line, masked. */
	text?: string;
	/** Tokens since the last report, 1 by default; 0 for a phase without output such as loading the model. */
	tokens?: number;
};
/** A request to run a tool call; `key` is the tool call id, so the same request again records no second event. */
export type ApprovalRequest = { key: string; kind: string; title: string; input?: unknown };
/** `cancelled`: the run ended while the request waited, by cancel or pause; the run has no further state change. */
export type ApprovalDecision = 'allow_once' | 'allow_always' | 'reject' | 'cancelled';
export type ExecutorIo = {
	/** Fires when the run is cancelled or paused by the human: it has already ended by then and `emit` throws `run_not_active`. */
	signal: AbortSignal;
	/** Fires when the run should end after its current step: stop at the next tool call and resolve `parked`. */
	park: AbortSignal;
	emit: EmitRunEvent;
	phase: (report: PhaseReport) => void;
	/**
	 * Holds the run in `waiting_approval` until the decision; run the tool call only on an `allow_*` decision. Rejects when
	 * the approval policy fails: throw it on, so the run fails.
	 */
	approval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
};
/**
 * How the executor's work stopped, not what happens next:
 * - `end_turn`: the agent ended its turn on its own;
 * - `turn_limit`: the step limit stopped it with a tool call still open;
 * - `stalled`: the loop guard found it stuck and its hints are used up;
 * - `parked`: it stopped at the next tool call because `io.park` fired.
 */
export type RunEnding = 'end_turn' | 'turn_limit' | 'stalled' | 'parked';
/** What an executor reports when it stops; the domain decides from these facts how the run ends. */
export type ExecutorFacts = { lastMessage?: string; usage?: Usage } & (
	{ ending: Exclude<RunEnding, 'stalled'> } | { ending: 'stalled'; stall: Stall }
);
export type Executor = {
	/**
	 * Resolving reports the facts of a run that stopped; throwing fails the run, and a thrown DomainError supplies code and
	 * hint. Until the first event other than `log`, the first phase other than model loading or the first approval request
	 * the runner treats the model as loading and applies the cold start limits, so an executor's own inactivity timeout
	 * should only start after the model's first byte.
	 */
	execute(run: RunContext, io: ExecutorIo): Promise<ExecutorFacts>;
};
