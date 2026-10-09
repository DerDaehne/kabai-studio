import { describe, expect, it } from 'vitest';
import {
	CLOUD_MODELS,
	cloudModel,
	contextBudget,
	MODEL_ROLES,
	MODELS,
	matchModel,
	reasoningBudget,
	stepCost,
	type ModelEntry
} from './model-catalog.ts';

const catalog: readonly ModelEntry[] = MODELS;

describe('matchModel', () => {
	it.each([
		['ornith=1.5-35b', 'ornith-1.5-35b'],
		['Ornith-1.5-35B-A3B-GGUF:Q8_0', 'ornith-1.5-35b'],
		['qwen3.6:35b', 'qwen3.6-35b'],
		['qwen3.6-35b-q8', 'qwen3.6-35b']
	])('resolves %s to %s', (query, id) => {
		expect(matchModel(query)?.id).toBe(id);
	});

	it.each([
		['Qwen/Qwen3.6-35B-A3B', 'qwen3.6-35b'],
		['qwen/qwen3.6-35b-a3b', 'qwen3.6-35b'],
		['openai/gpt-oss-20b', 'gpt-oss-20b'],
		['hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL', 'qwen3.6-35b']
	])('resolves the publisher/repo form %s to %s', (query, id) => {
		expect(matchModel(query)?.id).toBe(id);
	});

	it.each(['ornith-5.1-35b', 'Ornith-2.5-35B-A3B-GGUF:Q5_1'])(
		'does not let a different version number %s false-match ornith-1.5-35b',
		(query) => {
			expect(matchModel(query)).toBeNull();
		}
	);

	it('returns null when a query subset-matches more than one entry', () => {
		expect(matchModel('qwen3-coder-next-qwen3.6-35b')).toBeNull();
	});

	it('returns null when the query names only the family', () => {
		expect(matchModel('qwen3.6')).toBeNull();
		expect(matchModel('ornith')).toBeNull();
	});

	// qwen3-coder-next has no sibling size in the catalog, so its family name already is its
	// full, unambiguous identifier — every other entry's family name is a strict prefix of it.
	it.each(MODELS.filter((entry) => entry.id !== 'qwen3-coder-next'))(
		'returns null for $id when only its family ($family) is named',
		(entry) => {
			expect(matchModel(entry.family)).toBeNull();
		}
	);

	it('returns null for a model outside the catalog', () => {
		expect(matchModel('llama3-70b-instruct')).toBeNull();
	});
});

describe('MODELS', () => {
	const expectedIds = [
		'ornith-1.5-35b',
		'qwen3.6-35b',
		'qwen3-coder-next',
		'gpt-oss-20b',
		'qwen3.8-27b'
	];

	it('contains every evaluated model', () => {
		expect(MODELS.map((m) => m.id).sort()).toEqual([...expectedIds].sort());
	});

	it('marks qwen3.8-27b as not-recommended for every role', () => {
		const entry = MODELS.find((m) => m.id === 'qwen3.8-27b');
		expect(Object.values(entry?.roles ?? {})).toEqual([
			'not-recommended',
			'not-recommended',
			'not-recommended',
			'not-recommended'
		]);
	});

	it.each(MODELS)('gives $id a non-empty roleReason for every role', (entry) => {
		for (const role of MODEL_ROLES) {
			expect(entry.roleReason[role].trim().length).toBeGreaterThan(0);
		}
	});

	it.each(MODELS)('gives every pitfall of $id a non-empty fix', (entry) => {
		for (const pitfall of entry.pitfalls) {
			expect(pitfall.problem.trim().length).toBeGreaterThan(0);
			expect(pitfall.fix.trim().length).toBeGreaterThan(0);
		}
	});

	it('only sets sampling parameters that are backed by a model card', () => {
		const withSampling = catalog.filter((m) => m.sampling);
		expect(withSampling.map((m) => m.id).sort()).toEqual(['ornith-1.5-35b', 'qwen3.6-35b']);
		for (const entry of withSampling) {
			expect(entry.sampling?.source.basis).toBe('model card');
		}
	});

	it('leaves ornith-1.5-35b thinkingOff unset (no non-thinking preset on its model card)', () => {
		const ornith = catalog.find((m) => m.id === 'ornith-1.5-35b');
		expect(ornith?.sampling?.thinkingOff).toBeUndefined();
	});

	it('gives qwen3.6-35b the full model-card presets, including presence_penalty', () => {
		const qwen = catalog.find((m) => m.id === 'qwen3.6-35b');
		expect(qwen?.sampling?.thinkingOn).toEqual({
			temperature: 0.6,
			topP: 0.95,
			topK: 20,
			minP: 0,
			presencePenalty: 0
		});
		expect(qwen?.sampling?.thinkingOff).toEqual({
			temperature: 0.7,
			topP: 0.8,
			topK: 20,
			minP: 0,
			presencePenalty: 1.5
		});
	});

	it('gives qwen3.6-35b per-role thinking/max_tokens settings for the tour role', () => {
		const qwen = catalog.find((m) => m.id === 'qwen3.6-35b');
		expect(qwen?.roleSettings?.tour).toEqual({ thinking: false, maxTokensMinimum: 8000 });
		expect(qwen?.roleSettings?.code).toEqual({ thinking: true, maxTokensMinimum: 16000 });
	});

	it('enables thinking for qwen3.6-35b only in the code role, matching its coding sampling preset', () => {
		const qwen = catalog.find((m) => m.id === 'qwen3.6-35b');
		const thinkingRoles = Object.entries(qwen?.roleSettings ?? {})
			.filter(([, settings]) => settings.thinking)
			.map(([role]) => role);
		expect(thinkingRoles).toEqual(['code']);
	});

	it('sets contextMinimum to the Studio floor, not a server -c value, unless the model card asks for more', () => {
		expect(catalog.find((m) => m.id === 'ornith-1.5-35b')?.contextMinimum).toBe(32768);
		expect(catalog.find((m) => m.id === 'qwen3.6-35b')?.contextMinimum).toBe(131072);
	});

	it('does not read Q8_0 as a recommended quantization', () => {
		expect(catalog.find((m) => m.id === 'ornith-1.5-35b')?.quantization).toBeUndefined();
	});
});

describe('contextBudget', () => {
	it("plans with the model's contextMinimum while the catalog names no contextBudget", () => {
		expect(contextBudget({ model: 'qwen3.6-35b' })).toBe(131072);
		expect(contextBudget({ model: 'Ornith-1.5-35B-A3B-GGUF:Q8_0' })).toBe(32768);
	});

	it('prefers a contextBudget over the contextMinimum', () => {
		const measured: ModelEntry = { ...catalog[0], contextBudget: 65536 };
		expect(contextBudget({ model: catalog[0].id }, [measured])).toBe(65536);
	});

	it('falls back to 32k for an unknown model, a model without contextMinimum, or none at all', () => {
		expect(contextBudget({ model: 'some-unknown-model' })).toBe(32768);
		expect(contextBudget({ model: 'qwen3.8-27b' })).toBe(32768);
		expect(contextBudget({ model: null })).toBe(32768);
	});
});

describe('reasoningBudget', () => {
	it('gives ornith-1.5-35b the measured budget of 12,288 tokens, also under its server alias', () => {
		expect(reasoningBudget({ model: 'ornith-1.5-35b' })).toBe(12288);
		expect(reasoningBudget({ model: 'Ornith-1.5-35B-A3B-GGUF:Q8_0' })).toBe(12288);
	});

	it('knows no budget for a model without a measured one, an unknown model or none at all', () => {
		expect(reasoningBudget({ model: 'qwen3.6-35b' })).toBeUndefined();
		expect(reasoningBudget({ model: 'some-unknown-model' })).toBeUndefined();
		expect(reasoningBudget({ model: null })).toBeUndefined();
	});

	it.each(catalog)(
		'recommends --reasoning-budget and its message to llama.cpp exactly when $id has a budget',
		(entry) => {
			const flags = entry.serverHints.llamaCpp;
			const budgetFlags = flags.filter((flag) => flag.startsWith('--reasoning-budget '));
			const messages = flags.filter((flag) => /^--reasoning-budget-message ".+"$/.test(flag));
			if (entry.reasoningBudget === undefined) {
				expect([...budgetFlags, ...messages]).toEqual([]);
				return;
			}
			expect(budgetFlags).toEqual([`--reasoning-budget ${entry.reasoningBudget}`]);
			expect(messages).toHaveLength(1);
		}
	);

	it.each(catalog.filter((entry) => entry.reasoningBudget !== undefined))(
		'leaves room for the answer of $id below its output limit',
		(entry) => {
			expect(entry.reasoningBudget).toBeLessThan(entry.maxTokensMinimum ?? 0);
		}
	);
});

describe('cloud models', () => {
	it.each(CLOUD_MODELS)(
		'$id has a price per million tokens with its official source, the day it was checked and whether it is verified',
		({ provider, pricing }) => {
			const officialPage = provider === 'anthropic' ? 'platform.claude.com' : 'openai.com';
			expect(new URL(pricing.source).hostname).toContain(officialPage);
			expect(pricing.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(typeof pricing.verified).toBe('boolean');
			for (const rate of [pricing.inputPerMTok, pricing.cacheReadPerMTok, pricing.outputPerMTok])
				expect(rate).toBeGreaterThan(0);
		}
	);

	it('finds a cloud model only by its provider and exact id', () => {
		expect(cloudModel('anthropic', 'claude-sonnet-5')?.id).toBe('claude-sonnet-5');
		expect(cloudModel('openai', 'claude-sonnet-5')).toBeNull();
		expect(cloudModel('anthropic', 'claude-sonnet-5-preview')).toBeNull();
		expect(cloudModel('openai-compatible', 'gpt-6-sol')).toBeNull();
	});

	it('prices a step with fresh input, cache reads, cache writes and output at their own rates', () => {
		const { pricing } = cloudModel('openai', 'gpt-6-sol')!;
		const cost = stepCost(pricing, {
			tokensIn: 1300,
			cacheRead: 1000,
			cacheWrite: 100,
			tokensOut: 20
		});
		expect(cost).toBeCloseTo((200 * 2 + 1000 * 0.2 + 100 * 2.5 + 20 * 10) / 1e6, 12);
	});

	it('prices cache writes as fresh input where the provider names no write price', () => {
		const pricing = { inputPerMTok: 1, cacheReadPerMTok: 0.1, outputPerMTok: 5 };
		const cost = stepCost(pricing, { tokensIn: 1000, cacheRead: 0, cacheWrite: 400, tokensOut: 0 });
		expect(cost).toBeCloseTo(1000 / 1e6, 12);
	});

	it('prices a request above the long-context threshold entirely at the long-context rates', () => {
		const { pricing } = cloudModel('openai', 'gpt-6-sol')!;
		const usage = { tokensIn: 300_000, cacheRead: 100_000, cacheWrite: 0, tokensOut: 1000 };
		expect(stepCost(pricing, usage)).toBeCloseTo(
			(200_000 * 4 + 100_000 * 0.4 + 1000 * 15) / 1e6,
			12
		);
		expect(stepCost(pricing, { ...usage, tokensIn: 272_000, cacheRead: 0 })).toBeCloseTo(
			(272_000 * 2 + 1000 * 10) / 1e6,
			12
		);
	});
});
