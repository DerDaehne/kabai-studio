// Local-model recommendations and parameters as data — one source for onboarding, profiles, the runner and the README.

export type ModelRole = 'refine' | 'review' | 'code' | 'tour';
export type RoleLevel = 'recommended' | 'acceptable' | 'not-recommended';

export const MODEL_ROLES: readonly ModelRole[] = ['refine', 'review', 'code', 'tour'];

export interface ThinkingConfig {
	readonly enabled: boolean | null;
	readonly method: 'chat_template_kwargs' | 'model-specific' | 'fixed';
}

export interface SamplingParams {
	readonly temperature: number;
	readonly topP: number;
	readonly topK: number;
	readonly minP?: number;
	readonly presencePenalty?: number;
}

export interface RoleSettings {
	readonly thinking: boolean;
	readonly maxTokensMinimum: number;
}

export interface Pitfall {
	readonly problem: string;
	readonly fix: string;
}

export interface EvaluationSource {
	readonly basis: 'maintainer evaluation';
	readonly date: string;
}

export interface ModelCardSource {
	readonly basis: 'model card';
	readonly url: string;
}

export type CatalogSource = EvaluationSource | ModelCardSource;

export interface SamplingProfile {
	readonly thinkingOn?: SamplingParams;
	readonly thinkingOff?: SamplingParams;
	readonly source: CatalogSource;
}

export interface ServerHints {
	readonly llamaCpp: readonly string[];
	readonly ollama: readonly string[];
}

export interface ModelEntry {
	readonly id: string;
	readonly names: readonly string[];
	readonly family: string;
	readonly moe: boolean;
	readonly roles: Readonly<Record<ModelRole, RoleLevel>>;
	readonly roleReason: Readonly<Record<ModelRole, string>>;
	readonly thinking: ThinkingConfig;
	readonly maxTokensMinimum?: number;
	readonly contextMinimum?: number;
	/** The context size Studio plans prompts and fresh runs with, in tokens; without one it plans with `contextMinimum`. */
	readonly contextBudget?: number;
	readonly quantization?: string;
	readonly serverHints: ServerHints;
	readonly pitfalls: readonly Pitfall[];
	readonly sampling?: SamplingProfile;
	// Per-role override of `thinking`/`maxTokensMinimum`, for models whose recommended setting
	// genuinely differs by role (e.g. thinking on only for code). Roles without an entry here use
	// the top-level `thinking`/`maxTokensMinimum` as a fallback.
	readonly roleSettings?: Readonly<Partial<Record<ModelRole, RoleSettings>>>;
	readonly source: CatalogSource;
}

const EVALUATED: EvaluationSource = { basis: 'maintainer evaluation', date: '2026-09-29' };

// Studio's own floor: enough context for a ticket, its tasks, linked notes and the role prompt.
const STUDIO_CONTEXT_MINIMUM = 32768;

export const MODELS = [
	{
		id: 'ornith-1.5-35b',
		names: ['ornith-1.5-35b', 'Ornith-1.5-35B-A3B-GGUF:Q8_0'],
		family: 'ornith-1.5',
		moe: true,
		roles: { refine: 'recommended', review: 'not-recommended', code: 'recommended', tour: 'not-recommended' },
		roleReason: {
			refine: 'the strongest refinement quality in evaluation runs: recognizes open decisions and architecture conflicts',
			review: 'not evaluated for the review role',
			code: 'passed all hidden tests on small, well-scoped code tickets with thinking enabled',
			tour: 'not evaluated for tour/triage; only run with thinking enabled, which is slower than the dedicated tour profile'
		},
		thinking: { enabled: true, method: 'chat_template_kwargs' },
		maxTokensMinimum: 32000,
		contextMinimum: STUDIO_CONTEXT_MINIMUM,
		serverHints: { llamaCpp: ['--jinja', '-fa on', '-cmoe', '-c 131072'], ollama: ['num_ctx 32768'] },
		pitfalls: [
			{
				problem: 'without thinking enabled it often asks a clarifying question before doing any work',
				fix: 'enable thinking'
			},
			{
				problem: 'with a small token budget (around 12k) thinking consumes it all and no answer is produced',
				fix: 'raise max_tokens to at least 32000, or disable thinking'
			},
			{
				problem: "the model's own test expectations are sometimes wrong",
				fix: 'always verify test results independently'
			}
		],
		sampling: {
			// huggingface.co/ornith-ai/Ornith-1.5-35B-A3B: "general tasks" preset. The card documents
			// no separate non-thinking mode (it's a reasoning model that thinks by default), so
			// thinkingOff stays unset rather than guessing.
			thinkingOn: { temperature: 0.6, topP: 0.95, topK: 20 },
			source: { basis: 'model card', url: 'https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B' }
		},
		source: EVALUATED
	},
	{
		id: 'qwen3.6-35b',
		names: ['qwen3.6-35b', 'Qwen3.6-35B-A3B'],
		family: 'qwen3.6',
		moe: true,
		roles: { refine: 'acceptable', review: 'not-recommended', code: 'recommended', tour: 'recommended' },
		roleReason: {
			refine: 'fast and reliable in the tool loop, but with thinking off it can silently skip open product decisions instead of asking',
			review: 'not evaluated for the review role',
			code: 'passed all hidden tests on small, well-scoped code tickets with thinking enabled',
			tour: 'very reliable in the tool loop and fast with thinking off'
		},
		thinking: { enabled: null, method: 'chat_template_kwargs' },
		maxTokensMinimum: 16000,
		// huggingface.co/Qwen/Qwen3.6-35B-A3B: "we advise maintaining a context length of at least
		// 128K tokens to preserve thinking capabilities" — above Studio's own floor.
		contextMinimum: 131072,
		serverHints: { llamaCpp: ['--jinja', '-fa on', '-cmoe', '-c 131072'], ollama: ['num_ctx 131072'] },
		pitfalls: [
			{
				problem: 'never asks clarifying questions; open product decisions are silently skipped',
				fix: 'have a reviewer check for skipped decisions, or use it only for tasks without open decisions'
			},
			{
				problem: "the model's own test expectations are sometimes wrong",
				fix: 'always verify test results independently'
			}
		],
		sampling: {
			// huggingface.co/Qwen/Qwen3.6-35B-A3B lists three presets: thinking/general, thinking/precise
			// coding, and non-thinking. Studio only enables thinking for the code role, so thinkingOn
			// uses the coding preset rather than the general one.
			thinkingOn: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0 },
			thinkingOff: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5 },
			source: { basis: 'model card', url: 'https://huggingface.co/Qwen/Qwen3.6-35B-A3B' }
		},
		// Thinking and max_tokens genuinely differ by role for this model: off and lower for
		// tour/refine-tempo use, on and higher for code.
		roleSettings: {
			refine: { thinking: false, maxTokensMinimum: 8000 },
			code: { thinking: true, maxTokensMinimum: 16000 },
			tour: { thinking: false, maxTokensMinimum: 8000 }
		},
		source: EVALUATED
	},
	{
		id: 'qwen3-coder-next',
		names: ['qwen3-coder-next'],
		family: 'qwen3-coder-next',
		moe: true,
		roles: { refine: 'not-recommended', review: 'not-recommended', code: 'not-recommended', tour: 'acceptable' },
		roleReason: {
			refine: 'not evaluated for refine; splits tasks too finely and has no thinking mode to weigh tradeoffs',
			review: 'not evaluated for the review role',
			code: 'weaker code quality in evaluation runs, and splits tasks too finely for the tool-loop step limit',
			tour: 'tool loop works reliably, though it tends to over-decompose tasks'
		},
		thinking: { enabled: false, method: 'fixed' },
		contextMinimum: STUDIO_CONTEXT_MINIMUM,
		serverHints: { llamaCpp: ['--jinja', '-fa on', '-cmoe', '-c 131072'], ollama: ['num_ctx 32768'] },
		pitfalls: [
			{
				problem: 'weaker code quality in evaluation runs, and splits tasks too finely',
				fix: 'raise the tool-loop step limit, or prefer another model for code tickets'
			}
		],
		source: EVALUATED
	},
	{
		id: 'gpt-oss-20b',
		names: ['gpt-oss-20b', 'gpt-oss:20b'],
		family: 'gpt-oss',
		moe: true,
		roles: { refine: 'not-recommended', review: 'not-recommended', code: 'acceptable', tour: 'not-recommended' },
		roleReason: {
			refine: 'weak refinement quality and mixes languages in its output',
			review: 'not evaluated for the review role; the same weak refinement quality is a poor fit',
			code: 'fast with correct code on small auxiliary tasks, but not checked as rigorously as ornith-1.5-35b or qwen3.6-35b for code tickets',
			tour: 'not evaluated for tour/triage'
		},
		thinking: { enabled: true, method: 'fixed' },
		maxTokensMinimum: 8000,
		contextMinimum: STUDIO_CONTEXT_MINIMUM,
		// No -cmoe here: that VRAM/RAM tradeoff applies to the A3B-branded MoE models, not this one.
		serverHints: { llamaCpp: ['--jinja', '-fa on', '-c 65536'], ollama: ['num_ctx 32768'] },
		pitfalls: [
			{
				problem: 'weak refinement quality and mixes languages in its output',
				fix: 'use only for small, well-scoped auxiliary tasks, not for refine or review'
			}
		],
		source: EVALUATED
	},
	{
		id: 'qwen3.8-27b',
		names: ['qwen3.8-27b'],
		family: 'qwen3.8',
		moe: false,
		roles: { refine: 'not-recommended', review: 'not-recommended', code: 'not-recommended', tour: 'not-recommended' },
		roleReason: {
			refine: 'too slow once it no longer fits fully in VRAM; prefer an MoE model of similar size',
			review: 'not evaluated for the review role; the same VRAM/speed problem applies to every role',
			code: 'too slow once it no longer fits fully in VRAM; prefer an MoE model of similar size',
			tour: 'too slow for a time-boxed tour/triage role'
		},
		thinking: { enabled: null, method: 'chat_template_kwargs' },
		serverHints: { llamaCpp: ['--jinja'], ollama: [] },
		pitfalls: [
			{
				problem: 'too slow once it no longer fits fully in VRAM (dense model, no MoE expert offloading)',
				fix: 'prefer an MoE model of similar size, e.g. ornith-1.5-35b or qwen3.6-35b'
			}
		],
		source: EVALUATED
	}
] as const satisfies readonly ModelEntry[];

// Splits on `= - _ : /` and whitespace, and on '.' — except between two digits, so a version
// number like "1.5" stays one token instead of colliding with "5.1" as the same token set.
const NAME_SEPARATORS = /[=\-_:/\s]+|\.(?!\d)|(?<!\d)\./;

function tokenize(name: string): string[] {
	return name.toLowerCase().split(NAME_SEPARATORS).filter(Boolean);
}

function canonicalTokens(entry: Pick<ModelEntry, 'names'>): string[] {
	return entry.names.map(tokenize).reduce((shortest, tokens) => (tokens.length < shortest.length ? tokens : shortest));
}

/**
 * Resolves a free-form model name (Ollama tag, GGUF/HF name incl. `publisher/repo`, or llama-swap
 * alias) to its catalog entry. Matches when the tokens of the entry's shortest `names` variant are
 * a subset of the query's tokens; returns `null` when no entry matches uniquely, including a
 * family-only query or a query that subset-matches more than one entry.
 */
export function matchModel(query: string, catalog: readonly ModelEntry[] = MODELS): ModelEntry | null {
	const queryTokens = new Set(tokenize(query));
	const matches = catalog.filter((entry) => canonicalTokens(entry).every((token) => queryTokens.has(token)));
	return matches.length === 1 ? matches[0] : null;
}

/** The context size in tokens that prompts for this profile's model are planned with. */
export function contextBudget(profile: { model: string | null }, catalog: readonly ModelEntry[] = MODELS): number {
	const entry = profile.model === null ? null : matchModel(profile.model, catalog);
	return entry?.contextBudget ?? entry?.contextMinimum ?? STUDIO_CONTEXT_MINIMUM;
}

export interface RuntimeEndpoint {
	readonly id: 'ollama' | 'lm-studio' | 'llama-cpp' | 'openai-compatible';
	readonly server: string;
	readonly defaultPort: number | null;
	readonly contextQuery?: string;
}

export const MODEL_LIST_PATH = '/v1/models';

export const RUNTIME_ENDPOINTS: readonly RuntimeEndpoint[] = [
	{ id: 'ollama', server: 'Ollama', defaultPort: 11434, contextQuery: 'POST /api/show' },
	{ id: 'lm-studio', server: 'LM Studio', defaultPort: 1234 },
	{
		id: 'llama-cpp',
		server: 'llama.cpp (llama-server)',
		defaultPort: 8080,
		contextQuery: 'GET /props -> default_generation_settings.n_ctx'
	},
	{
		id: 'openai-compatible',
		server: 'llama-swap or another OpenAI-compatible server',
		defaultPort: null,
		contextQuery: 'GET /upstream/<model>/props -> default_generation_settings.n_ctx'
	}
];

export const COLD_START_HINTS: readonly string[] = [
	'A server started with -hf downloads the model from its Hugging Face repo on first use.',
	'A proxy such as llama-swap unloads an idle model after its configured ttl and reloads it on the next request.'
];

/**
 * How long a model may take to answer a run's first request: after `hintAfterMs` the run reports that the model is
 * loading, after `failAfterMs` it fails with `model_loading_timeout`.
 */
export interface ColdStartLimits {
	readonly hintAfterMs: number;
	readonly failAfterMs: number;
}

// The hint already shows during an ordinary reload after an idle unload; the limit leaves room for a one-time download of a large model.
export const COLD_START_LIMITS: ColdStartLimits = { hintAfterMs: 30_000, failAfterMs: 30 * 60_000 };
