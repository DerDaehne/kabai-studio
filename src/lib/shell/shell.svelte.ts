import { untrack } from 'svelte';
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
	tickets: [] as Suggestion[],
	/** Increments on every new signal; each increment sweeps one light wave through the head dock. */
	signals: 0
});

export function announceSignal() {
	shell.signals += 1;
}

let commandLayers = $state.raw<Suggestion[][]>([]);

/**
 * Binds a view's or the layout's own `:` commands until the returned function unbinds them; return it from an
 * `$effect`, same pattern as `bindKeys` in router.svelte.ts. A stack by object identity, not a flat reset, so one
 * binding unmounting never clobbers another that is still bound.
 */
export function bindCommands(suggestions: Suggestion[]): () => void {
	// untracked: an effect that binds must not depend on the layers it changes, or it reruns forever
	untrack(() => (commandLayers = [...commandLayers, suggestions]));
	return () =>
		untrack(() => (commandLayers = commandLayers.filter((layer) => layer !== suggestions)));
}

/** Every bound command once, most recently bound layer first; it wins over an older layer's suggestion of the same id. */
export function boundCommands(): Suggestion[] {
	const seen = new Set<string>();
	const result: Suggestion[] = [];
	for (let i = commandLayers.length - 1; i >= 0; i--) {
		for (const suggestion of commandLayers[i]) {
			if (seen.has(suggestion.id)) continue;
			seen.add(suggestion.id);
			result.push(suggestion);
		}
	}
	return result;
}
