import { afterNavigate, beforeNavigate, invalidate } from '$app/navigation';
import { connectLiveUpdates, type LiveUpdatesHandle } from '$lib/live-updates';
import { announceSignal, shell, type AgentChip, type ProjectRef } from './shell.svelte';

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

let navigating = false;
const pendingInvalidations = new Set<string>();

/**
 * Call once, during the root layout's initialization (`beforeNavigate`/`afterNavigate` require that, like `onMount`).
 * Gates every `invalidateLive()` call against the current client navigation: SvelteKit's own `invalidate()` would
 * otherwise win the navigation-token race against a `goto()` in flight and silently cancel it. A reload that arrives
 * mid-navigation is deferred and replayed exactly once, right after the navigation lands. A navigation that unloads
 * the page (a full page load, an external link, the back/forward cache) never reaches `afterNavigate` in this page
 * instance, so it never starts the gate in the first place.
 */
export function gateLiveInvalidation() {
	beforeNavigate(({ willUnload }) => {
		if (!willUnload) navigating = true;
	});
	afterNavigate(() => {
		navigating = false;
		for (const dependency of pendingInvalidations) void invalidate(dependency);
		pendingInvalidations.clear();
	});
}

/** The one place that reloads a dependency fed by live events; see `gateLiveInvalidation` for why it is gated. */
export function invalidateLive(dependency: string = LIVE_DEPENDENCY): Promise<void> {
	if (navigating) {
		pendingInvalidations.add(dependency);
		return Promise.resolve();
	}
	return invalidate(dependency);
}

const STATE_CHANGES = new Set([
	'run.created',
	'run.state_changed',
	'question.asked',
	'question.answered',
	'question.retracted',
	'question.collected',
	'ticket.moved',
	'ticket.deleted',
	'project.created',
	'project.updated',
	'runner.halted',
	'runner.released'
]);

/** Live state of all projects in this tab; `showLive` replaces it. */
export const live: LiveState = $state({
	projects: [],
	runs: [],
	openQuestions: 0,
	halt: null,
	activeRuns: 0
});

const listeners = new Set<(event: LiveEvent) => void>();

export function showLive(state: LiveState) {
	Object.assign(live, state);
	shell.agents = agentChips(state.runs);
}

/** One chip per run an agent works on or holds in; a queued or halted run has no agent at work. */
export const agentChips = (runs: LiveRun[]): AgentChip[] =>
	runs.flatMap(({ id, profile, location, project, state }) =>
		state === 'running' || state === 'waiting'
			? [{ id, name: profile, location, project, state }]
			: []
	);

export const openQuestionsLabel = (count: number) =>
	`${count} offene ${count === 1 ? 'Frage' : 'Fragen'}`;

const countOf = (runs: LiveRun[], state: LiveRun['state']) =>
	runs.filter((run) => run.state === state).length;

/** The head dock's signal while a halt is set: a stop counts the waiting runs, a pause the runs it paused. */
export const haltLabel = (halt: HaltKind, runs: LiveRun[]) =>
	halt === 'stop'
		? `Gestoppt · ${countOf(runs, 'queued')} wartend`
		: `Angehalten · ${countOf(runs, 'paused')} pausiert`;

const QUEUE_WAITS = 'Wartende Runs bleiben in der Queue, bis du fortsetzt (:fortsetzen all).';

function activeRunsText(count: number, what: string) {
	if (count === 0) return 'Gerade läuft kein Run.';
	if (count === 1) return `1 Run läuft und wird sofort ${what}.`;
	return `${count} Runs laufen und werden sofort ${what}.`;
}

/** The confirmation before `:stop`: what gets cancelled and how the queue goes on. */
export const stopQuestion = (activeRuns: number) =>
	`${activeRunsText(activeRuns, 'abgebrochen')} ${QUEUE_WAITS}`;

/** The confirmation before a global `:anhalten`: what gets paused, what is lost and how everything goes on. */
export const pauseQuestion = (activeRuns: number) =>
	`${activeRunsText(activeRuns, 'angehalten')}${activeRuns ? ' Der angefangene Schritt wird verworfen, :fortsetzen all setzt die Arbeit fort.' : ''} ${QUEUE_WAITS}`;

/** Lets a view follow the events of all projects over the tab's one connection; returns the unsubscribe function. */
export function onLiveEvent(listener: (event: LiveEvent) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Opens the tab's one connection to the events of all projects. `reload` loads the live state again and hands it to
 * `showLive`: on every event that changes it and after every reconnect, because the bus replays nothing.
 */
export function connectLive(reload: () => void): LiveUpdatesHandle {
	return connectLiveUpdates(null, {
		onReload: reload,
		onEvent: (event) => dispatch(event as LiveEvent, reload)
	});
}

function dispatch(event: LiveEvent, reload: () => void) {
	if (event.type === 'question.asked') announceSignal();
	if (STATE_CHANGES.has(event.type)) reload();
	for (const listener of listeners) listener(event);
}
