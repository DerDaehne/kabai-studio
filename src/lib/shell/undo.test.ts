import { describe, expect, it } from 'vitest';
import { UndoStack } from './undo.svelte';

function board() {
	const rows = ['STU-1', 'STU-2', 'STU-3'];
	const columns: Record<string, string> = { 'STU-1': 'Ready', 'STU-2': 'Ready', 'STU-3': 'Ready' };
	const stack = new UndoStack();
	const remove = (row: string) => {
		const index = rows.indexOf(row);
		stack.perform({
			label: `${row} gelöscht`,
			perform: () => rows.splice(index, 1),
			revert: () => rows.splice(index, 0, row)
		});
	};
	const move = (row: string, to: string) => {
		const from = columns[row];
		stack.perform({
			label: `${row} nach ${to}`,
			perform: () => (columns[row] = to),
			revert: () => (columns[row] = from)
		});
	};
	return { rows, columns, stack, remove, move };
}

describe('UndoStack', () => {
	it('takes back actions of different kinds, newest first', () => {
		const { rows, columns, stack, remove, move } = board();
		remove('STU-2');
		move('STU-1', 'Review');
		expect(stack.undo().map((action) => action.label)).toEqual(['STU-1 nach Review']);
		expect(columns['STU-1']).toBe('Ready');
		expect(rows).toEqual(['STU-1', 'STU-3']);
		stack.undo();
		expect(rows).toEqual(['STU-1', 'STU-2', 'STU-3']);
	});

	it('takes back several actions at once and repeats them in their original order', () => {
		const { rows, columns, stack, remove, move } = board();
		move('STU-3', 'Review');
		remove('STU-1');
		move('STU-2', 'Done');
		stack.undo(3);
		expect(rows).toEqual(['STU-1', 'STU-2', 'STU-3']);
		expect(Object.values(columns)).toEqual(['Ready', 'Ready', 'Ready']);
		expect(stack.redo(2).map((action) => action.label)).toEqual([
			'STU-3 nach Review',
			'STU-1 gelöscht'
		]);
		expect(rows).toEqual(['STU-2', 'STU-3']);
		expect(columns['STU-2']).toBe('Ready');
	});

	it('forgets what could be repeated once a new action is taken', () => {
		const { stack, remove, move } = board();
		remove('STU-1');
		stack.undo();
		move('STU-2', 'Review');
		expect(stack.redo()).toEqual([]);
		expect(stack.undone).toEqual([]);
	});

	it('does nothing when there is nothing to take back', () => {
		expect(new UndoStack().undo(3)).toEqual([]);
	});

	it('takes back one particular action, as the undo button on its own notice does, and keeps the newer ones', () => {
		const { rows, columns, stack, remove, move } = board();
		remove('STU-2');
		move('STU-1', 'Review');
		const [removed, moved] = stack.done;

		stack.revert(removed);
		expect(rows).toEqual(['STU-1', 'STU-2', 'STU-3']);
		expect(columns['STU-1']).toBe('Review');
		expect(stack.done).toEqual([moved]);
		expect(stack.undone).toEqual([removed]);

		stack.revert(removed);
		expect(rows).toEqual(['STU-1', 'STU-2', 'STU-3']);
	});

	it('reverting the newest action is the same as u', () => {
		const viaRevert = board();
		const viaUndo = board();
		for (const { move } of [viaRevert, viaUndo]) move('STU-1', 'Review');
		viaRevert.stack.revert(viaRevert.stack.done[0]);
		viaUndo.stack.undo();
		expect(viaRevert.columns).toEqual(viaUndo.columns);
		expect(viaRevert.stack.undone.map((a) => a.label)).toEqual(
			viaUndo.stack.undone.map((a) => a.label)
		);
	});

	it('takes back everything there is when the count is larger', () => {
		const { rows, stack, remove } = board();
		remove('STU-1');
		remove('STU-2');
		expect(stack.undo(3)).toHaveLength(2);
		expect(rows).toEqual(['STU-1', 'STU-2', 'STU-3']);
	});
});
