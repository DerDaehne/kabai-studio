import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	focusCommands,
	globalCommands,
	globalHaltCommands,
	matchesWordStart,
	parseInput,
	resumeCommands,
	suggest,
	suggestionsFor,
	type Suggestion
} from './commands';
import { shell, type ProjectRef } from './shell.svelte';

const view: Suggestion[] = [{ id: 'view-1', label: 'Spur von qwen3-coder', href: '/#spur' }];
const tickets: Suggestion[] = [
	{ id: 'ticket-45', label: 'Anhänge: Bild-Upload mit Vorschau', href: '/tickets/45' },
	{ id: 'ticket-49', label: 'Push bei neuer Freigabe', href: '/tickets/49' }
];

const commandHandlers = () => ({ setPreference: vi.fn(), setSingleKeys: vi.fn() });
const haltHandlers = () => ({
	confirmStop: vi.fn(),
	confirmPause: vi.fn(),
	askWhichRun: vi.fn(),
	resumeAll: vi.fn()
});
const commands = globalCommands(commandHandlers());
const sources = { commands, view, tickets };
const labels = (found: Suggestion[]) => found.map((suggestion) => suggestion.label);

afterEach(() => {
	shell.focus = null;
});

describe('parseInput', () => {
	it('reads the mode from the first character', () => {
		expect(parseInput(':run')).toEqual({ mode: ':', query: 'run' });
		expect(parseInput('/bild')).toEqual({ mode: '/', query: 'bild' });
		expect(parseInput('run')).toEqual({ mode: null, query: 'run' });
	});
});

describe('matchesWordStart', () => {
	it('matches only at the start of a word, never inside one', () => {
		expect(matchesWordStart(':diff Änderungen ansehen', 'run')).toBe(false);
		expect(matchesWordStart(':diff Änderungen ansehen', 'änd')).toBe(true);
		expect(matchesWordStart('Anhänge: Bild-Upload', 'upl')).toBe(true);
	});

	it('requires every query word to start some word', () => {
		expect(matchesWordStart(':set bewegung reduziert', 'set red')).toBe(true);
		expect(matchesWordStart(':set bewegung reduziert', 'set hell')).toBe(false);
	});
});

describe('suggest', () => {
	it('finds :run for "run" in command mode', () => {
		expect(labels(suggest(':', 'run', sources))).toEqual([':run']);
	});

	it('matches the description of a command, not only its name', () => {
		expect(labels(suggest(':', 'aufheben', sources))).toEqual([':fokus aus']);
	});

	it('offers every command for an empty command query', () => {
		expect(suggest(':', '', sources)).toHaveLength(commands.length);
	});

	it('searches the current view and all tickets in search mode', () => {
		expect(labels(suggest('/', 'spur', sources))).toEqual(['Spur von qwen3-coder']);
		expect(labels(suggest('/', 'push', sources))).toEqual(['Push bei neuer Freigabe']);
	});

	it('keeps the modes apart', () => {
		expect(labels(suggest('/', 'run', sources))).toEqual([]);
		expect(labels(suggest(':', 'push', sources))).toEqual([]);
	});
});

describe('focusCommands', () => {
	const projects: ProjectRef[] = [
		{ id: 1, code: 'STU', name: 'kabai studio', palette: 1 },
		{ id: 2, code: 'WEB', name: 'Website', palette: 2 }
	];

	it('offers one :fokus <code> suggestion per project', () => {
		expect(labels(focusCommands(projects))).toEqual([':fokus stu', ':fokus web']);
	});

	it('its run sets the shell focus to that project', () => {
		focusCommands(projects)[1].run?.();
		expect(shell.focus).toEqual(projects[1]);
	});

	it('is findable alongside :fokus aus for the "fokus" query', () => {
		const found = labels(suggest(':', 'fokus', { ...sources, commands: focusCommands(projects) }));
		expect(found).toEqual([':fokus stu', ':fokus web']);
		expect(labels(suggest(':', 'fokus', sources))).toContain(':fokus aus');
	});
});

describe('suggestionsFor', () => {
	it('lists every command while the line is empty', () => {
		expect(suggestionsFor('', sources)).toEqual(commands);
	});

	it('suggests nothing for text without a mode', () => {
		expect(suggestionsFor('run', sources)).toEqual([]);
	});

	it('follows the mode once one is typed', () => {
		expect(labels(suggestionsFor('/push', sources))).toEqual(['Push bei neuer Freigabe']);
	});
});

describe('globalCommands', () => {
	it('forwards a :set or :einzeltasten choice to its handler, by the id of the chosen suggestion', () => {
		const handlers = commandHandlers();
		const found = globalCommands(handlers);
		found.find((c) => c.id === 'theme-dark')!.run?.();
		found.find((c) => c.id === 'single-keys-off')!.run?.();
		expect(handlers.setPreference).toHaveBeenCalledWith('theme-dark');
		expect(handlers.setSingleKeys).toHaveBeenCalledWith(false);
	});

	it(':fokus aus clears the shell focus', () => {
		shell.focus = { id: 1, code: 'STU', name: 'kabai studio', palette: 1 };
		commands.find((c) => c.id === 'fokus-aus')!.run?.();
		expect(shell.focus).toBeNull();
	});

	it(':run points into the Run-Akte instead of running anything itself', () => {
		const run = commands.find((c) => c.id === 'run')!;
		expect(run.href).toBeUndefined();
		expect(run.run).toBeTypeOf('function');
	});
});

describe('global halt commands', () => {
	const halted = [
		{ id: 7, ticket: 'STU-3' },
		{ id: 12, ticket: 'WEB-1' }
	];
	const fullSources = (typed: string) => ({
		...sources,
		commands: [
			...commands,
			...globalHaltCommands(haltHandlers()),
			...resumeCommands(halted, typed, vi.fn())
		]
	});

	it('offers :stop by name and by "Not-Aus", together with the :fortsetzen all that lifts it', () => {
		const src = fullSources('');
		expect(labels(suggest(':', 'stop', src))).toEqual([':stop']);
		expect(labels(suggest(':', 'not-aus', src))).toEqual([':stop', ':fortsetzen all']);
	});

	it('offers :anhalten by name and :fortsetzen first among its forms, so ↵ never resumes everything by surprise', () => {
		expect(labels(suggest(':', 'anh', fullSources(':anh')))).toEqual([':anhalten']);
		expect(labels(suggest(':', 'fort', fullSources(':fort')))).toEqual([
			':fortsetzen',
			':fortsetzen all',
			':fortsetzen 7',
			':fortsetzen 12'
		]);
		expect(labels(suggest(':', 'fortsetzen all', fullSources(':fortsetzen all')))).toEqual([
			':fortsetzen all'
		]);
	});

	it('runs the matching handler for :stop, :anhalten, :fortsetzen and :fortsetzen all', () => {
		const handlers = haltHandlers();
		const found = globalHaltCommands(handlers);
		found.find((c) => c.id === 'stop')!.run?.();
		found.find((c) => c.id === 'pause')!.run?.();
		found.find((c) => c.id === 'resume')!.run?.();
		found.find((c) => c.id === 'resume-all')!.run?.();
		expect(handlers.confirmStop).toHaveBeenCalledOnce();
		expect(handlers.confirmPause).toHaveBeenCalledOnce();
		expect(handlers.askWhichRun).toHaveBeenCalledOnce();
		expect(handlers.resumeAll).toHaveBeenCalledOnce();
	});
});

describe('resumeCommands', () => {
	const halted = [
		{ id: 7, ticket: 'STU-3' },
		{ id: 12, ticket: 'WEB-1' }
	];

	it('suggests one :fortsetzen N per halted run with its ticket, and the typed number of any other run', () => {
		const resume = vi.fn();
		expect(resumeCommands(halted, ':fort', resume).map((c) => [c.id, c.label, c.detail])).toEqual([
			['resume-7', ':fortsetzen 7', 'Run 7 · STU-3 fortsetzen'],
			['resume-12', ':fortsetzen 12', 'Run 12 · WEB-1 fortsetzen']
		]);
		expect(
			resumeCommands([], ' :fortsetzen  99 ', resume).map((c) => [c.id, c.label, c.detail])
		).toEqual([['resume-99', ':fortsetzen 99', 'Run 99 fortsetzen']]);
	});

	it('resolves each suggestion to resuming its own run id', () => {
		const resume = vi.fn();
		resumeCommands(halted, '', resume)[1].run?.();
		resumeCommands([], ':fortsetzen 99', resume)[0].run?.();
		expect(resume.mock.calls).toEqual([[12], [99]]);
	});
});

describe('the project list command', () => {
	it('offers :projekte by name and by "anlegen", leading to the project list', () => {
		const [byName] = suggest(':', 'proj', sources);
		expect(byName).toMatchObject({ label: ':projekte', href: '/projects' });
		expect(labels(suggest(':', 'projekt anlegen', sources))).toEqual([':projekte']);
	});
});
