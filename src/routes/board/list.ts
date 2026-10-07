import { RUN_STATE_LABELS, type LiveRun } from '$lib/shell/live.svelte';
import type { ProjectRef } from '$lib/shell/shell.svelte';
import type { Tone } from '$lib/ui/Badge.svelte';

/** The board load depends on this; the view invalidates it on every live event that changes what the board shows. */
export const BOARD_DEPENDENCY = 'studio:board';

export type ColumnKind = 'normal' | 'done' | 'human_intervention' | 'human_answered';
export type BoardColumn = { id: number; name: string; kind: ColumnKind; position: number };

/** Where `>` or `<` leads; a move with blockers stays closed and says why. */
export type StepTarget = {
	columnId: number;
	name: string;
	blockers: { code: string; message: string; hint: string }[];
};

export type BoardTicket = {
	id: number;
	/** e.g. `STU-12` */
	ref: string;
	number: number;
	title: string;
	project: ProjectRef;
	column: BoardColumn;
	tasks: { done: number; total: number };
	/** The ref of the epic the ticket belongs to. */
	epic: string | null;
	next: { forward?: StepTarget; back?: StepTarget };
};

export type BoardGroup = { column: BoardColumn; rows: BoardTicket[] };

// Tickets have no position the human could set, so a column lists them in the order they were created.
const byNumber = (a: BoardTicket, b: BoardTicket) =>
	a.number - b.number || a.project.code.localeCompare(b.project.code);

const inBoardOrder = (a: BoardTicket, b: BoardTicket) =>
	a.column.position - b.column.position || a.column.name.localeCompare(b.column.name);

/** One group per column name across all projects, in board order; each sorted by ticket number ascending. */
export function groupByColumn(tickets: BoardTicket[]): BoardGroup[] {
	const groups = new Map<string, BoardGroup>();
	for (const ticket of [...tickets].sort(inBoardOrder)) {
		const group = groups.get(ticket.column.name);
		if (group) group.rows.push(ticket);
		else groups.set(ticket.column.name, { column: ticket.column, rows: [ticket] });
	}
	return [...groups.values()].map((group) => ({ ...group, rows: group.rows.sort(byNumber) }));
}

const START_RULES: Record<ColumnKind, string> = {
	normal: 'Start per :run',
	done: 'fertig, kein Run',
	human_intervention: 'wartet auf dich',
	human_answered: 'beantwortet, weiter per Spaltenwechsel'
};

/** How a run starts in a column of this kind; agents start only when the human starts them. */
export const startRule = (kind: ColumnKind) => START_RULES[kind];

const clamp = (index: number, length: number) => Math.min(Math.max(index, 0), length - 1);

/** j/k: `delta` rows on, stopping at either end. */
export const stepped = (index: number, delta: number, length: number) =>
	clamp(index + delta, length);

/** G: the last row; gg: the row the count names, the first without one. */
export const edgeIndex = (key: string, count: number, length: number) =>
	key === 'G' ? length - 1 : clamp(count - 1, length);

/** }: the start of the next group; {: the start of the current group, or of the previous one from its start. */
export function groupJump(
	starts: number[],
	index: number,
	forward: boolean,
	count: number
): number {
	let target = index;
	for (let step = 0; step < count; step++) {
		const next = forward
			? starts.find((start) => start > target)
			: starts.findLast((start) => start < target);
		target = next ?? target;
	}
	return target;
}

// Most urgent to least: one holding for the human, then one the human halted, then one at work, then one in the queue.
const RANK: Record<LiveRun['state'], number> = { waiting: 0, paused: 1, running: 2, queued: 3 };

/** The run that matters most for a row, picked by {@link RANK}; its label comes from the shared RUN_STATE_LABELS. */
export function runStatus(ref: string, runs: LiveRun[]): { tone: Tone; text: string } | undefined {
	const [run] = runs
		.filter((candidate) => candidate.ticket === ref)
		.sort((a, b) => RANK[a.state] - RANK[b.state]);
	if (!run) return undefined;
	const { tone, label } = RUN_STATE_LABELS[run.state];
	return { tone, text: `${label} · ${run.profile} (${run.location})` };
}
