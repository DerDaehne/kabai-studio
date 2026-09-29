import { EventEmitter } from 'node:events';
import type { Actor } from './domain/core';

/** Eine abgeschlossene Mutation. Die Domain-Schicht publiziert erst nach dem COMMIT. */
export type StudioEvent = { type: string; projectId: number; ticketId?: number; actor: Actor; [key: string]: unknown };

const bus = new EventEmitter();
bus.setMaxListeners(0); // ein Listener pro SSE-Verbindung — kein Leck, keine Warnung

export function publish(event: StudioEvent): void {
	bus.emit('event', event);
}

/** Meldet `listener` für alle Events an; der Rückgabewert meldet wieder ab. */
export function subscribe(listener: (event: StudioEvent) => void): () => void {
	bus.on('event', listener);
	return () => bus.off('event', listener);
}

/** Nur für Tests: aktuelle Zahl der Bus-Listener, um Aufräumen beim Verbindungsende (kein Leck) zu prüfen. */
export function listenerCount(): number {
	return bus.listenerCount('event');
}
