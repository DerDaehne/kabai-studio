import { Agent, fetch as undiciFetch } from 'undici';
import { COLD_START_LIMITS } from '../../agents/model-catalog';

/** Margin so the runner's cold start watch, not the socket, ends a run that waits the full limit. */
const MARGIN_MS = 60_000;

/** A fetch whose waits for headers and body chunks outlast `limitMs`, for models that load for minutes before they answer. */
export function createLocalFetch(limitMs: number): typeof fetch {
	const dispatcher = new Agent({
		headersTimeout: limitMs + MARGIN_MS,
		bodyTimeout: limitMs + MARGIN_MS
	});
	const localFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
		undiciFetch(input as never, { ...(init as object), dispatcher });
	// undici's Response type differs from the DOM one only in typings
	return localFetch as unknown as typeof fetch;
}

export const localProviderFetch = createLocalFetch(COLD_START_LIMITS.failAfterMs);
