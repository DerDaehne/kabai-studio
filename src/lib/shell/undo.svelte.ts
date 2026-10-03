/** An action the user can take back with u and repeat with Ctrl+r; its hooks change whatever the action changed. */
export type Undoable = { label: string; perform: () => void; revert: () => void };

const newestFirst = (actions: Undoable[], count: number) =>
	actions.slice(Math.max(0, actions.length - count)).reverse();

export class UndoStack {
	done = $state.raw<Undoable[]>([]);
	undone = $state.raw<Undoable[]>([]);

	perform(action: Undoable): void {
		action.perform();
		this.done = [...this.done, action];
		this.undone = [];
	}

	/** Reverts the last `count` actions, newest first, and returns them. */
	undo(count = 1): Undoable[] {
		const reverted = newestFirst(this.done, count);
		reverted.forEach((action) => action.revert());
		this.done = this.done.slice(0, this.done.length - reverted.length);
		this.undone = [...this.undone, ...reverted];
		return reverted;
	}

	/** Performs the last `count` reverted actions again, in their original order, and returns them. */
	redo(count = 1): Undoable[] {
		const repeated = newestFirst(this.undone, count);
		repeated.forEach((action) => action.perform());
		this.undone = this.undone.slice(0, this.undone.length - repeated.length);
		this.done = [...this.done, ...repeated];
		return repeated;
	}
}

/** The one stack all views share, so u takes back the last action wherever it happened. */
export const undoStack = new UndoStack();
