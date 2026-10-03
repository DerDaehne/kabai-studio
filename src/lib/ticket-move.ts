export type MoveCandidate = { columnId: number; position: number };

/**
 * The closest reachable column in one board-position direction from `position` — `forward` for `>`, backward for
 * `<`. Picks the nearest, never wraps to the far end: `undefined` means there is nothing that way.
 */
export function nextMove<T extends MoveCandidate>(
	moves: T[],
	position: number,
	forward: boolean
): T | undefined {
	const candidates = moves.filter((m) => (forward ? m.position > position : m.position < position));
	if (!candidates.length) return undefined;
	return candidates.reduce((closest, m) =>
		(forward ? m.position < closest.position : m.position > closest.position) ? m : closest
	);
}
