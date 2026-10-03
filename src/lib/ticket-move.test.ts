import { expect, it } from 'vitest';
import { nextMove } from './ticket-move';

const moves = [
	{ columnId: 1, position: 1 }, // Refine
	{ columnId: 3, position: 3 }, // In Arbeit
	{ columnId: 7, position: 7 } // Human Intervention
];

it('finds the closest reachable column ahead (>) without wrapping to the far end', () => {
	expect(nextMove(moves, 2, true)?.columnId).toBe(3); // Ready -> In Arbeit, not Human Intervention
});

it('finds the closest reachable column behind (<) without wrapping to the far end', () => {
	expect(nextMove(moves, 5, false)?.columnId).toBe(3); // Abnahme -> In Arbeit, not Refine
});

it('returns undefined for "<" on the first column (Backlog) — nothing lies before it', () => {
	expect(nextMove(moves, 0, false)).toBeUndefined();
});

it('returns undefined for ">" past the last reachable column', () => {
	expect(nextMove(moves, 7, true)).toBeUndefined();
});

it('returns undefined when no move is reachable at all', () => {
	expect(nextMove([], 2, true)).toBeUndefined();
	expect(nextMove([], 2, false)).toBeUndefined();
});
