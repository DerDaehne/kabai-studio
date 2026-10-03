import { describe, expect, it } from 'vitest';
import {
	commands,
	focusCommands,
	focusTarget,
	matchesWordStart,
	parseInput,
	suggest,
	suggestionsFor,
	withViewCommands,
	type Suggestion
} from './commands';
import type { ProjectRef } from './shell.svelte';

const view: Suggestion[] = [{ id: 'view-1', label: 'Spur von qwen3-coder', href: '/#spur' }];
const tickets: Suggestion[] = [
	{ id: 'ticket-45', label: 'Anhänge: Bild-Upload mit Vorschau', href: '/tickets/45' },
	{ id: 'ticket-49', label: 'Push bei neuer Freigabe', href: '/tickets/49' }
];
const sources = { commands, view, tickets };
const labels = (found: Suggestion[]) => found.map((suggestion) => suggestion.label);

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
	it('finds :run for "run" in command mode but not :diff with its "Änderungen"', () => {
		const found = labels(suggest(':', 'run', sources));
		expect(found).toContain(':run');
		expect(found).not.toContain(':diff');
	});

	it('matches the description of a command, not only its name', () => {
		expect(labels(suggest(':', 'änd', sources))).toContain(':diff');
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

	it('is findable alongside :fokus aus for the "fokus" query', () => {
		const found = labels(suggest(':', 'fokus', { ...sources, commands: focusCommands(projects) }));
		expect(found).toEqual([':fokus stu', ':fokus web']);
		expect(labels(suggest(':', 'fokus', sources))).toContain(':fokus aus');
	});
});

describe('focusTarget', () => {
	const projects: ProjectRef[] = [
		{ id: 1, code: 'STU', name: 'kabai studio', palette: 1 },
		{ id: 2, code: 'WEB', name: 'Website', palette: 2 }
	];

	it('resolves a :fokus <code> suggestion to its project, by the id focusCommands gave it', () => {
		expect(focusTarget(focusCommands(projects)[1], projects)).toEqual(projects[1]);
	});

	it('resolves :fokus aus to null, to clear the focus', () => {
		expect(focusTarget({ id: 'fokus-aus', label: ':fokus aus' }, projects)).toBeNull();
	});

	it('resolves any other suggestion to undefined, to leave the focus untouched', () => {
		expect(focusTarget({ id: 'q', label: ':q' }, projects)).toBeUndefined();
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

describe('kill switch commands', () => {
	it('offers :anhalten and :fortsetzen by name and both by "Not-Aus"', () => {
		expect(labels(suggest(':', 'anh', sources))).toEqual([':anhalten']);
		expect(labels(suggest(':', 'fort', sources))).toEqual([':fortsetzen']);
		expect(labels(suggest(':', 'not-aus', sources))).toEqual([':anhalten', ':fortsetzen']);
	});
});

describe(':run', () => {
	it('is a command that runs, no longer one listed as coming later', () => {
		const run = commands.find((command) => command.id === 'run');
		expect(run?.label).toBe(':run');
		expect(run?.available).not.toBe(false);
	});
});

describe('withViewCommands', () => {
	it('lists the commands of the current view first, each in place of a fixed one with its id', () => {
		const own = [
			{ id: 'run', label: ':run', detail: 'Run starten mit „Lokal“', run: () => {} },
			{ id: 'run-2', label: ':run Cloud', run: () => {} }
		];
		const merged = withViewCommands(own, commands);
		expect(merged.slice(0, 2)).toEqual(own);
		expect(merged.filter((command) => command.id === 'run')).toEqual([own[0]]);
		expect(merged).toHaveLength(commands.length + 1);
	});
});
