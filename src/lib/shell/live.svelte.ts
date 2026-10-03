import { connectLiveUpdates, type LiveUpdatesHandle } from '$lib/live-updates';
import { announceSignal, shell, type AgentChip, type ProjectRef } from './shell.svelte';

export type LiveRun = {
	id: number;
	profile: string;
	location: 'lokal' | 'online';
	project: ProjectRef;
	/** e.g. `STU-12` */
	ticket: string;
	/** `waiting`: holds for the human, on an approval or an open question. */
	state: 'queued' | 'running' | 'waiting';
};

export type LiveState = {
	projects: ProjectRef[];
	runs: LiveRun[];
	openQuestions: number;
	/** The kill switch is set: no run starts until the human releases it. */
	halted: boolean;
	/** Running or waiting for an approval, in every project: what the kill switch would cancel. */
	activeRuns: number;
};

/** An event as the event route sends it; one that concerns every project, such as the kill switch, has no projectId. */
export type LiveEvent = { type: string; projectId?: number; [key: string]: unknown };

/** The root layout load depends on this; invalidating it loads the live state again. */
export const LIVE_DEPENDENCY = 'studio:live';

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
	halted: false,
	activeRuns: 0
});

const listeners = new Set<(event: LiveEvent) => void>();

export function showLive(state: LiveState) {
	Object.assign(live, state);
	shell.agents = agentChips(state.runs);
}

/** One chip per run an agent works on or holds in; a queued run has no agent at work yet. */
export const agentChips = (runs: LiveRun[]): AgentChip[] =>
	runs.flatMap((run) =>
		run.state === 'queued'
			? []
			: [
					{
						id: run.id,
						name: run.profile,
						location: run.location,
						project: run.project,
						state: run.state
					}
				]
	);

export const openQuestionsLabel = (count: number) =>
	`${count} offene ${count === 1 ? 'Frage' : 'Fragen'}`;

/** The head dock's signal while the kill switch is set. */
export const haltLabel = (runs: LiveRun[]) =>
	`Angehalten · ${runs.filter((run) => run.state === 'queued').length} wartend`;

function activeRunsText(count: number) {
	if (count === 0) return 'Gerade läuft kein Run.';
	if (count === 1) return '1 Run läuft und wird sofort abgebrochen.';
	return `${count} Runs laufen und werden sofort abgebrochen.`;
}

/** The confirmation before halting: what gets cancelled and how the queue goes on. */
export const haltQuestion = (activeRuns: number) =>
	`${activeRunsText(activeRuns)} Wartende Runs bleiben in der Queue, bis du fortsetzt (:fortsetzen).`;

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
