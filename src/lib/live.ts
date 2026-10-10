import type { ProjectPalette } from '$lib/ui/ProjectTag.svelte';

/** A project as every live view names it: code for compact display, palette for its colour slot. */
export type ProjectRef = { id: number; code: string; palette: ProjectPalette; name: string };

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
