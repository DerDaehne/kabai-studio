export type MoveCandidate = {
	columnId: number;
	position: number;
	kind: 'normal' | 'done' | 'human_intervention' | 'human_answered';
};

// `>`/`<` step through the normal board flow only; a human column is a destination you choose from the move
// menu, never something a key press lands you in by accident.
const STEPPABLE: ReadonlySet<MoveCandidate['kind']> = new Set(['normal', 'done']);

/**
 * The closest normal/done column in one board-position direction from `position` — `forward` for `>`, backward
 * for `<`. Picks the nearest, blocked or not (the caller decides what a blocked target means); never wraps to
 * the far end and never lands on a human column: `undefined` means there is nothing steppable that way.
 */
export function nextMove<T extends MoveCandidate>(
	moves: T[],
	position: number,
	forward: boolean
): T | undefined {
	const candidates = moves.filter(
		(m) => STEPPABLE.has(m.kind) && (forward ? m.position > position : m.position < position)
	);
	if (!candidates.length) return undefined;
	return candidates.reduce((closest, m) =>
		(forward ? m.position < closest.position : m.position > closest.position) ? m : closest
	);
}
