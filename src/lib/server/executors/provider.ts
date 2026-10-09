import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, type JSONValue, type LanguageModel } from 'ai';
import type { DatabaseSync } from 'node:sqlite';
import {
	cloudModel,
	matchModel,
	MODEL_ROLES,
	stepCost,
	type CloudProvider,
	type Effort,
	type ModelEntry,
	type ModelRole,
	type SamplingParams
} from '../../agents/model-catalog';
import { DomainError } from '../domain/core';
import type { Profile } from '../domain/runs';
import { providerErrorHint } from '../provider-error';
import { resolveRef } from '../secrets';

/** The name under which `providerOptions` reach the request body unchanged. */
export const PROVIDER_NAME = 'studio';
const SAMPLING_PARAMS = ['temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty'] as const;
// Pinned, so that OPENAI_BASE_URL or ANTHROPIC_BASE_URL in the environment cannot send the key elsewhere.
const CLOUD_ENDPOINTS: Record<CloudProvider, { label: string; baseURL: string }> = {
	anthropic: { label: 'Anthropic', baseURL: 'https://api.anthropic.com/v1' },
	openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1' }
};

type ProviderProfile = Pick<Profile, 'provider' | 'base_url' | 'model' | 'api_key_ref'>;
type SettingsProfile = Pick<Profile, 'provider' | 'model' | 'params' | 'max_tokens'>;
type JsonBody = Record<string, number | { enable_thinking: boolean }>;
export type RequestSettings = {
	maxOutputTokens?: number;
	providerOptions: Record<string, Record<string, JSONValue>>;
};

export const isCloud = (provider: string | null): provider is CloudProvider =>
	provider !== null && Object.hasOwn(CLOUD_ENDPOINTS, provider);

/** The profile's model at its provider; the API key comes from the secrets store and is masked from then on. */
export function modelFor(
	db: DatabaseSync,
	profile: ProviderProfile,
	fetch: typeof globalThis.fetch
): LanguageModel {
	const guarded = failFastOnConnectionError(fetch);
	if (profile.provider === 'openai-compatible') return openAICompatibleModel(db, profile, guarded);
	if (isCloud(profile.provider)) return cloudLanguageModel(db, profile, profile.provider, guarded);
	throw new DomainError(
		'provider_unsupported',
		`Der builtin-Executor spricht kein „${profile.provider}“.`,
		'Wähle im Agent-Profil den Provider openai-compatible, openai oder anthropic.'
	);
}

function openAICompatibleModel(
	db: DatabaseSync,
	profile: ProviderProfile,
	fetch: typeof globalThis.fetch
): LanguageModel {
	if (!profile.base_url || !profile.model)
		throw new DomainError(
			'missing_base_url',
			'Ein openai-compatible-Profil braucht base_url und model.',
			'Trage im Profil die Adresse des Modell-Servers ein, z. B. http://127.0.0.1:8080/v1.'
		);
	const apiKey = profile.api_key_ref ? resolveRef(db, profile.api_key_ref) : undefined;
	return createOpenAICompatible({
		name: PROVIDER_NAME,
		baseURL: profile.base_url,
		apiKey,
		includeUsage: true,
		fetch
	}).chatModel(profile.model);
}

/** Without a key reference the run fails here: the providers would otherwise read a key from the environment. */
function cloudLanguageModel(
	db: DatabaseSync,
	profile: ProviderProfile,
	provider: CloudProvider,
	fetch: typeof globalThis.fetch
): LanguageModel {
	const { label, baseURL } = CLOUD_ENDPOINTS[provider];
	if (!profile.api_key_ref)
		throw new DomainError(
			'provider_auth',
			`Ein ${label}-Profil braucht einen API-Key.`,
			providerErrorHint('provider_auth')
		);
	if (!profile.model)
		throw new DomainError(
			'missing_model',
			`Ein ${label}-Profil braucht ein model.`,
			'Trage im Agent-Profil die Modell-ID laut aktueller Doku des Anbieters ein.'
		);
	const settings = { baseURL, apiKey: resolveRef(db, profile.api_key_ref), fetch };
	if (provider === 'anthropic') return createAnthropic(settings)(profile.model);
	return createOpenAI(settings).responses(profile.model);
}

// undici throws the same TypeError('fetch failed') for a slow or silent server, TLS failures and an unknown scheme
// as for a connection that never comes through — only these codes mean the connect phase itself failed.
const CONNECT_ERROR_CODES = new Set([
	'ECONNREFUSED',
	'ENOTFOUND',
	'EAI_AGAIN',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'UND_ERR_CONNECT_TIMEOUT'
]);

/**
 * A connection that never comes through (server down, wrong port, DNS failure) fails the request at once instead of
 * through the AI SDK's own retry backoff: waiting a few more seconds never helps, the way out is starting the model
 * server. Everything else (a server that accepted the connection but stays silent while loading a model, a dropped
 * socket, TLS) is rethrown unchanged, so a slow cold start still gets the AI SDK's own retry and the runner's
 * cold-start handling instead of a premature "unreachable".
 */
function failFastOnConnectionError(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
	return async (input, init) => {
		try {
			return await fetch(input, init);
		} catch (err) {
			const cause = err instanceof TypeError && err.cause instanceof Error ? err.cause : null;
			if (!cause || !('code' in cause) || !CONNECT_ERROR_CODES.has(String(cause.code))) throw err;
			// no `cause` chain here: the AI SDK's own retry wrapper walks it for a retryable network error
			// code and overrides isRetryable to true once it finds one; the message carries the detail instead
			throw new APICallError({
				// an AggregateError from trying every address of a host (Node's autoSelectFamily) has an
				// empty message once all attempts fail, so fall back to the code
				message: cause.message || String(cause.code),
				url: String(input),
				requestBodyValues: {},
				isRetryable: false
			});
		}
	};
}

/**
 * Output limit, sampling and thinking per request: the profile's `params` and `max_tokens` win, the model catalog fills the
 * rest — for the role in `params.role` where the catalog has one.
 */
export function requestSettings(profile: SettingsProfile): RequestSettings {
	if (isCloud(profile.provider)) return cloudRequestSettings(profile, profile.provider);
	const entry = profile.model === null ? null : matchModel(profile.model);
	const role = MODEL_ROLES.find((r) => r === profile.params.role);
	const roleSettings = role && entry?.roleSettings?.[role as ModelRole];
	const thinking =
		booleanParam(profile.params.thinking) ?? roleSettings?.thinking ?? catalogThinking(entry);
	const body: JsonBody = { ...catalogSampling(entry, thinking), ...samplingParams(profile.params) };
	if (thinking !== undefined) body.chat_template_kwargs = { enable_thinking: thinking };
	const maxOutputTokens =
		profile.max_tokens ?? roleSettings?.maxTokensMinimum ?? entry?.maxTokensMinimum;
	return { maxOutputTokens, providerOptions: { [PROVIDER_NAME]: body } };
}

/** Thinking on or off picks the catalog's effort for the model; a model the catalog does not know gets the provider's defaults. */
function cloudRequestSettings(profile: SettingsProfile, provider: CloudProvider): RequestSettings {
	const entry = cloudModel(provider, profile.model);
	const thinkingOff = booleanParam(profile.params.thinking) === false;
	const effort = entry && (thinkingOff ? entry.effort.off : entry.effort.on);
	const options = provider === 'anthropic' ? anthropicThinking(effort) : openAIReasoning(effort);
	return {
		maxOutputTokens: profile.max_tokens ?? entry?.maxOutputTokens,
		providerOptions: { [provider]: options }
	};
}

type CatalogEffort = Effort | 'disabled' | null;

// a summary, because with the default display the model thinks silently for minutes and the run shows no phase
function anthropicThinking(effort: CatalogEffort): Record<string, JSONValue> {
	if (!effort) return {};
	if (effort === 'disabled') return { thinking: { type: 'disabled' } };
	return { thinking: { type: 'adaptive', display: 'summarized' }, effort };
}

// store: false keeps tickets out of the provider's stored responses; the SDK then carries reasoning between steps encrypted
function openAIReasoning(effort: CatalogEffort): Record<string, JSONValue> {
	if (!effort) return { store: false };
	if (effort === 'none' || effort === 'disabled') return { store: false, reasoningEffort: 'none' };
	return { store: false, reasoningEffort: effort, reasoningSummary: 'auto' };
}

export type StepCost = { cost: number; priced: boolean };

/** Local models cost nothing; a cloud model costs its catalog price, or counts as 0 and unpriced when the catalog has none. */
export function stepCostFor(
	profile: Pick<Profile, 'provider' | 'model'>
): (tokens: Parameters<typeof stepCost>[1]) => StepCost {
	const pricing = cloudModel(profile.provider, profile.model)?.pricing;
	if (pricing) return (tokens) => ({ cost: stepCost(pricing, tokens), priced: true });
	const priced = !isCloud(profile.provider);
	return () => ({ cost: 0, priced });
}

const booleanParam = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

/** Only models that switch thinking through the chat template get the switch; the others think as they are built to. */
function catalogThinking(entry: ModelEntry | null) {
	if (entry?.thinking.method !== 'chat_template_kwargs') return undefined;
	return entry.thinking.enabled ?? undefined;
}

function catalogSampling(entry: ModelEntry | null, thinking: boolean | undefined): JsonBody {
	const sampling: SamplingParams | undefined =
		thinking === false ? entry?.sampling?.thinkingOff : entry?.sampling?.thinkingOn;
	if (!sampling) return {};
	const body = {
		temperature: sampling.temperature,
		top_p: sampling.topP,
		top_k: sampling.topK,
		min_p: sampling.minP,
		presence_penalty: sampling.presencePenalty
	};
	return Object.fromEntries(
		Object.entries(body).filter(([, value]) => value !== undefined)
	) as JsonBody;
}

function samplingParams(params: Record<string, unknown>): JsonBody {
	return Object.fromEntries(
		SAMPLING_PARAMS.filter((name) => typeof params[name] === 'number').map((name) => [
			name,
			params[name] as number
		])
	);
}
