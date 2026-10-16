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
/** Live progress of a run, published on the bus as `run.phase` and never stored. */
export type Phase = {
	name: 'thinking' | 'writing' | 'tool' | 'compacting' | 'model_loading' | 'model_downloading';
	elapsedMs: number;
	tokens?: number;
	tokensPerSecond?: number;
	/** The last complete line of output; the runner masks it and cuts it to 120 characters. */
	lastLine?: string;
};
export type ExecutorIo = {
	/** Fires when the run is cancelled or paused by the human: it has already ended by then and `emit` throws `run_not_active`. */
	signal: AbortSignal;
	/** Fires when the run should end after its current step: stop at the next tool call and resolve `parked`. */
	park: AbortSignal;
	emit: EmitRunEvent;
	phase: (phase: Phase) => void;
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
	 * hint. Until the first event other than `log` or the first phase other than model loading the runner treats the model
	 * as loading and applies the cold start limits, so an executor's own inactivity timeout should only start after the
	 * model's first byte.
	 */
	execute(run: RunContext, io: ExecutorIo): Promise<ExecutorFacts>;
};
