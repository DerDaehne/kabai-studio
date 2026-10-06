import { DEFAULT_PORTS } from '../agents/profile-defaults';

/** Stable failure classes for an OpenAI-compatible endpoint; anything else stays the generic provider_error. */
export type ProviderErrorCode = 'provider_unreachable' | 'model_unknown' | 'provider_auth';

const HINTS: Record<Exclude<ProviderErrorCode, 'provider_auth'>, string> = {
	provider_unreachable: `Modell-Server starten oder Adresse und Port prüfen (${DEFAULT_PORTS}).`,
	model_unknown: 'Modell im Profil wählen, Modelle laden.'
};

const PROVIDER_AUTH_HINTS = {
	withKey: 'Verweis prüfen oder das Secret unter Einstellungen → Secrets ersetzen.',
	withoutKey: 'Key als Secret speichern und als secret:<name> eintragen.'
};

/**
 * The way out for a provider error class — the one place the profile page and a run both read it from. A rejected
 * key gets a different way out depending on whether the profile already points at a secret (fix the reference) or
 * has none yet (create one).
 */
export function providerErrorHint(
	code: ProviderErrorCode,
	{ withKey = false }: { withKey?: boolean } = {}
): string {
	if (code === 'provider_auth')
		return withKey ? PROVIDER_AUTH_HINTS.withKey : PROVIDER_AUTH_HINTS.withoutKey;
	return HINTS[code];
}

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
