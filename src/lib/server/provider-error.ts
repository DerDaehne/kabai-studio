import { APICallError, RetryError } from 'ai';
import { DEFAULT_PORTS } from '../agents/profile-defaults';
import { DomainError } from './domain/core';
import { mask } from './secrets';

/** Stable failure classes for a run's model provider; anything else stays the generic provider_error. */
export type ProviderErrorCode =
	| 'provider_unreachable'
	| 'model_unknown'
	| 'provider_auth'
	| 'provider_rate_limited'
	| 'provider_unavailable';

const PROVIDER_AUTH_HINTS = {
	withKey: 'Verweis prüfen oder das Secret unter Einstellungen → Secrets ersetzen.',
	withoutKey: 'Key als Secret speichern und als secret:<name> eintragen.'
};

const LOCAL_HINTS: Record<Exclude<ProviderErrorCode, 'provider_auth'>, string> = {
	provider_unreachable: `Modell-Server starten oder Adresse und Port prüfen (${DEFAULT_PORTS}).`,
	model_unknown: 'Modell im Profil wählen, Modelle laden.',
	provider_rate_limited: 'Modell-Server ist ausgelastet — später neuen Run starten.',
	provider_unavailable: 'Log des Modell-Servers prüfen, ggf. neu starten, dann neuen Run starten.'
};

const CLOUD_HINTS: Record<Exclude<ProviderErrorCode, 'provider_auth'>, string> = {
	provider_unreachable:
		'Netzwerkzugang des Servers prüfen (DNS, Proxy, Firewall), dann neuen Run starten.',
	model_unknown: 'Modell-ID im Profil mit der Modellliste in der Doku des Providers abgleichen.',
	provider_rate_limited:
		'Rate-Limit oder Guthaben im Konto des Providers prüfen, später neuen Run starten.',
	provider_unavailable:
		'Provider gestört oder überlastet — Statusseite prüfen, später neuen Run starten.'
};

/**
 * The way out for a provider error class — the one place the profile page and a run both read it from. Cloud never
 * names a local port or "Modelle laden". A rejected key gets a different way out depending on whether the profile
 * already points at a secret (fix the reference) or has none yet (create one).
 */
export function providerErrorHint(
	code: ProviderErrorCode,
	{ withKey = false, cloud = false }: { withKey?: boolean; cloud?: boolean } = {}
): string {
	if (code === 'provider_auth')
		return withKey ? PROVIDER_AUTH_HINTS.withKey : PROVIDER_AUTH_HINTS.withoutKey;
	return (cloud ? CLOUD_HINTS : LOCAL_HINTS)[code];
}

/**
 * Classifies a provider failure by its HTTP status, the same way for the profile page and a run. Used directly only
 * for a response that came through; a request that never got one is {@link providerFailure}'s own call to make,
 * since only it knows whether the AI SDK thought the attempt worth retrying.
 */
export function classifyProviderFailure(statusCode: number | undefined): ProviderErrorCode | null {
	if (statusCode === 401 || statusCode === 403) return 'provider_auth';
	if (statusCode === 404) return 'model_unknown';
	if (statusCode === 429) return 'provider_rate_limited';
	if (statusCode !== undefined && statusCode >= 500) return 'provider_unavailable';
	return null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const providerNoun = (cloud: boolean) => (cloud ? 'Der Provider' : 'Der Modell-Server');

function classifiedMessage(code: ProviderErrorCode, error: APICallError, cloud: boolean): string {
	const noun = providerNoun(cloud);
	if (code === 'provider_unreachable')
		return `Endpunkt ${new URL(error.url).origin} nicht erreichbar: ${errorText(error)}.`;
	if (code === 'model_unknown') return `${noun} kennt das Modell nicht: ${errorText(error)}`;
	if (code === 'provider_rate_limited')
		return `${noun} hat die Anfrage mit Rate-Limit abgelehnt: ${errorText(error)}`;
	if (code === 'provider_unavailable')
		return `${noun} hat mit einem Serverfehler geantwortet: ${errorText(error)}`;
	return `${noun} verlangt oder verweigert den API-Key (HTTP ${error.statusCode}).`;
}

/**
 * No status at all means the request never got a response. The AI SDK's own fetch wrapper already marks a
 * connection that never came through (connection refused, DNS failure, dropped before the first byte) as not worth
 * retrying, which is exactly `provider_unreachable`; a connection that came through and then dropped stays
 * retryable, which is `provider_unavailable`, the same as a 5xx.
 */
function classifyUnresponsive(error: APICallError): ProviderErrorCode {
	return error.isRetryable === false ? 'provider_unreachable' : 'provider_unavailable';
}

/**
 * Builds the run's DomainError for a provider failure. 429 and 5xx arrive wrapped in a `RetryError` once the AI
 * SDK's own retries are exhausted, so its `lastError` is unwrapped first.
 */
export function providerFailure(
	error: unknown,
	{ withKey, cloud }: { withKey: boolean; cloud: boolean }
): DomainError {
	const cause = RetryError.isInstance(error) ? error.lastError : error;
	const code =
		APICallError.isInstance(cause) &&
		(classifyProviderFailure(cause.statusCode) ??
			(cause.statusCode === undefined ? classifyUnresponsive(cause) : null));
	if (code)
		return new DomainError(
			code,
			mask(classifiedMessage(code, cause as APICallError, cloud)),
			providerErrorHint(code, { withKey, cloud })
		);
	return new DomainError(
		'provider_error',
		mask(`${providerNoun(cloud)} hat mit einem Fehler geantwortet: ${errorText(cause)}`),
		cloud
			? 'Prüfe im Agent-Profil model und api_key_ref, dann starte einen neuen Run.'
			: 'Prüfe im Agent-Profil base_url, model und api_key_ref und im Log des Modell-Servers die Ursache, dann starte einen neuen Run.'
	);
}

const formatDuration = (ms: number) =>
	ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

/**
 * Builds the run's DomainError for a stream that stopped answering. Before a step's first chunk this is the cloud
 * provider's `firstChunkMs` timeout (local models get the runner's own cold-start watch instead and never reach
 * here unstarted); after the first chunk it is the shared inactivity timeout, for either kind of provider.
 */
export function inactiveProviderFailure(
	durationMs: number,
	{ cloud, neverStarted }: { cloud: boolean; neverStarted: boolean }
): DomainError {
	const text = neverStarted
		? `Das Modell hat nach ${formatDuration(durationMs)} nicht zu antworten begonnen.`
		: `Das Modell hat ${formatDuration(durationMs)} lang nichts mehr gesendet, nachdem es zu antworten begonnen hatte.`;
	return new DomainError(
		'provider_inactive',
		text,
		cloud
			? CLOUD_HINTS.provider_unavailable
			: 'Prüfe im Log des Modell-Servers, ob er hängt oder abgestürzt ist, dann starte einen neuen Run.'
	);
}
