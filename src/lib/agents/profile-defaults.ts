// What the profile form suggests and warns about, derived from the model catalog. Texts are German UI copy.
import {
	CLOUD_MODELS,
	cloudModel,
	matchModel,
	MODEL_ROLES,
	RUNTIME_ENDPOINTS,
	type ModelEntry,
	type ModelRole,
	type RoleLevel
} from './model-catalog';

export const PROVIDERS = [
	{
		id: 'openai-compatible',
		label: 'OpenAI-kompatibel (llama-swap, llama.cpp, Ollama, LM Studio)'
	},
	{ id: 'openai', label: 'OpenAI' },
	{ id: 'anthropic', label: 'Anthropic' }
] as const;
export type ProviderId = (typeof PROVIDERS)[number]['id'];

export const POOL_LABELS: Record<string, string> = { local: 'lokal', cloud: 'online' };

export const BASE_URL_EXAMPLE = 'http://127.0.0.1:8080/v1';
export const DEFAULT_PORTS = RUNTIME_ENDPOINTS.filter((runtime) => runtime.defaultPort)
	.map((runtime) => `${runtime.server} ${runtime.defaultPort}`)
	.join(' · ');

/** The form as the browser edits it: every value is the text of its field. */
export type ProfileValues = {
	name: string;
	provider: ProviderId;
	base_url: string;
	model: string;
	api_key_ref: string;
	pool: string;
	role: '' | ModelRole;
	thinking: '' | 'on' | 'off';
	max_tokens: string;
	prompt_variant: '' | 'compact' | 'full';
	temperature: string;
	max_steps: string;
	extra_prompt: string;
};

export const NEW_PROFILE: ProfileValues = {
	name: '',
	provider: 'openai-compatible',
	base_url: '',
	model: '',
	api_key_ref: '',
	pool: 'local',
	role: '',
	thinking: '',
	max_tokens: '',
	prompt_variant: '',
	temperature: '',
	max_steps: '',
	extra_prompt: ''
};

/** Whether a profile's provider is a local, OpenAI-compatible server rather than a cloud API. */
export const isLocalProvider = (provider: string | null) => provider === 'openai-compatible';

/** The runner limits parallel runs per pool, and an OpenAI-compatible server usually runs on the local GPU. */
export const defaultPool = (provider: string) => (isLocalProvider(provider) ? 'local' : 'cloud');

const CLOUD_PROVIDERS: readonly string[] = ['openai', 'anthropic'];

/** A cloud model without a price in the catalog counts as 0 in the run's cost, which the profile page says. */
export function pricingNotice(provider: string | null, model: string | null): string | null {
	if (!provider || !CLOUD_PROVIDERS.includes(provider) || !model) return null;
	if (cloudModel(provider, model)) return null;
	return 'Kein Preis im Katalog — Kosten dieses Profils zählen als 0, keine Denk-Zusammenfassung.';
}

export type CloudModelOption = { id: string; label: string };

/** The catalog's cloud models for this provider, with their price per 1M tokens, for the model field's datalist. */
export function cloudModelOptions(provider: string | null): readonly CloudModelOption[] {
	if (!provider || !CLOUD_PROVIDERS.includes(provider)) return [];
	return CLOUD_MODELS.filter((entry) => entry.provider === provider).map((entry) => ({
		id: entry.id,
		label: `${entry.pricing.inputPerMTok} $ / ${entry.pricing.outputPerMTok} $ pro 1M Tokens (Eingabe/Ausgabe)`
	}));
}

export type CatalogDefaults = {
	id: string;
	role?: ModelRole;
	/** Unset for models whose thinking cannot be switched. */
	thinking?: boolean;
	maxTokens?: number;
	promptVariant: 'compact';
	reasons: { role: string; thinking: string; maxTokens: string; promptVariant: string };
};

const LEVELS: Record<RoleLevel, string> = {
	recommended: 'empfohlen',
	acceptable: 'geeignet',
	'not-recommended': 'nicht empfohlen'
};
const COMPACT_REASON =
	'Der kompakte Basisprompt spart Tokens: kleine lokale Modelle haben wenig Kontext, so bleibt mehr Platz für Ticket und Notes.';

/** The catalog's settings for a known model, for the given role or else the recommended one. */
export function catalogDefaults(model: string, role?: ModelRole): CatalogDefaults | null {
	const entry = matchModel(model);
	if (!entry) return null;
	const chosen = role ?? recommendedRole(entry);
	const settings = settingsFor(entry, chosen);
	return {
		id: entry.id,
		role: chosen,
		thinking: entry.thinking.method === 'chat_template_kwargs' ? settings.thinking : undefined,
		maxTokens: settings.maxTokensMinimum,
		promptVariant: 'compact',
		reasons: {
			role: chosen
				? `${chosen} ${LEVELS[entry.roles[chosen]]}: ${entry.roleReason[chosen]}`
				: `Für keine Rolle empfohlen: ${entry.roleReason.refine}`,
			thinking: thinkingReason(entry, chosen),
			maxTokens: maxTokensReason(entry, settings.maxTokensMinimum),
			promptVariant: COMPACT_REASON
		}
	};
}

/** Fills the catalog defaults into the form; the values stay ordinary field values the human can change. */
export function withCatalogDefaults(values: ProfileValues): ProfileValues {
	const defaults = catalogDefaults(values.model);
	if (!defaults) return values;
	return {
		...values,
		role: defaults.role ?? '',
		thinking: defaults.thinking === undefined ? '' : defaults.thinking ? 'on' : 'off',
		max_tokens: defaults.maxTokens ? `${defaults.maxTokens}` : '',
		prompt_variant: defaults.promptVariant
	};
}

export function thinkingBudgetWarning(values: ProfileValues): string | null {
	const entry = matchModel(values.model);
	const maxTokens = Number.parseInt(values.max_tokens, 10);
	if (!entry || Number.isNaN(maxTokens)) return null;
	const { thinking, maxTokensMinimum } = settingsFor(entry, values.role || undefined);
	const thinkingOn = values.thinking === '' ? thinking : values.thinking === 'on';
	if (!thinkingOn || !maxTokensMinimum || maxTokens >= maxTokensMinimum) return null;
	const switchable = entry.thinking.method === 'chat_template_kwargs';
	return `Das Denken verbraucht das Budget, es kommt keine Antwort. Ausweg: max_tokens auf mindestens ${maxTokensMinimum} erhöhen${switchable ? ' oder Thinking aus' : ''}.`;
}

const PROMPT_TOKENS_WARNING = 300;
const CHARS_PER_TOKEN = 4;

export function extraPromptWarning(text: string): string | null {
	const tokens = Math.ceil(text.length / CHARS_PER_TOKEN);
	if (tokens <= PROMPT_TOKENS_WARNING) return null;
	return `Der Override hat etwa ${tokens} Tokens (über ${PROMPT_TOKENS_WARNING}) und kostet in jedem Schritt Prompt-Budget, bei kleinen lokalen Modellen spürbar. Ausweg: kürzen; was für alle Agents einer Spalte gilt, gehört in deren Rollen-Prompt.`;
}

const recommendedRole = (entry: ModelEntry) =>
	MODEL_ROLES.find((role) => entry.roles[role] === 'recommended') ??
	MODEL_ROLES.find((role) => entry.roles[role] === 'acceptable');

/** Role-specific settings where the catalog has them, else the model's own. */
function settingsFor(entry: ModelEntry, role: ModelRole | undefined) {
	const forRole = role && entry.roleSettings?.[role];
	return {
		thinking: forRole ? forRole.thinking : (entry.thinking.enabled ?? undefined),
		maxTokensMinimum: forRole ? forRole.maxTokensMinimum : entry.maxTokensMinimum
	};
}

function thinkingReason(entry: ModelEntry, role: ModelRole | undefined) {
	const { method, enabled } = entry.thinking;
	if (method === 'fixed')
		return `Bei diesem Modell ist Thinking fest eingebaut (${enabled ? 'an' : 'aus'}), der Schalter wirkt nicht.`;
	if (method === 'model-specific')
		return 'Dieses Modell schaltet Thinking auf eigene Weise, der Schalter wirkt nicht.';
	return pitfallAbout(entry, /thinking/) ?? entry.roleReason[role ?? 'refine'];
}

function maxTokensReason(entry: ModelEntry, minimum: number | undefined) {
	if (!minimum) return 'Der Katalog nennt kein Minimum; leer nimmt den Default des Servers.';
	return (
		pitfallAbout(entry, /max_tokens|budget/) ??
		`Mindestens ${minimum}: darunter bricht die Antwort mit finish_reason length ab.`
	);
}

function pitfallAbout(entry: ModelEntry, topic: RegExp) {
	const pitfall = entry.pitfalls.find(({ problem, fix }) => topic.test(problem) || topic.test(fix));
	return pitfall && `${pitfall.problem} → ${pitfall.fix}`;
}
