import { afterNavigate, beforeNavigate, invalidate } from '$app/navigation';
import { navigating as currentNavigation } from '$app/state';
import { connectLiveUpdates, type LiveUpdatesHandle } from '$lib/live-updates';
import type { Tone } from '$lib/ui/Badge.svelte';
import { onMount } from 'svelte';
import { on } from 'svelte/events';
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

/** How a run's state reads wherever a list of runs names it: the badge tone and the German word, shared so the
 *  same run never reads differently in two places (the head dock, the board, the Stellwerk). */
export const RUN_STATE_LABELS: Record<LiveRun['state'], { tone: Tone; label: string }> = {
	queued: { tone: 'neutral', label: 'in der Queue' },
	running: { tone: 'running', label: 'arbeitet' },
	waiting: { tone: 'waiting', label: 'hält' },
	paused: { tone: 'paused', label: 'angehalten' }
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

function replayPending() {
	navigating = false;
	for (const dependency of pendingInvalidations) void invalidate(dependency);
	pendingInvalidations.clear();
}

/**
 * Call once, during the root layout's initialization. Gates `invalidateLive()` against the current client
 * navigation, deferring a reload and replaying it exactly once the navigation settles. SvelteKit's own
 * `invalidate()` swaps the navigation token and would otherwise win the race against a `goto()` in flight,
 * silently cancelling it.
 */
export function gateLiveInvalidation() {
	beforeNavigate(({ willUnload, complete }) => {
		if (willUnload) return;
		navigating = true;
		// An unrelated invalidation (e.g. a use:enhance action's invalidateAll()) can also win that race and abort
		// this navigation without ever reaching afterNavigate; release once nothing newer has taken its place.
		complete.catch(() => {
			if (!currentNavigation.complete || currentNavigation.complete === complete) replayPending();
		});
	});
	afterNavigate(replayPending);
	// A navigation that falls back to a full page load (a failed data request, a new deploy) never reaches
	// afterNavigate either; pageshow with persisted fires once the frozen page returns from the bfcache.
	onMount(() => on(window, 'pageshow', (event) => event.persisted && replayPending()));
}

type Batch = { dependencies: Set<string>; reloaded: Promise<void> };
let batch: Batch | undefined;

/**
 * The one place that reloads a dependency fed by live events; see `gateLiveInvalidation` for why it is gated. Calls
 * within one task share one invalidation and its promise: SvelteKit would merge them too, but resolve all but the first
 * before the reload has landed.
 */
export function invalidateLive(dependency: string = LIVE_DEPENDENCY): Promise<void> {
	batch ??= startBatch();
	batch.dependencies.add(dependency);
	return batch.reloaded;
}

function startBatch(): Batch {
	const dependencies = new Set<string>();
	const reloaded = Promise.resolve().then(() => {
		batch = undefined;
		if (!navigating) return invalidate((url) => dependencies.has(url.href));
		for (const dependency of dependencies) pendingInvalidations.add(dependency);
	});
	return { dependencies, reloaded };
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
