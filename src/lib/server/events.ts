import { EventEmitter } from 'node:events';
import type { Actor } from './domain/core';

/** A committed mutation. The domain layer publishes only after COMMIT. */
export type StudioEvent = {
	type: string;
	projectId: number;
	ticketId?: number;
	actor: Actor;
	[key: string]: unknown;
};

const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per SSE connection is no leak, so no warning

export function publish(event: StudioEvent): void {
	bus.emit('event', event);
}

/** Subscribes `listener` to all events; the returned function unsubscribes. */
export function subscribe(listener: (event: StudioEvent) => void): () => void {
	bus.on('event', listener);
	return () => bus.off('event', listener);
}

/** Tests only: the current number of bus listeners, to check the cleanup at connection end. */
export function listenerCount(): number {
	return bus.listenerCount('event');
}
