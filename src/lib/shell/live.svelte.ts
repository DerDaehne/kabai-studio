import { afterNavigate, beforeNavigate, invalidate } from '$app/navigation';
import { navigating as currentNavigation } from '$app/state';
import {
	LIVE_DEPENDENCY,
	type HaltKind,
	type LiveEvent,
	type LiveRun,
	type LiveState
} from '$lib/live';
import { connectLiveUpdates, type LiveUpdatesHandle } from '$lib/live-updates';
import type { Tone } from '$lib/ui/Badge.svelte';
import type { Tone as RektaTone } from '$lib/ui/rekta/tone';
import { onMount } from 'svelte';
import { on } from 'svelte/events';
import { announceSignal, shell, type AgentChip } from './shell.svelte';

/** How a run's state reads wherever a list of runs names it: the badge tone and the German word, shared so the
 *  same run never reads differently in two places (the app bar, the board, the Stellwerk). */
export const RUN_STATE_LABELS: Record<LiveRun['state'], { tone: Tone; label: string }> = {
	queued: { tone: 'neutral', label: 'in der Queue' },
	running: { tone: 'running', label: 'arbeitet' },
	waiting: { tone: 'waiting', label: 'hält' },
	paused: { tone: 'paused', label: 'angehalten' }
};

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

/** The runner in the one word the app bar shows: a halt first, then an agent holding for the human, then one at work. */
export function runnerState(
	halt: HaltKind | null,
	agents: AgentChip[]
): { word: string; tone: RektaTone } {
	if (halt === 'stop') return { word: 'not-aus', tone: 'error' };
	if (halt === 'pause') return { word: 'angehalten', tone: 'warning' };
	if (agents.some((agent) => agent.state === 'waiting')) return { word: 'hält', tone: 'warning' };
	if (agents.length) return { word: 'arbeitet', tone: 'info' };
	return { word: 'frei', tone: 'neutral' };
}

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
