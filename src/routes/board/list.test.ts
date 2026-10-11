import { describe, expect, it } from 'vitest';
import type { ProjectRef } from '$lib/shell/shell.svelte';
import {
	edgeIndex,
	groupByColumn,
	groupJump,
	startRule,
	stepped,
	type BoardColumn,
	type BoardTicket
} from './list';

const studio: ProjectRef = { id: 1, code: 'STU', name: 'Studio', palette: 1 };
const shop: ProjectRef = { id: 2, code: 'SHO', name: 'Shop', palette: 2 };
const backlog: BoardColumn = { id: 1, name: 'Backlog', phase: 'open', position: 0 };
const refine: BoardColumn = { id: 2, name: 'Refine', phase: 'work', position: 1 };
const ready: BoardColumn = { id: 3, name: 'Ready', phase: 'work', position: 2 };
const shopReady: BoardColumn = { id: 12, name: 'Ready', phase: 'work', position: 2 };

const ticket = (project: ProjectRef, number: number, column: BoardColumn): BoardTicket => ({
	id: project.id * 100 + number,
	ref: `${project.code}-${number}`,
	number,
	title: `Ticket ${number}`,
	project,
	column,
	tasks: { done: 0, total: 0 },
	epic: null,
	lage: 'open',
	reason: { kind: 'ready' },
	step: 'refine',
	progress: { index: 1, total: 5 },
	next: {}
});

const refs = (tickets: BoardTicket[]) => tickets.map((t) => t.ref);

describe('the board list', () => {
	it('groups the tickets of every project by column name, in board order', () => {
		const groups = groupByColumn([
			ticket(studio, 4, ready),
			ticket(shop, 2, shopReady),
			ticket(studio, 7, refine),
			ticket(studio, 1, backlog)
		]);
		expect(groups.map((group) => group.column.name)).toEqual(['Backlog', 'Refine', 'Ready']);
		expect(refs(groups[2].rows)).toEqual(['SHO-2', 'STU-4']);
	});

	it('sorts each column by ticket number ascending, whatever order the tickets arrive in', () => {
		const tickets = [5, 2, 9, 1].map((number) => ticket(studio, number, ready));
		const sorted = ['STU-1', 'STU-2', 'STU-5', 'STU-9'];
		expect(refs(groupByColumn(tickets)[0].rows)).toEqual(sorted);
		expect(refs(groupByColumn([...tickets].reverse())[0].rows)).toEqual(sorted);
	});

	it('orders equal ticket numbers of different projects by project code', () => {
		const rows = groupByColumn([ticket(studio, 3, ready), ticket(shop, 3, shopReady)])[0].rows;
		expect(refs(rows)).toEqual(['SHO-3', 'STU-3']);
	});

	it('names how a run starts in each phase of column', () => {
		for (const phase of ['open', 'work', 'acceptance'] as const)
			expect(startRule(phase)).toBe('Start per :run');
		expect(startRule('done')).toBe('fertig, kein Run');
	});
});

describe('moving the selection', () => {
	it('steps by the count and stops at either end', () => {
		expect(stepped(0, 1, 5)).toBe(1);
		expect(stepped(1, 3, 5)).toBe(4);
		expect(stepped(3, 9, 5)).toBe(4);
		expect(stepped(2, -9, 5)).toBe(0);
	});

	it('jumps to the last row with G and to the row the count names with gg', () => {
		expect(edgeIndex('G', 1, 5)).toBe(4);
		expect(edgeIndex('g', 1, 5)).toBe(0);
		expect(edgeIndex('g', 3, 5)).toBe(2);
		expect(edgeIndex('g', 9, 5)).toBe(4);
	});

	it('jumps to the start of the next group with } and back to the start of the current or previous one with {', () => {
		const starts = [0, 3, 5];
		expect(groupJump(starts, 1, true, 1)).toBe(3);
		expect(groupJump(starts, 1, true, 2)).toBe(5);
		expect(groupJump(starts, 6, true, 1)).toBe(6);
		expect(groupJump(starts, 4, false, 1)).toBe(3);
		expect(groupJump(starts, 3, false, 1)).toBe(0);
		expect(groupJump(starts, 6, false, 2)).toBe(3);
		expect(groupJump(starts, 0, false, 1)).toBe(0);
	});
});
