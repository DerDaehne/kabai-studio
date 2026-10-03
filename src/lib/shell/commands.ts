import type { ProjectRef } from './shell.svelte';

/** `:` runs a command, `/` searches the current view and all tickets. */
export type CommandMode = ':' | '/';

export type Suggestion = {
	id: string;
	label: string;
	detail?: string;
	href?: string;
	/** False for commands whose feature has not been built yet; they are listed but cannot be run. */
	available?: boolean;
	/** What a command of the current view does; see {@link withViewCommands}. */
	run?: () => void;
};

export type SuggestionSources = {
	commands: Suggestion[];
	view: Suggestion[];
	tickets: Suggestion[];
};

export const commands: Suggestion[] = [
	{ id: 'run', label: ':run', detail: 'Ticket als Run starten' },
	{ id: 'diff', label: ':diff', detail: 'Änderungen am Code ansehen', available: false },
	{ id: 'halt', label: ':anhalten', detail: 'Not-Aus: alle Agent-Runs sofort anhalten' },
	{ id: 'release', label: ':fortsetzen', detail: 'Nach dem Not-Aus: wartende Runs starten wieder' },
	{ id: 'fokus-aus', label: ':fokus aus', detail: 'Projekt-Fokus aufheben' },
	{ id: 'theme-light', label: ':set farbschema hell', detail: 'Helles Farbschema' },
	{ id: 'theme-dark', label: ':set farbschema dunkel', detail: 'Dunkles Farbschema' },
	{ id: 'theme-system', label: ':set farbschema system', detail: 'Farbschema des Systems' },
	{ id: 'motion-reduced', label: ':set bewegung reduziert', detail: 'Bewegung reduzieren' },
	{ id: 'motion-system', label: ':set bewegung system', detail: 'Bewegung wie im System' },
	{ id: 'single-keys-off', label: ':set einzeltasten aus', detail: 'Tasten nur mit Alt' },
	{ id: 'single-keys-on', label: ':set einzeltasten an', detail: 'Tasten ohne Alt' },
	{ id: 'settings', label: ':einstellungen', detail: 'Einstellungen öffnen', href: '/settings' },
	{ id: 'q', label: ':q', detail: 'Befehlszeile schließen' }
];

/**
 * The commands of the current view (such as `:run` in the Run-Akte) first; one with the id of a fixed command takes its
 * place, so the fixed one only answers where no view offers it.
 */
export const withViewCommands = (view: Suggestion[], fixed: Suggestion[]): Suggestion[] => [
	...view,
	...fixed.filter((command) => !view.some((own) => own.id === command.id))
];

const focusCommandId = (projectId: number) => `fokus-${projectId}`;

/** One `:fokus <code>` suggestion per project, for `sources.commands` alongside the fixed {@link commands}. */
export function focusCommands(projects: ProjectRef[]): Suggestion[] {
	return projects.map((project) => ({
		id: focusCommandId(project.id),
		label: `:fokus ${project.code.toLowerCase()}`,
		detail: `Fokus auf ${project.name}`
	}));
}

/**
 * What executing `suggestion` means for the focus: the project to focus, `null` to clear it (`:fokus aus`), or
 * `undefined` when it isn't a focus command at all — the single place that reads the id {@link focusCommands} writes.
 */
export function focusTarget(
	suggestion: Suggestion,
	projects: ProjectRef[]
): ProjectRef | null | undefined {
	if (suggestion.id === 'fokus-aus') return null;
	return projects.find((project) => focusCommandId(project.id) === suggestion.id);
}

export function parseInput(value: string): { mode: CommandMode | null; query: string } {
	const first = value.charAt(0);
	if (first === ':' || first === '/') return { mode: first, query: value.slice(1) };
	return { mode: null, query: value };
}

const wordsOf = (text: string) =>
	text
		.toLocaleLowerCase('de')
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);

export function matchesWordStart(text: string, query: string): boolean {
	const words = wordsOf(text);
	return wordsOf(query).every((needle) => words.some((word) => word.startsWith(needle)));
}

export function suggest(
	mode: CommandMode,
	query: string,
	sources: SuggestionSources
): Suggestion[] {
	const candidates = mode === ':' ? sources.commands : [...sources.view, ...sources.tickets];
	return candidates.filter((candidate) =>
		matchesWordStart(`${candidate.label} ${candidate.detail ?? ''}`, query)
	);
}

/** An empty line lists every command, so they can be discovered without knowing `:` (mobile has no key bar). */
export function suggestionsFor(value: string, sources: SuggestionSources): Suggestion[] {
	if (value === '') return sources.commands;
	const { mode, query } = parseInput(value);
	return mode ? suggest(mode, query, sources) : [];
}
