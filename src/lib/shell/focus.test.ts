import { describe, expect, it } from 'vitest';
import { focusKeys, focusLetters, focusSummary, inFocus, projectForLetter } from './focus';
import type { ProjectRef } from './shell.svelte';

const project = (id: number, code: string, name: string): ProjectRef => ({
	id,
	code,
	name,
	palette: 1
});

describe('focusLetters', () => {
	it('assigns the first letter of the code when it is free', () => {
		const projects = [project(1, 'STU', 'kabai studio'), project(2, 'WEB', 'Website')];
		expect(focusLetters(projects)).toEqual(
			new Map([
				[1, 's'],
				[2, 'w']
			])
		);
	});

	it('falls back to the next free letter of the code, then the name, on a collision', () => {
		// Five projects whose codes all start with 's'.
		const projects = [
			project(1, 'STU', 'Studio'),
			project(2, 'SUN', 'Sunrise'),
			project(3, 'SEA', 'Seaside'),
			project(4, 'SKY', 'Skyline'),
			project(5, 'SOL', 'Solar')
		];
		expect(focusLetters(projects)).toEqual(
			new Map([
				[1, 's'], // STU: code's first free letter
				[2, 'u'], // SUN: 's' taken, 'u' is next in its own code
				[3, 'e'], // SEA: 's' taken, 'e' is next
				[4, 'k'], // SKY: 's' taken, 'k' is next
				[5, 'o'] // SOL: 's' taken, 'o' is next
			])
		);
	});

	it('is deterministic regardless of the array order, breaking ties by id', () => {
		const a = project(1, 'STU', 'Studio');
		const b = project(2, 'SUN', 'Sunrise');
		expect(focusLetters([a, b])).toEqual(focusLetters([b, a]));
	});

	it('falls back to the name once the whole code is taken', () => {
		const projects = [project(1, 'AAA', 'Apfel'), project(2, 'AAA', 'Birne')];
		expect(focusLetters(projects).get(2)).toBe('b');
	});

	it('leaves a project without a letter once code and name are both exhausted', () => {
		const projects = [project(1, 'A', 'a'), project(2, 'A', 'a')];
		expect(focusLetters(projects).has(2)).toBe(false);
	});
});

describe('projectForLetter', () => {
	const projects = [project(1, 'STU', 'Studio'), project(2, 'SUN', 'Sunrise')];

	it('finds the project whose current letter matches', () => {
		expect(projectForLetter(projects, 'u')?.id).toBe(2);
	});

	it('returns undefined for a letter nothing is assigned to', () => {
		expect(projectForLetter(projects, 'z')).toBeUndefined();
	});
});

describe('focusKeys', () => {
	it('lists every assigned letter with its project, sorted by letter', () => {
		const stu = project(1, 'STU', 'Studio');
		const sun = project(2, 'SUN', 'Sunrise');
		// Passed in reverse of id order; the assignment itself is still keyed by id, not array order.
		expect(focusKeys([sun, stu]).map(({ letter, project: p }) => [letter, p.id])).toEqual([
			['s', 1], // STU (lower id) keeps the first free letter of its own code
			['u', 2] // SUN falls back to the next free letter of its own code
		]);
	});
});

describe('inFocus', () => {
	const stu = project(1, 'STU', 'Studio');

	it('matches every project when nothing is focused', () => {
		expect(inFocus(null, 1)).toBe(true);
		expect(inFocus(null, 2)).toBe(true);
	});

	it('matches only the focused project otherwise', () => {
		expect(inFocus(stu, 1)).toBe(true);
		expect(inFocus(stu, 2)).toBe(false);
	});
});

describe('focusSummary', () => {
	type Row = { id: number; projectId: number };
	const rows: Row[] = [
		{ id: 1, projectId: 1 },
		{ id: 2, projectId: 2 },
		{ id: 3, projectId: 3 },
		{ id: 4, projectId: 2 }
	];
	const projectIdOf = (row: Row) => row.projectId;

	it('keeps everything visible and hides nothing without a focus', () => {
		expect(focusSummary(rows, null, projectIdOf)).toEqual({ visible: rows, hiddenLabel: '' });
	});

	it('keeps only the focused project visible and summarises the rest', () => {
		const stu = project(1, 'STU', 'Studio');
		const summary = focusSummary(rows, stu, projectIdOf);
		expect(summary.visible).toEqual([rows[0]]);
		expect(summary.hiddenLabel).toBe('3 weitere in 2 anderen Projekten');
	});

	it('uses the singular when the hidden items sit in one other project', () => {
		const stu = project(1, 'STU', 'Studio');
		const oneOtherProject: Row[] = [
			{ id: 1, projectId: 1 },
			{ id: 2, projectId: 2 },
			{ id: 3, projectId: 2 }
		];
		expect(focusSummary(oneOtherProject, stu, projectIdOf).hiddenLabel).toBe(
			'2 weitere in 1 anderen Projekt'
		);
	});
});
