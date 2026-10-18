import { ticketHref } from '$lib/links';
import type { LiveRun, ProjectRef, QueuedQuestion } from '$lib/live';
import type { FinishedRunWithWayOut } from '$lib/server/start-view';
import type { Tone } from '$lib/ui/rekta/tone';

export type TileState = LiveRun['state'] | 'question' | 'failed';

/** A live tile of the "now" section; its size follows its importance, its tone its state. */
export type NowTile = {
	key: string;
	state: TileState;
	size: '1x1' | '2x1' | '2x2';
	tone: Tone;
	project: ProjectRef;
	ticket: string;
	/** The Run-Akte of exactly this run. */
	href: string;
	/** The run `x` would cancel; unset for a question without a run and a failed run. */
	runId?: number;
	question?: QueuedQuestion;
	run?: LiveRun;
	failed?: FinishedRunWithWayOut;
};

// ponytail: the tile states stand in for the derived states (waits for you, at work, open) of the coming per-ticket
// read model; derive tone and size from it once it exists.
const RUN_TONE: Record<LiveRun['state'], Tone> = {
	queued: 'neutral',
	running: 'info',
	waiting: 'warning',
	paused: 'warning'
};

// LiveRun.ticket is "KEY-N"; a project key never contains a hyphen, so the part after the last one is the number.
const ticketNumber = (ref: string) => ref.split('-').at(-1) ?? '';

function questionTile(question: QueuedQuestion): NowTile {
	return {
		key: `question-${question.id}`,
		state: 'question',
		size: '2x2',
		tone: 'warning',
		project: question.project,
		ticket: question.ticket.ref,
		href: ticketHref(question.project.code, question.ticket.number, { run: question.runId }),
		runId: question.runId ?? undefined,
		question
	};
}

function runTile(run: LiveRun): NowTile {
	const busy = run.state === 'running' || run.state === 'waiting';
	return {
		key: `run-${run.id}`,
		state: run.state,
		size: busy ? '2x1' : '1x1',
		tone: RUN_TONE[run.state],
		project: run.project,
		ticket: run.ticket,
		href: ticketHref(run.project.code, ticketNumber(run.ticket), { run: run.id }),
		runId: run.id,
		run
	};
}

function failedTile(run: FinishedRunWithWayOut): NowTile {
	return {
		key: `failed-${run.id}`,
		state: 'failed',
		size: '2x1',
		tone: 'error',
		project: run.project,
		ticket: run.ticket,
		href: ticketHref(run.project.code, run.number, { run: run.id }),
		failed: run
	};
}

/** Questions first, then the runs at work or waiting, then recent failures; a run that asks shows as its question. */
export function nowTiles(
	questions: QueuedQuestion[],
	runs: LiveRun[],
	finished: FinishedRunWithWayOut[]
): NowTile[] {
	const asking = new Set(questions.map((question) => question.runId));
	return [
		...questions.map(questionTile),
		...runs.filter((run) => !asking.has(run.id)).map(runTile),
		...finished.filter((run) => run.state === 'failed').map(failedTile)
	];
}
