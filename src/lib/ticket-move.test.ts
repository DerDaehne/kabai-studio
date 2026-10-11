import { expect, it } from 'vitest';
import { nextMove } from './ticket-move';

const moves = [
	{ columnId: 1, position: 1 }, // "Präzisieren"
	{ columnId: 3, position: 3 }, // "Umsetzen"
	{ columnId: 6, position: 6 } // "Fertig"
];

it('finds the closest reachable column ahead (>) without wrapping to the far end', () => {
	expect(nextMove(moves, 2, true)?.columnId).toBe(3); // "Planen" -> "Umsetzen", not "Fertig"
});

it('finds the closest reachable column behind (<) without wrapping to the far end', () => {
	expect(nextMove(moves, 5, false)?.columnId).toBe(3); // "Abnahme" -> "Umsetzen", not "Präzisieren"
});

it('returns undefined for "<" on the first column (Backlog) — nothing lies before it', () => {
	expect(nextMove(moves, 0, false)).toBeUndefined();
});

it('returns undefined for ">" on the last column (Fertig) — nothing lies after it', () => {
	expect(nextMove(moves, 6, true)).toBeUndefined();
});

it('returns undefined when no move is reachable at all', () => {
	expect(nextMove([], 2, true)).toBeUndefined();
	expect(nextMove([], 2, false)).toBeUndefined();
});
