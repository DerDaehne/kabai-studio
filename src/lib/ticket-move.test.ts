import { expect, it } from 'vitest';
import { nextMove } from './ticket-move';

const moves = [
	{ columnId: 1, position: 1, kind: 'normal' as const }, // Refine
	{ columnId: 3, position: 3, kind: 'normal' as const }, // In Arbeit
	{ columnId: 7, position: 7, kind: 'human_intervention' as const } // Human Intervention
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

it('returns undefined for ">" past the last steppable column', () => {
	expect(nextMove(moves, 3, true)).toBeUndefined(); // only Human Intervention lies ahead, and it does not count
});

it('returns undefined when no move is reachable at all', () => {
	expect(nextMove([], 2, true)).toBeUndefined();
	expect(nextMove([], 2, false)).toBeUndefined();
});

// A human column (human_intervention/human_answered) is never a `>`/`<` step target — only normal/done are.
it('steps onto the nearest normal/done column even if it is blocked, never past it onto a human column', () => {
	const abnahme = [
		{ columnId: 6, position: 6, kind: 'done' as const }, // Done, blocked by open tasks (nextMove does not see blockers)
		{ columnId: 7, position: 7, kind: 'human_intervention' as const } // further away, and not steppable anyway
	];
	expect(nextMove(abnahme, 5, true)?.columnId).toBe(6); // Abnahme -> Done, not Human Intervention
});

it('returns undefined past the last normal/done column, even when a human column follows', () => {
	const onlyHumanAhead = [{ columnId: 7, position: 7, kind: 'human_intervention' as const }];
	expect(nextMove(onlyHumanAhead, 6, true)).toBeUndefined(); // from Done, nothing steppable ahead
});
