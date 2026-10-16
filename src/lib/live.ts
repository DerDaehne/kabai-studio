import type { ProjectPalette } from '$lib/ui/ProjectTag.svelte';

/**
 * How often the event stream sends a heartbeat. The client takes a stream as lost when nothing, not even a
 * heartbeat, arrives for longer than this plus `HEARTBEAT_GRACE_MS`.
 */
export const HEARTBEAT_MS = 25_000;
export const HEARTBEAT_GRACE_MS = 10_000;

/** A project as every live view names it: code for compact display, palette for its colour slot. */
export type ProjectRef = { id: number; code: string; palette: ProjectPalette; name: string };

/** An open question as the Takt queue and the start view's question tiles show it. */
export type QueuedQuestion = {
	id: number;
	/** `ref` such as `STU-12`; `number` addresses the ticket within its project. */
	ticket: { ref: string; number: number; title: string };
	project: ProjectRef;
	/** The profile of the asking run; null for a question without a run or with a deleted profile. */
	profile: string | null;
	/** The asking run, so its Run-Akte link opens that run's trace instead of the ticket's newest. */
	runId: number | null;
	/** ISO timestamp. */
	askedAt: string;
	question: string;
	options: { label: string; effect?: string }[];
};

export type LiveRun = {
	id: number;
	profile: string;
	location: 'lokal' | 'online';
	project: ProjectRef;
	/** e.g. `STU-12` */
	ticket: string;
	/** `waiting`: holds for the human, on an approval or an open question; `paused`: the human halted it, `:fortsetzen` resumes it. */
	state: 'queued' | 'running' | 'waiting' | 'paused';
};

/** `stop` cancelled the active runs, `pause` paused them; either holds the queue until `:fortsetzen all`. */
export type HaltKind = 'stop' | 'pause';

export type LiveState = {
	projects: ProjectRef[];
	runs: LiveRun[];
	openQuestions: number;
	/** While set, no run starts until the human resumes all (`:fortsetzen all`). */
	halt: HaltKind | null;
	/** Running or waiting for an approval, in every project: what the kill switch would cancel. */
	activeRuns: number;
};

/** An event as the event route sends it; one that concerns every project, such as the kill switch, has no projectId. */
export type LiveEvent = { type: string; projectId?: number; [key: string]: unknown };

/** The root layout load depends on this; invalidating it loads the live state again. */
export const LIVE_DEPENDENCY = 'studio:live';

/** The board load depends on this; the view invalidates it on every live event that changes what the board shows. */
export const BOARD_DEPENDENCY = 'studio:board';

/** The ticket page's load depends on this; invalidating it reloads just that one ticket. */
export const ticketDependency = (id: number) => `studio:ticket:${id}`;

/** The machines page's load depends on this; it reloads when a runner connects or drops. */
export const RUNNERS_DEPENDENCY = 'studio:runners';
