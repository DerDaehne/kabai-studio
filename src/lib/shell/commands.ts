import { shell, type ProjectRef } from './shell.svelte';
import { toast } from '$lib/ui/toast.svelte';

/** `:` runs a command, `/` searches the current view and all tickets. */
export type CommandMode = ':' | '/';

export type Suggestion = {
	id: string;
	label: string;
	detail?: string;
	href?: string;
	/** What executing this suggestion does; see `bindCommands` in shell.svelte.ts. */
	run?: () => void;
};

export type SuggestionSources = {
	commands: Suggestion[];
	view: Suggestion[];
	tickets: Suggestion[];
};

export type GlobalCommandHandlers = {
	/** Writes a `:set …` choice (theme or motion), by the id of the suggestion that chose it. */
	setPreference: (id: string) => void;
	setSingleKeys: (on: boolean) => void;
};

/** The `:set farbschema …`/`:set bewegung …` commands, replacing the old sidebar's selects. */
function preferenceCommands(setPreference: (id: string) => void): Suggestion[] {
	const preference = (id: string) => () => setPreference(id);
	return [
		{
			id: 'theme-light',
			label: ':set farbschema hell',
			detail: 'Helles Farbschema',
			run: preference('theme-light')
		},
		{
			id: 'theme-dark',
			label: ':set farbschema dunkel',
			detail: 'Dunkles Farbschema',
			run: preference('theme-dark')
		},
		{
			id: 'theme-system',
			label: ':set farbschema system',
			detail: 'Farbschema des Systems',
			run: preference('theme-system')
		},
		{
			id: 'motion-reduced',
			label: ':set bewegung reduziert',
			detail: 'Bewegung reduzieren',
			run: preference('motion-reduced')
		},
		{
			id: 'motion-system',
			label: ':set bewegung system',
			detail: 'Bewegung wie im System',
			run: preference('motion-system')
		}
	];
}

/** The `:set einzeltasten …` commands (WCAG 2.1.4 single-key toggle). */
function singleKeysCommands(setSingleKeys: (on: boolean) => void): Suggestion[] {
	return [
		{
			id: 'single-keys-off',
			label: ':set einzeltasten aus',
			detail: 'Tasten nur mit Alt',
			run: () => setSingleKeys(false)
		},
		{
			id: 'single-keys-on',
			label: ':set einzeltasten an',
			detail: 'Tasten ohne Alt',
			run: () => setSingleKeys(true)
		}
	];
}

/** The commands that work everywhere, not just in one view; `+layout.svelte` binds the result via `bindCommands`. */
export function globalCommands(handlers: GlobalCommandHandlers): Suggestion[] {
	return [
		{
			id: 'run',
			label: ':run',
			detail: 'Ticket als Run starten',
			run: () =>
				toast(':run startet einen Run in der Run-Akte eines Tickets — öffne zuerst das Ticket.')
		},
		{
			id: 'projects',
			label: ':projekte',
			detail: 'Alle Projekte, Projekt anlegen',
			href: '/projects'
		},
		{
			id: 'fokus-aus',
			label: ':fokus aus',
			detail: 'Projekt-Fokus aufheben',
			run: () => (shell.focus = null)
		},
		...preferenceCommands(handlers.setPreference),
		...singleKeysCommands(handlers.setSingleKeys),
		{ id: 'settings', label: ':einstellungen', detail: 'Einstellungen öffnen', href: '/settings' },
		{ id: 'q', label: ':q', detail: 'Befehlszeile schließen' }
	];
}

export type GlobalHaltHandlers = {
	confirmStop: () => void;
	confirmPause: () => void;
	/** Outside the Run-Akte, `:fortsetzen` alone does not say which run. */
	askWhichRun: () => void;
	resumeAll: () => void;
};

/**
 * The global stop/pause/resume commands; `HaltControl.svelte` binds the result via `bindCommands` and owns the
 * confirmation that `confirmStop`/`confirmPause` open.
 */
export function globalHaltCommands(handlers: GlobalHaltHandlers): Suggestion[] {
	return [
		{
			id: 'stop',
			label: ':stop',
			detail: 'Not-Aus: alle Agent-Runs sofort abbrechen',
			run: handlers.confirmStop
		},
		{
			id: 'pause',
			label: ':anhalten',
			detail: 'Alle Agent-Runs pausieren',
			run: handlers.confirmPause
		},
		// only `:fortsetzen all` may match the query "fortsetzen all", or ↵ on it would run another command first
		{
			id: 'resume',
			label: ':fortsetzen',
			detail: 'Einen angehaltenen Run weiterlaufen lassen',
			run: handlers.askWhichRun
		},
		{
			id: 'resume-all',
			label: ':fortsetzen all',
			detail: 'Alle angehaltenen Runs fortsetzen, Not-Aus lösen',
			run: handlers.resumeAll
		}
	];
}

const focusCommandId = (projectId: number) => `fokus-${projectId}`;

/** One `:fokus <code>` suggestion per project, for `sources.commands` alongside the global {@link globalCommands}. */
export function focusCommands(projects: ProjectRef[]): Suggestion[] {
	return projects.map((project) => ({
		id: focusCommandId(project.id),
		label: `:fokus ${project.code.toLowerCase()}`,
		detail: `Fokus auf ${project.name}`,
		run: () => (shell.focus = project)
	}));
}

const resumeCommandId = (runId: number) => `resume-${runId}`;
const TYPED_RESUME = /^:\s*fortsetzen\s+(\d+)$/;

/**
 * One `:fortsetzen N` per halted run, and one for a number typed in `value` that is none of them, so the server can say why
 * it cannot resume that run; `resume` is the Run's resolution (`resumeRun` from halt.ts in production).
 */
export function resumeCommands(
	halted: { id: number; ticket: string }[],
	value: string,
	resume: (runId: number) => void
): Suggestion[] {
	const listed = halted.map((run) => ({
		id: resumeCommandId(run.id),
		label: `:fortsetzen ${run.id}`,
		detail: `Run ${run.id} · ${run.ticket} fortsetzen`,
		run: () => resume(run.id)
	}));
	const typed = TYPED_RESUME.exec(value.trim())?.[1];
	if (typed === undefined || halted.some((run) => String(run.id) === typed)) return listed;
	return [
		...listed,
		{
			id: resumeCommandId(Number(typed)),
			label: `:fortsetzen ${typed}`,
			detail: `Run ${typed} fortsetzen`,
			run: () => resume(Number(typed))
		}
	];
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
