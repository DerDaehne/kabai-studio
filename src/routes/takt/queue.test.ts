import { describe, expect, it } from 'vitest';
import { arranged, decisionKey, deferred, queueKey, restored, taktAurae } from './queue';
import type { QueuedQuestion } from './queue';

const question = (id: number): QueuedQuestion => ({
	id,
	ticket: { ref: `STU-${id}`, number: id, title: `Ticket ${id}` },
	project: { id: 1, code: 'STU', name: 'Studio', palette: 1 },
	profile: 'qwen',
	askedAt: '2026-10-03T12:00:00.000Z',
	question: `Frage ${id}?`,
	options: [{ label: 'A' }, { label: 'B' }]
});
const ids = (queue: QueuedQuestion[]) => queue.map((q) => q.id);
const none = new Set<number>();

describe('the Takt queue', () => {
	it('keeps the oldest-first order of the server and appends questions that arrive later, so the card in focus stays', () => {
		const before = arranged([question(1), question(2)], [], none);
		expect(ids(before)).toEqual([1, 2]);

		const afterArrival = arranged([question(1), question(2), question(3)], ids(before), none);
		expect(ids(afterArrival)).toEqual([1, 2, 3]);
		expect(afterArrival[0]).toEqual(before[0]);
	});

	it('appends a question that arrives after the human rearranged the queue, behind what they arranged', () => {
		const order = deferred([question(1), question(2)], 1);
		expect(ids(arranged([question(1), question(2), question(3)], order, none))).toEqual([2, 1, 3]);
	});

	it('leaves out an answered question at once, before the server stops listing it', () => {
		expect(ids(arranged([question(1), question(2)], [], new Set([1])))).toEqual([2]);
	});

	it('drops questions the server no longer lists, e.g. answered in another tab', () => {
		expect(ids(arranged([question(2)], [1, 2], none))).toEqual([2]);
	});

	it('s moves the question in focus to the end of the queue without answering it', () => {
		const queue = [question(1), question(2), question(3)];
		expect(ids(arranged(queue, deferred(queue, 1), none))).toEqual([2, 3, 1]);
	});

	it('a question whose answer was taken back returns to the front', () => {
		const queue = [question(2), question(3)];
		const order = restored(queue, 1);
		expect(ids(arranged([question(1), ...queue], order, none))).toEqual([1, 2, 3]);
	});
});

describe('auras in Takt', () => {
	it('the decision card carries the only strong aura, in the colour of its kind; the light cone in the queue is weak', () => {
		const visible = [question(1), question(2), question(3)];
		const aurae = taktAurae(visible);

		const strong = [...aurae].filter(([, aura]) => aura.strength === 'strong');
		expect(strong).toEqual([[decisionKey, { strength: 'strong', color: 'var(--aura-waiting)' }]]);
		expect(aurae.get(queueKey(visible[0]))).toEqual({
			strength: 'weak',
			color: 'var(--aura-accent)'
		});
		expect(aurae.has(queueKey(visible[1]))).toBe(false);
		expect(aurae.has(queueKey(visible[2]))).toBe(false);
	});

	it('hands out no aura without a question', () => {
		expect(taktAurae([]).size).toBe(0);
	});
});
