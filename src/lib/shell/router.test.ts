import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindKeys, handleKey, keyboard, type KeyHandlers, type KeyInput } from './router.svelte';
import { shell } from './shell.svelte';
import { UndoStack } from './undo.svelte';

type Target = { closest(selectors: string): object | null };

/** A stand-in for the focused element: it matches the selectors that start with its tag name. */
const element = (tag: string): Target => ({
	closest: (selectors) =>
		selectors.split(',').some((selector) => selector.trim().startsWith(tag)) ? {} : null
});
const page = element('body');
const textField = element('input');
const openDialog = element('dialog');
const button = element('button');

type Modifiers = { alt?: boolean; ctrl?: boolean; shift?: boolean; altGraph?: boolean };

/** Presses one key and reports whether the router took it (prevented the browser default). */
function press(key: string, options: Modifiers & { code?: string; target?: Target } = {}): boolean {
	let taken = false;
	const event: KeyInput = {
		key,
		code: options.code ?? '',
		altKey: options.alt ?? false,
		ctrlKey: options.ctrl ?? false,
		metaKey: false,
		shiftKey: options.shift ?? false,
		target: (options.target ?? page) as unknown as EventTarget,
		getModifierState: (modifier) => modifier === 'AltGraph' && (options.altGraph ?? false),
		preventDefault: () => (taken = true)
	};
	handleKey(event);
	return taken;
}

const typeKeys = (keys: string) => [...keys].forEach((key) => press(key));

const unbinds: (() => void)[] = [];
function bind(handlers: KeyHandlers) {
	unbinds.push(bindKeys(handlers));
}

afterEach(() => {
	unbinds.splice(0).forEach((unbind) => unbind());
	shell.pendingKeys = '';
	keyboard.singleKeys = true;
});

describe('key router', () => {
	it('runs the bound action and takes the key from the browser', () => {
		const move = vi.fn();
		bind({ move });
		expect(press('j')).toBe(true);
		expect(move).toHaveBeenCalledWith(1, 'j');
	});

	it('runs the most recent binding of an action and falls back once it is unbound', () => {
		const viewMove = vi.fn();
		const searchMove = vi.fn();
		bind({ move: viewMove });
		const unbindSearch = bindKeys({ move: searchMove });
		press('j');
		unbindSearch();
		press('j');
		expect(searchMove).toHaveBeenCalledOnce();
		expect(viewMove).toHaveBeenCalledOnce();
	});

	it('leaves unbound keys to the browser', () => {
		bind({ move: vi.fn() });
		expect(press('x')).toBe(false);
		expect(press('c', { ctrl: true })).toBe(false);
	});

	it('passes a count to the action, as in 3j', () => {
		const move = vi.fn();
		bind({ move });
		typeKeys('3');
		expect(shell.pendingKeys).toBe('3');
		typeKeys('2k');
		expect(move).toHaveBeenCalledWith(32, 'k');
		expect(shell.pendingKeys).toBe('');
	});

	it('waits after a prefix and runs the completed sequence, also with a count as in 5gg', () => {
		const edge = vi.fn();
		const goTakt = vi.fn();
		bind({ edge, goTakt });
		typeKeys('5g');
		expect(shell.pendingKeys).toBe('5g');
		typeKeys('g');
		expect(edge).toHaveBeenCalledWith(5, 'g');
		typeKeys('gt');
		expect(goTakt).toHaveBeenCalledOnce();
	});

	it('drops a prefix that no bound sequence continues', () => {
		const stopRun = vi.fn();
		bind({ goTakt: vi.fn(), stopRun });
		typeKeys('gx');
		expect(stopRun).not.toHaveBeenCalled();
		expect(shell.pendingKeys).toBe('');
	});

	it('reads the leader: a project letter, the leader again for all projects, g for grouping', () => {
		const focusProject = vi.fn();
		const focusAll = vi.fn();
		const groupBy = vi.fn();
		bind({ focusProject, focusAll, groupBy });
		typeKeys(' r');
		typeKeys('  ');
		typeKeys(' g');
		expect(focusProject).toHaveBeenCalledWith(1, 'r');
		expect(focusAll).toHaveBeenCalledOnce();
		expect(groupBy).toHaveBeenCalledOnce();
		expect(focusProject).toHaveBeenCalledOnce();
	});

	it('runs the Ctrl chords Ctrl+o and Ctrl+r', () => {
		const jumpBack = vi.fn();
		const redo = vi.fn();
		bind({ jumpBack, redo });
		expect(press('o', { ctrl: true })).toBe(true);
		press('r', { ctrl: true });
		expect(jumpBack).toHaveBeenCalledOnce();
		expect(redo).toHaveBeenCalledWith(1, 'Ctrl+r');
	});

	it('reads AltGr characters such as { and } as plain keys, on Linux and on Windows', () => {
		const group = vi.fn();
		bind({ group });
		press('{', { altGraph: true });
		press('}', { altGraph: true, ctrl: true, alt: true });
		expect(group.mock.calls).toEqual([
			[1, '{'],
			[1, '}']
		]);
	});

	it('leaves Enter and Space on a focused button to the button', () => {
		const open = vi.fn();
		const focusAll = vi.fn();
		bind({ open, focusAll });
		expect(press('Enter', { target: button })).toBe(false);
		press(' ', { target: button });
		press(' ', { target: button });
		expect(open).not.toHaveBeenCalled();
		expect(focusAll).not.toHaveBeenCalled();
	});
});

describe('single keys in text fields', () => {
	it('do nothing while a text field has focus', () => {
		const move = vi.fn();
		const command = vi.fn();
		bind({ move, command });
		for (const key of ['j', ':', '3', ' ']) expect(press(key, { target: textField })).toBe(false);
		expect(move).not.toHaveBeenCalled();
		expect(command).not.toHaveBeenCalled();
		expect(shell.pendingKeys).toBe('');
	});
});

describe('digits', () => {
	it('count while no decision is in focus', () => {
		const move = vi.fn();
		bind({ move });
		typeKeys('2j');
		expect(move).toHaveBeenCalledWith(2, 'j');
	});

	it('answer 1–3 while a decision is in focus, and counts rest', () => {
		const answer = vi.fn();
		const move = vi.fn();
		bind({ move, answer });
		typeKeys('2');
		expect(answer).toHaveBeenCalledWith(1, '2');
		typeKeys('5j');
		expect(answer).toHaveBeenCalledOnce();
		expect(move).toHaveBeenCalledWith(1, 'j');
	});

	it('do not start a count when nothing bound takes one', () => {
		bind({ open: vi.fn() });
		expect(press('3')).toBe(false);
		expect(shell.pendingKeys).toBe('');
	});
});

describe('Escape', () => {
	it('first cancels a started count or prefix, then ends a search, then goes back', () => {
		const back = vi.fn();
		const endSearch = vi.fn();
		bind({ back, goTakt: vi.fn(), move: vi.fn() });
		const unbindSearch = bindKeys({ endSearch });
		typeKeys('3g');
		expect(press('Escape')).toBe(true);
		typeKeys('3');
		expect(press('Escape')).toBe(true);
		expect(shell.pendingKeys).toBe('');
		expect(endSearch).not.toHaveBeenCalled();
		press('Escape');
		expect(endSearch).toHaveBeenCalledOnce();
		expect(back).not.toHaveBeenCalled();
		unbindSearch();
		press('Escape');
		expect(back).toHaveBeenCalledOnce();
	});
});

describe('undo and redo', () => {
	it('take back actions of two kinds with 3u and repeat one with Ctrl+r', () => {
		const stack = new UndoStack();
		const rows = ['STU-1', 'STU-2'];
		let column = 'Ready';
		bind({ undo: (count) => stack.undo(count), redo: (count) => stack.redo(count) });
		stack.perform({
			label: 'gelöscht',
			perform: () => rows.pop(),
			revert: () => rows.push('STU-2')
		});
		stack.perform({
			label: 'Review',
			perform: () => (column = 'Review'),
			revert: () => (column = 'Ready')
		});
		stack.perform({
			label: 'Done',
			perform: () => (column = 'Done'),
			revert: () => (column = 'Review')
		});
		typeKeys('3u');
		expect(rows).toEqual(['STU-1', 'STU-2']);
		expect(column).toBe('Ready');
		press('r', { ctrl: true });
		expect(rows).toEqual(['STU-1']);
		expect(column).toBe('Ready');
	});
});

describe('with single keys switched off', () => {
	it('only Alt+key works, also for prefixes, counts and the physical key behind a macOS Alt character', () => {
		keyboard.singleKeys = false;
		const move = vi.fn();
		const goTakt = vi.fn();
		bind({ move, goTakt });
		expect(press('j')).toBe(false);
		typeKeys('gt');
		expect(move).not.toHaveBeenCalled();
		expect(goTakt).not.toHaveBeenCalled();
		press('2', { alt: true, code: 'Digit2' });
		press('∆', { alt: true, code: 'KeyJ' });
		press('g', { alt: true, code: 'KeyG' });
		press('t', { alt: true, code: 'KeyT' });
		expect(move).toHaveBeenCalledWith(2, 'j');
		expect(goTakt).toHaveBeenCalledOnce();
	});

	it('still lets Escape, Enter and Ctrl chords through, as they are no single characters', () => {
		keyboard.singleKeys = false;
		const open = vi.fn();
		const jumpBack = vi.fn();
		bind({ open, jumpBack, move: vi.fn() });
		press('3', { alt: true, code: 'Digit3' });
		press('Escape');
		expect(shell.pendingKeys).toBe('');
		press('Enter');
		press('o', { ctrl: true });
		expect(open).toHaveBeenCalledOnce();
		expect(jumpBack).toHaveBeenCalledOnce();
	});
});

describe('the key overview', () => {
	it('opens with ?, and with Alt+? when single keys are off', () => {
		const help = vi.fn();
		bind({ help });
		press('?', { shift: true });
		keyboard.singleKeys = false;
		press('?', { shift: true });
		press('?', { shift: true, alt: true, code: 'Minus' });
		expect(help).toHaveBeenCalledTimes(2);
	});

	it('gets Escape for itself: the router stands down inside an open dialog', () => {
		const back = vi.fn();
		const move = vi.fn();
		bind({ back, move });
		expect(press('Escape', { target: openDialog })).toBe(false);
		press('j', { target: openDialog });
		expect(back).not.toHaveBeenCalled();
		expect(move).not.toHaveBeenCalled();
	});
});
