import { DEFAULT_PORTS } from '../agents/profile-defaults';

/** Stable failure classes for an OpenAI-compatible endpoint; anything else stays the generic provider_error. */
export type ProviderErrorCode = 'provider_unreachable' | 'model_unknown' | 'provider_auth';

const HINTS: Record<ProviderErrorCode, string> = {
	provider_unreachable: `Modell-Server starten oder Adresse und Port prüfen (${DEFAULT_PORTS}).`,
	model_unknown: 'Modell im Profil wählen, Modelle laden.',
	provider_auth: 'Key als Secret speichern und als secret:<name> eintragen.'
};

/** The way out for a provider error class — the one place the profile page and a run both read it from. */
export const providerErrorHint = (code: ProviderErrorCode): string => HINTS[code];

/**
 * Classifies an OpenAI-compatible endpoint failure by its HTTP status, the same way for the profile page and a run:
 * no status at all means the request never got a response (connection refused, DNS failure, dropped before the
 * first byte).
 */
export function classifyProviderFailure(statusCode: number | undefined): ProviderErrorCode | null {
	if (statusCode === 401 || statusCode === 403) return 'provider_auth';
	if (statusCode === 404) return 'model_unknown';
	if (statusCode === undefined) return 'provider_unreachable';
	return null;
}
