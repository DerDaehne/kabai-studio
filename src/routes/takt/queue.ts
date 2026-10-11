import type { QueuedQuestion } from '$lib/live';

export type { QueuedQuestion };

/**
 * The queue in the order the human arranged it: what they deferred or took back keeps its place, questions that
 * arrived since go to the end (the server lists them oldest first), and an answered question disappears at once.
 */
export function arranged(
	open: QueuedQuestion[],
	order: number[],
	answered: ReadonlySet<number>
): QueuedQuestion[] {
	const waiting = open.filter((question) => !answered.has(question.id));
	const byId = new Map(waiting.map((question) => [question.id, question]));
	const placed = order.flatMap((id) => byId.get(id) ?? []);
	const arrived = waiting.filter((question) => !order.includes(question.id));
	return [...placed, ...arrived];
}

const idsWithout = (queue: QueuedQuestion[], id: number) =>
	queue.map((question) => question.id).filter((other) => other !== id);

/** The order once `id` is deferred to the end of the queue. */
export const deferred = (queue: QueuedQuestion[], id: number) => [...idsWithout(queue, id), id];

/** The order once the answer to `id` is taken back: its question returns to the front. */
export const restored = (queue: QueuedQuestion[], id: number) => [id, ...idsWithout(queue, id)];
