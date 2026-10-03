import type { ProjectPalette } from '$lib/ui/ProjectTag.svelte';
import type { Suggestion } from './commands';

export type ProjectRef = { id: number; code: string; palette: ProjectPalette; name: string };

export type AgentChip = {
	/** The run the agent works in. */
	id: number;
	name: string;
	location: 'lokal' | 'online';
	project: ProjectRef;
	state: 'running' | 'waiting';
};

/** What views feed into the shell; the docks only render it. */
export const shell = $state({
	agents: [] as AgentChip[],
	focus: null as ProjectRef | null,
	/** Count or prefix the key router has buffered so far, e.g. `3` or `g`. */
	pendingKeys: '',
	viewItems: [] as Suggestion[],
	/** The current view's own `:` commands, such as `:run` in the Run-Akte. */
	viewCommands: [] as Suggestion[],
	tickets: [] as Suggestion[],
	/** Increments on every new signal; each increment sweeps one light wave through the head dock. */
	signals: 0
});

export function announceSignal() {
	shell.signals += 1;
}
