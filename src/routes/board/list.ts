import type { Lage, LageReason, Progress } from '$lib/lage';
import type { ProjectRef } from '$lib/shell/shell.svelte';
import type { RunTraceState } from '$lib/trace/trace';

export { BOARD_DEPENDENCY } from '$lib/live';

export type ColumnPhase = 'open' | 'work' | 'acceptance' | 'done';

/** A column of a project; only the expert view names one. */
export type BoardColumn = {
	id: number;
	projectId: number;
	step: string;
	name: string;
	phase: ColumnPhase;
	position: number;
};

export type BoardTicket = {
	id: number;
	/** e.g. `STU-12` */
	ref: string;
	number: number;
	title: string;
	project: ProjectRef;
	column: { id: number; name: string; phase: ColumnPhase; position: number };
	tasks: { done: number; total: number };
	/** The ref of the epic the ticket belongs to. */
	epic: string | null;
	lage: Lage;
	reason: LageReason;
	/** The step of the column, e.g. `implement`. */
	step: string;
	progress: Progress;
	/** The ticket's newest run. */
	run: { state: RunTraceState; profile: string | null } | null;
	updatedAt: string;
};

export type BoardGroup = { id: string; title: string; rows: BoardTicket[]; total: number };

/** The Lagen in the order the board shows them; what waits for the human comes first. */
export const LAGEN: Lage[] = ['waiting', 'working', 'open', 'acceptance', 'done'];

/** Older finished tickets are left to the search. */
export const DONE_SHOWN = 20;

/** The cookie that remembers the expert view, so the server renders the chosen view right away. */
export const FLOW_COOKIE = 'studio-board-view';

// Tickets have no position the human could set, so a group lists them in the order they were created.
const byNumber = (a: BoardTicket, b: BoardTicket) =>
	a.number - b.number || a.project.code.localeCompare(b.project.code);

const newestFirst = (a: BoardTicket, b: BoardTicket) =>
	b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id;

/**
 * One group per Lage, always all five in board order; finished tickets newest first and only the last few.
 * ponytail: "finished last" is the ticket's newest change, so a rename after done counts too; a done timestamp would be
 * exact once the review of finished tickets needs it.
 */
export function groupByLage(tickets: BoardTicket[], title: (lage: Lage) => string): BoardGroup[] {
	return LAGEN.map((lage) => {
		const rows = tickets.filter((ticket) => ticket.lage === lage);
		const shown =
			lage === 'done' ? rows.sort(newestFirst).slice(0, DONE_SHOWN) : rows.sort(byNumber);
		return { id: lage, title: title(lage), rows: shown, total: rows.length };
	});
}

/** The expert view: one group per step across all projects, in the order of `columns`, empty steps included. */
export function groupByColumn(tickets: BoardTicket[], columns: BoardColumn[]): BoardGroup[] {
	const groups = new Map<string, BoardGroup>();
	for (const column of columns)
		if (!groups.has(column.step))
			groups.set(column.step, { id: column.step, title: column.name, rows: [], total: 0 });
	for (const ticket of tickets) groups.get(ticket.step)?.rows.push(ticket);
	return [...groups.values()].map((group) => ({
		...group,
		rows: group.rows.sort(byNumber),
		total: group.rows.length
	}));
}

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

/** h/l: the start of the group `count` groups on or back from the group `index` is in; at either end it stays. */
export function sideJump(starts: number[], index: number, forward: boolean, count: number) {
	const groupStart = starts.findLast((start) => start <= index) ?? index;
	const target = groupJump(starts, groupStart, forward, count);
	return target === groupStart ? index : target;
}
