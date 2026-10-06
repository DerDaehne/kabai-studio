import type { DatabaseSync } from 'node:sqlite';
import { MODEL_LIST_PATH } from '../agents/model-catalog';
import { BASE_URL_EXAMPLE } from '../agents/profile-defaults';
import { DomainError } from './domain/core';
import { checkKeyRef } from './domain/runs';
import { providerErrorHint } from './provider-error';
import { resolveRef } from './secrets';

export const MODEL_LIST_TIMEOUT_MS = 5000;

/** Model ids sorted by name, or one line of plain text that ends with a way out. */
export type ModelList = { models: string[] } | { modelError: string };
export type ModelEndpoint = { baseUrl: string; apiKeyRef: string | null };

const CHECK_ADDRESS = `Adresse prüfen, gemeint ist der OpenAI-kompatible Endpunkt, z. B. ${BASE_URL_EXAMPLE}.`;

const failure = (message: string, wayOut: string): ModelList => ({
	modelError: `${message} Ausweg: ${wayOut}`
});

/** Asks the endpoint for its models on the server, so the key never reaches the browser. */
export async function listModels(
	db: DatabaseSync,
	endpoint: ModelEndpoint,
	{ fetch = globalThis.fetch, timeoutMs = MODEL_LIST_TIMEOUT_MS } = {}
): Promise<ModelList> {
	const url = modelListUrl(endpoint.baseUrl);
	if (!url)
		return failure(
			'Die Adresse ist keine http(s)-Adresse.',
			`z. B. ${BASE_URL_EXAMPLE} eintragen.`
		);
	try {
		const headers = authorization(db, endpoint.apiKeyRef);
		const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
		return readModels(response, endpoint.apiKeyRef !== null);
	} catch (err) {
		return requestFailure(err, url, timeoutMs);
	}
}

/** Accepts the base URL with or without the trailing /v1 that OpenAI-compatible clients expect. */
function modelListUrl(baseUrl: string) {
	const root = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
	const url = URL.parse(root + MODEL_LIST_PATH);
	return url && (url.protocol === 'http:' || url.protocol === 'https:') ? url : null;
}

function authorization(db: DatabaseSync, apiKeyRef: string | null): Record<string, string> {
	if (apiKeyRef === null) return {};
	checkKeyRef(apiKeyRef); // a pasted key is neither sent nor resolved
	return { authorization: `Bearer ${resolveRef(db, apiKeyRef)}` };
}

async function readModels(response: Response, withKey: boolean): Promise<ModelList> {
	const status = `HTTP ${response.status}`;
	if ((response.status === 401 || response.status === 403) && withKey)
		return failure(
			`Der Endpunkt lehnt den API-Key ab (${status}).`,
			providerErrorHint('provider_auth', { withKey: true })
		);
	if (response.status === 401 || response.status === 403)
		return failure(
			`Der Endpunkt verlangt einen API-Key (${status}).`,
			providerErrorHint('provider_auth')
		);
	if (!response.ok) return failure(`Der Endpunkt antwortet mit ${status}.`, CHECK_ADDRESS);
	const ids = modelIds(await response.text());
	if (!ids) return failure('Die Antwort ist keine Modellliste.', CHECK_ADDRESS);
	if (!ids.length)
		return failure(
			'Der Endpunkt meldet keine Modelle.',
			'Modell auf dem Server bereitstellen oder den Namen frei eingeben.'
		);
	return { models: ids.sort() };
}

function modelIds(text: string): string[] | null {
	try {
		const { data } = JSON.parse(text) as { data?: { id?: unknown }[] };
		if (!Array.isArray(data) || !data.every((model) => typeof model?.id === 'string')) return null;
		return data.map((model) => model.id as string);
	} catch {
		return null;
	}
}

function requestFailure(err: unknown, url: URL, timeoutMs: number): ModelList {
	if (err instanceof DomainError) return failure(err.message, err.hint);
	if (err instanceof Error && err.name === 'TimeoutError')
		return failure(
			`Keine Antwort innerhalb von ${(timeoutMs / 1000).toLocaleString('de-DE')} s.`,
			'Läuft der Server unter dieser Adresse? Lädt er gerade ein Modell, gleich erneut laden.'
		);
	return failure(
		`Endpunkt ${url.origin} nicht erreichbar.`,
		providerErrorHint('provider_unreachable')
	);
}
