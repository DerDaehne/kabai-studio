import { describe, expect, it } from 'vitest';
import { continuing, validKeys, type KeyHint } from './keys';

const sequences = (hints: KeyHint[]) => hints.map((hint) => hint.keys.map((sequence) => sequence.join('')).join('|'));

describe('validKeys', () => {
	it('shows different keys when the context switches from Stellwerk to Takt', () => {
		const stellwerk = sequences(validKeys('stellwerk', '').hints);
		const takt = sequences(validKeys('takt', '').hints);
		expect(stellwerk).toContain('x');
		expect(stellwerk).not.toContain('s');
		expect(takt).toContain('s');
		expect(takt).not.toContain('x');
	});

	it('shows only the command line keys while the command line has focus', () => {
		expect(sequences(validKeys('commandline', '').hints)).toEqual(['ArrowUp|ArrowDown', 'Enter', 'Escape']);
	});

	it('narrows to the continuations of a started prefix', () => {
		const started = validKeys('stellwerk', 'g');
		expect(started.prefix).toBe('g');
		expect(sequences(started.hints)).toEqual(['gg', 'gs', 'gt', 'gb']);
	});

	it('narrows to keys that take a count while a count is started', () => {
		const started = validKeys('takt', '3');
		expect(started.count).toBe('3');
		expect(started.hints.length).toBeGreaterThan(0);
		expect(started.hints.every((hint) => hint.counted)).toBe(true);
	});

	it('combines a started count with a prefix', () => {
		const started = validKeys('board', '5g');
		expect(started).toMatchObject({ count: '5', prefix: 'g' });
		expect(sequences(started.hints)).toEqual(['gg']);
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
