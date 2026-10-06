import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, type LanguageModel } from 'ai';
import type { DatabaseSync } from 'node:sqlite';
import {
	matchModel,
	MODEL_ROLES,
	type ModelEntry,
	type ModelRole,
	type SamplingParams
} from '../../agents/model-catalog';
import { DomainError } from '../domain/core';
import type { Profile } from '../domain/runs';
import { resolveRef } from '../secrets';

/** The name under which `providerOptions` reach the request body unchanged. */
export const PROVIDER_NAME = 'studio';
const SAMPLING_PARAMS = ['temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty'] as const;

type ProviderProfile = Pick<Profile, 'provider' | 'base_url' | 'model' | 'api_key_ref'>;
type SettingsProfile = Pick<Profile, 'model' | 'params' | 'max_tokens'>;
type JsonBody = Record<string, number | { enable_thinking: boolean }>;
export type RequestSettings = {
	maxOutputTokens?: number;
	providerOptions: Record<string, JsonBody>;
};

/** The profile's model on its OpenAI-compatible endpoint; the API key comes from the secrets store and is masked from then on. */
export function modelFor(
	db: DatabaseSync,
	profile: ProviderProfile,
	fetch: typeof globalThis.fetch
): LanguageModel {
	if (profile.provider !== 'openai-compatible')
		throw new DomainError(
			'provider_unsupported',
			`Der builtin-Executor spricht noch kein „${profile.provider}“.`,
			'Wähle ein Profil mit dem Provider openai-compatible (z. B. llama.cpp, llama-swap, Ollama, LM Studio).'
		);
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
		fetch: failFastOnConnectionError(fetch)
	}).chatModel(profile.model);
}

/**
 * A connection that never comes through (server down, wrong port) fails the request at once instead of through the
 * AI SDK's own retry backoff: waiting a few more seconds never helps, the way out is starting the model server.
 */
function failFastOnConnectionError(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
	return async (input, init) => {
		try {
			return await fetch(input, init);
		} catch (err) {
			if (!(err instanceof TypeError)) throw err;
			// no `cause` here: the AI SDK's own retry wrapper walks the cause chain for a retryable network
			// error code (e.g. ECONNREFUSED) and overrides isRetryable to true once it finds one
			throw new APICallError({
				message: err.message,
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
