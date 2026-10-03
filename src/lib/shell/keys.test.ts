import { describe, expect, it } from 'vitest';
import { continuing, keymap, validKeys, type KeyAction, type KeyGroup, type KeyHint } from './keys';

const sequences = (hints: KeyHint[]) =>
	hints.map((hint) => hint.keys.map((sequence) => sequence.join('')).join('|'));

const bound = (...actions: KeyAction[]) => new Set(actions);

describe('keymap', () => {
	// The design's keymap table, key by key (␣ is the space key, a–z any project letter).
	const designKeymap: Record<KeyGroup, string[]> = {
		Bewegen: ['j', 'k', 'h', 'l', 'gg', 'G', '{', '}'],
		'Öffnen und zurück': ['Enter', 'gd', 'Escape', 'Ctrl+o', 'gs', 'gt', 'gb', 'gr'],
		Entscheiden: ['1', '2', '3', 'i', 's', 'u', 'Ctrl+r'],
		Bearbeiten: ['i', 'a', 'o', 'O', 'dd', 'x', 'y', '>', '<', 'yy'],
		'Suchen und Befehle': ['/', 'n', 'N', ':', '*', 'v'],
		'Projekte und Übersicht': [' a–z', '  ', ' g', '?']
	};

	const registeredKeys = (group: KeyGroup) =>
		Object.values(keymap)
			.filter((binding) => binding.group === group)
			.flatMap((binding) => binding.keys.map((sequence) => sequence.join('')));

	it.each(Object.entries(designKeymap))(
		'registers exactly the design keys under %s',
		(group, keys) => {
			expect(new Set(registeredKeys(group as KeyGroup))).toEqual(new Set(keys));
		}
	);

	it('registers no group the design does not have', () => {
		const groups = new Set(Object.values(keymap).map((binding) => binding.group));
		expect(groups).toEqual(new Set(Object.keys(designKeymap)));
	});

	it('keeps f free', () => {
		const allKeys = Object.values(keymap).flatMap((binding) => binding.keys.flat());
		expect(allKeys).not.toContain('f');
	});

	it('gives every action its own label, so the key bar can tell them apart', () => {
		const labels = Object.values(keymap).map((binding) => binding.label);
		expect(new Set(labels).size).toBe(labels.length);
	});
});

describe('validKeys', () => {
	it('shows different keys when the views bind different actions', () => {
		const stellwerk = sequences(validKeys('stellwerk', '', bound('move', 'stopRun')).hints);
		const takt = sequences(validKeys('takt', '', bound('answer', 'later')).hints);
		expect(stellwerk).toEqual(['j|k', 'x']);
		expect(takt).toEqual(['1|2|3', 's']);
	});

	it('shows only the command line keys while the command line has focus', () => {
		expect(sequences(validKeys('commandline', '', bound('move', 'search')).hints)).toEqual([
			'ArrowUp|ArrowDown',
			'Enter',
			'Escape'
		]);
	});

	it('narrows to the continuations of a started prefix', () => {
		const started = validKeys(
			'stellwerk',
			'g',
			bound('move', 'edge', 'goStellwerk', 'goTakt', 'goBoard')
		);
		expect(started.prefix).toBe('g');
		expect(sequences(started.hints)).toEqual(['gg', 'gs', 'gt', 'gb']);
	});

	it('narrows to keys that take a count while a count is started', () => {
		const started = validKeys('takt', '3', bound('answerOwn', 'later', 'undo', 'move'));
		expect(started.count).toBe('3');
		expect(sequences(started.hints)).toEqual(['j|k', 'u']);
	});

	it('combines a started count with a prefix', () => {
		const started = validKeys('board', '5g', bound('edge', 'open', 'goBoard'));
		expect(started).toMatchObject({ count: '5', prefix: 'g' });
		expect(sequences(started.hints)).toEqual(['gg']);
	});

	it('shows the project letters after the leader', () => {
		const started = validKeys('page', ' ', bound('focusProject', 'focusAll', 'groupBy', 'move'));
		expect(sequences(started.hints)).toEqual(['  ', ' g', ' a–z']);
	});
});

describe('continuing', () => {
	it('keeps only the sequences of a hint that continue the prefix', () => {
		const hint: KeyHint = { keys: [['g', 'g'], ['G']], label: 'Anfang/Ende' };
		expect(continuing(hint, 'g')).toEqual([{ keys: [['g', 'g']], label: 'Anfang/Ende' }]);
	});

	it('drops a hint without any continuation', () => {
		expect(continuing({ keys: [['x']], label: 'stoppen' }, 'g')).toEqual([]);
	});
});
