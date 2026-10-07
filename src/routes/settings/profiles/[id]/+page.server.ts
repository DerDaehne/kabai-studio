import { error, fail, redirect } from '@sveltejs/kit';
import { MODEL_ROLES } from '$lib/agents/model-catalog';
import {
	defaultPool,
	NEW_PROFILE,
	PROVIDERS,
	type ProfileValues,
	type ProviderId
} from '$lib/agents/profile-defaults';
import { db } from '$lib/server/db';
import { domainFail } from '$lib/server/domain-failure';
import { isDomainError } from '$lib/server/domain/error';
import { createProfile, getProfile, updateProfile, type Profile } from '$lib/server/domain/runs';
import { DEFAULT_MAX_STEPS } from '$lib/server/executors/builtin';
import { listModels } from '$lib/server/model-list';
import { LIMITS } from '$lib/server/runner';
import { listSecrets, setSecret } from '$lib/server/secrets';
import type { Actions, PageServerLoad } from './$types';

const USER = { kind: 'user' } as const;
/** The form field that a domain error concerns. */
const FIELD_OF: Record<string, keyof ProfileValues> = {
	name_taken: 'name',
	missing_field: 'model',
	invalid_secret_ref: 'api_key_ref'
};
type FieldError = { field: string; message: string };
type ProfileInput = Partial<Profile> & Pick<Profile, 'name' | 'executor'>;

// The API key itself never appears here: the profile holds a reference, the secret field sends the value only once.
export const load: PageServerLoad = ({ params }) => ({
	id: params.id,
	values: params.id === 'new' ? NEW_PROFILE : valuesOf(storedProfile(params.id)),
	secretNames: listSecrets(db()).map((secret) => secret.name),
	defaultMaxSteps: DEFAULT_MAX_STEPS,
	poolLimits: LIMITS.pools
});

export const actions: Actions = {
	save: async ({ request, params }) => {
		const stored = params.id === 'new' ? null : storedProfile(params.id);
		const input = profileFrom(await request.formData(), stored?.params ?? {});
		if ('field' in input) return fail(400, input);
		try {
			if (stored) updateProfile(db(), USER, stored.id, input);
			else createProfile(db(), USER, input);
		} catch (err) {
			return domainFail(err, (e) => ({
				field: FIELD_OF[e.code] ?? '',
				message: wayOut(e.message, e.hint)
			}));
		}
		redirect(303, '/settings/profiles');
	},
	models: async ({ request }) => {
		const form = await request.formData();
		const apiKeyRef = String(form.get('api_key_ref') ?? '').trim();
		return listModels(db(), {
			baseUrl: String(form.get('base_url') ?? ''),
			apiKeyRef: apiKeyRef || null
		});
	},
	setSecret: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '');
		try {
			setSecret(db(), name, String(form.get('value') ?? ''));
		} catch (err) {
			return domainFail(err, (e) => ({
				secretError: { code: e.code, message: e.message, hint: e.hint }
			}));
		}
		return { savedSecret: name };
	}
};

const wayOut = (message: string, hint: string) => `${message} Ausweg: ${hint}`;

function storedProfile(id: string) {
	try {
		const profile = getProfile(db(), Number(id));
		if (profile.executor === 'builtin') return profile;
	} catch (err) {
		if (!isDomainError(err)) throw err;
	}
	error(
		404,
		'Dieses builtin-Profil gibt es nicht. Die Liste unter Einstellungen → Agent-Profile zeigt alle.'
	);
}

function valuesOf(profile: Profile): ProfileValues {
	const { params } = profile;
	return {
		name: profile.name,
		provider: (profile.provider ?? 'openai-compatible') as ProviderId,
		base_url: profile.base_url ?? '',
		model: profile.model ?? '',
		api_key_ref: profile.api_key_ref ?? '',
		pool: profile.pool,
		role: MODEL_ROLES.find((role) => role === params.role) ?? '',
		thinking: params.thinking === true ? 'on' : params.thinking === false ? 'off' : '',
		max_tokens: `${profile.max_tokens ?? ''}`,
		prompt_variant:
			params.prompt_variant === 'compact' || params.prompt_variant === 'full'
				? params.prompt_variant
				: '',
		temperature: `${params.temperature ?? ''}`,
		max_steps: `${profile.max_steps ?? ''}`,
		extra_prompt: profile.extra_prompt
	};
}

function profileFrom(form: FormData, previousParams: Profile['params']): ProfileInput | FieldError {
	const text = (field: string) => String(form.get(field) ?? '').trim();
	const provider = PROVIDERS.find(({ id }) => id === text('provider'))?.id;
	if (!provider)
		return {
			field: 'provider',
			message: wayOut('Diesen Provider gibt es nicht.', 'einen aus der Liste wählen.')
		};
	if (!text('name'))
		return {
			field: 'name',
			message: wayOut('Der Name fehlt.', 'einen Namen wie „Lokal schnell“ eintragen.')
		};
	const numbers = numbersFrom(text);
	if ('field' in numbers) return numbers;
	return {
		name: text('name'),
		executor: 'builtin',
		provider,
		base_url: provider === 'openai-compatible' ? text('base_url') || null : null,
		model: text('model') || null,
		api_key_ref: text('api_key_ref') || null,
		pool: text('pool') || defaultPool(provider),
		max_steps: numbers.max_steps,
		max_tokens: numbers.max_tokens,
		params: paramsFrom(text, previousParams, numbers.temperature),
		extra_prompt: text('extra_prompt')
	};
}

function numbersFrom(text: (field: string) => string) {
	const positive = (value: string) =>
		value === '' ? null : /^\d+$/.test(value) && +value > 0 ? +value : NaN;
	const max_steps = positive(text('max_steps'));
	const max_tokens = positive(text('max_tokens'));
	const raw = text('temperature');
	const temperature = raw === '' ? undefined : +raw >= 0 && +raw <= 2 ? +raw : NaN;
	const invalid = (field: string, rule: string): FieldError => ({
		field,
		message: wayOut(
			`${field} muss ${rule} sein.`,
			'korrigieren oder leer lassen, dann gilt der Default.'
		)
	});
	if (Number.isNaN(max_steps)) return invalid('max_steps', 'eine ganze Zahl über 0');
	if (Number.isNaN(max_tokens)) return invalid('max_tokens', 'eine ganze Zahl über 0');
	if (Number.isNaN(temperature)) return invalid('temperature', 'eine Zahl von 0 bis 2');
	return { max_steps, max_tokens, temperature };
}

/** Sets the parameters this form manages and keeps all others, e.g. sampling values set elsewhere. */
function paramsFrom(
	text: (field: string) => string,
	previous: Profile['params'],
	temperature?: number
) {
	const params = { ...previous };
	const set = (key: string, value: unknown) => {
		if (value === undefined) delete params[key];
		else params[key] = value;
	};
	set(
		'role',
		MODEL_ROLES.find((role) => role === text('role'))
	);
	set('thinking', ({ on: true, off: false } as Record<string, boolean>)[text('thinking')]);
	set(
		'prompt_variant',
		['compact', 'full'].find((variant) => variant === text('prompt_variant'))
	);
	set('temperature', temperature);
	return params;
}
