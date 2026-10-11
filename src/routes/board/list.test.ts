import { describe, expect, it } from 'vitest';
import type { Lage } from '$lib/lage';
import type { ProjectRef } from '$lib/shell/shell.svelte';
import {
	DONE_SHOWN,
	edgeIndex,
	groupByColumn,
	groupByLage,
	groupJump,
	sideJump,
	stepped,
	type BoardColumn,
	type BoardTicket
} from './list';

const studio: ProjectRef = { id: 1, code: 'STU', name: 'Studio', palette: 1 };
const shop: ProjectRef = { id: 2, code: 'SHO', name: 'Shop', palette: 2 };
const column = (id: number, projectId: number, step: string, name: string, position: number) =>
	({ id, projectId, step, name, phase: 'work', position }) as BoardColumn;
const backlog = column(1, 1, 'backlog', 'Backlog', 0);
const refine = column(2, 1, 'refine', 'Präzisieren', 1);
const plan = column(3, 1, 'plan', 'Planen', 2);
const shopPlan = column(12, 2, 'plan', 'Planen', 2);

const ticket = (
	project: ProjectRef,
	number: number,
	at: BoardColumn,
	lage: Lage = 'open',
	updatedAt = '2026-10-01 10:00:00'
): BoardTicket => ({
	id: project.id * 100 + number,
	ref: `${project.code}-${number}`,
	number,
	title: `Ticket ${number}`,
	project,
	column: { id: at.id, name: at.name, phase: at.phase, position: at.position },
	tasks: { done: 0, total: 0 },
	epic: null,
	lage,
	reason: { kind: 'ready' },
	step: at.step,
	progress: { index: 1, total: 5 },
	run: null,
	updatedAt
});

const refs = (tickets: BoardTicket[]) => tickets.map((t) => t.ref);
const name = (lage: Lage) => `name of ${lage}`;

describe('the Lage groups', () => {
	it('are always all five, in board order with what waits for the human first', () => {
		const groups = groupByLage([ticket(studio, 1, plan, 'done')], name);
		expect(groups.map((group) => group.id)).toEqual([
			'waiting',
			'working',
			'open',
			'acceptance',
			'done'
		]);
		expect(groups[0]).toMatchObject({ title: 'name of waiting', rows: [], total: 0 });
	});

	it('sort a Lage by ticket number and project code, whatever order the tickets arrive in', () => {
		const tickets = [ticket(studio, 5, plan), ticket(studio, 3, plan), ticket(shop, 3, shopPlan)];
		expect(refs(groupByLage(tickets, name)[2].rows)).toEqual(['SHO-3', 'STU-3', 'STU-5']);
	});

	it('show only the most recently finished tickets, newest first, and count all of them', () => {
		const finished = Array.from({ length: DONE_SHOWN + 5 }, (_, i) =>
			ticket(studio, i + 1, plan, 'done', `2026-10-01 10:${String(i).padStart(2, '0')}:00`)
		);
		const done = groupByLage(finished, name)[4];
		expect(done.total).toBe(DONE_SHOWN + 5);
		expect(done.rows).toHaveLength(DONE_SHOWN);
		expect(done.rows[0].ref).toBe(`STU-${DONE_SHOWN + 5}`);
	});
});

describe('the expert view', () => {
	it('groups every project by step, in the order of the columns, empty steps included', () => {
		const groups = groupByColumn(
			[ticket(studio, 4, plan), ticket(shop, 2, shopPlan), ticket(studio, 7, refine)],
			[backlog, refine, plan, shopPlan]
		);
		expect(groups.map((group) => group.title)).toEqual(['Backlog', 'Präzisieren', 'Planen']);
		expect(groups[0]).toMatchObject({ rows: [], total: 0 });
		expect(refs(groups[2].rows)).toEqual(['SHO-2', 'STU-4']);
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

describe('h and l', () => {
	it('jump to the start of the next or previous group from anywhere inside a group, and stay at either end', () => {
		const starts = [0, 3, 5];
		expect(sideJump(starts, 1, true, 1)).toBe(3);
		expect(sideJump(starts, 4, false, 1)).toBe(0);
		expect(sideJump(starts, 6, false, 2)).toBe(0);
		expect(sideJump(starts, 6, true, 1)).toBe(6);
		expect(sideJump(starts, 1, false, 1)).toBe(1);
	});
});
