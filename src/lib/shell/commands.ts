/** `:` runs a command, `/` searches the current view and all tickets. */
export type CommandMode = ':' | '/';

export type Suggestion = {
	id: string;
	label: string;
	detail?: string;
	href?: string;
	/** False for commands whose feature has not been built yet; they are listed but cannot be run. */
	available?: boolean;
};

export type SuggestionSources = {
	commands: Suggestion[];
	view: Suggestion[];
	tickets: Suggestion[];
};

export const commands: Suggestion[] = [
	{ id: 'run', label: ':run', detail: 'Ticket als Run starten', available: false },
	{ id: 'diff', label: ':diff', detail: 'Änderungen am Code ansehen', available: false },
	{ id: 'fokus', label: ':fokus', detail: 'Projekt-Fokus setzen', available: false },
	{ id: 'fokus-aus', label: ':fokus aus', detail: 'Projekt-Fokus aufheben' },
	{ id: 'theme-light', label: ':set farbschema hell', detail: 'Helles Farbschema' },
	{ id: 'theme-dark', label: ':set farbschema dunkel', detail: 'Dunkles Farbschema' },
	{ id: 'theme-system', label: ':set farbschema system', detail: 'Farbschema des Systems' },
	{ id: 'motion-reduced', label: ':set bewegung reduziert', detail: 'Bewegung reduzieren' },
	{ id: 'motion-system', label: ':set bewegung system', detail: 'Bewegung wie im System' },
	{ id: 'settings', label: ':einstellungen', detail: 'Einstellungen öffnen', href: '/settings' },
	{ id: 'q', label: ':q', detail: 'Befehlszeile schließen' }
];

export function parseInput(value: string): { mode: CommandMode | null; query: string } {
	const first = value.charAt(0);
	if (first === ':' || first === '/') return { mode: first, query: value.slice(1) };
	return { mode: null, query: value };
}

const wordsOf = (text: string) => text.toLocaleLowerCase('de').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export function matchesWordStart(text: string, query: string): boolean {
	const words = wordsOf(text);
	return wordsOf(query).every((needle) => words.some((word) => word.startsWith(needle)));
}

export function suggest(mode: CommandMode, query: string, sources: SuggestionSources): Suggestion[] {
	const candidates = mode === ':' ? sources.commands : [...sources.view, ...sources.tickets];
	return candidates.filter((candidate) => matchesWordStart(`${candidate.label} ${candidate.detail ?? ''}`, query));
}

/** An empty line lists every command, so they can be discovered without knowing `:` (mobile has no key bar). */
export function suggestionsFor(value: string, sources: SuggestionSources): Suggestion[] {
	if (value === '') return sources.commands;
	const { mode, query } = parseInput(value);
	return mode ? suggest(mode, query, sources) : [];
}
