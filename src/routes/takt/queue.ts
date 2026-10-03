import type { ProjectRef } from '$lib/shell/shell.svelte';
import { assignAurae, type Aura } from '$lib/ui/aura';

export type QueuedQuestion = {
	id: number;
	/** `ref` such as `STU-12`; `number` addresses the ticket within its project. */
	ticket: { ref: string; number: number; title: string };
	project: ProjectRef;
	/** The profile of the asking run; null for a question without a run or with a deleted profile. */
	profile: string | null;
	/** ISO timestamp. */
	askedAt: string;
	question: string;
	options: { label: string; effect?: string }[];
};

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

export const decisionKey = 'decision';
export const queueKey = (question: QueuedQuestion) => `q${question.id}`;

/** The decision card is the one strong signal; in the queue only a weak light cone marks the question it shows. */
export function taktAurae(visible: QueuedQuestion[]): Map<string, Aura> {
	if (!visible.length) return new Map();
	return assignAurae([
		{ key: decisionKey, tone: 'waiting', focused: true },
		...visible.map((question, index) => ({ key: queueKey(question), focused: index === 0 }))
	]);
}
