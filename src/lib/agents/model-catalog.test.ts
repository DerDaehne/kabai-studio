import { describe, expect, it } from 'vitest';
import { contextBudget, MODEL_ROLES, MODELS, matchModel, type ModelEntry } from './model-catalog.ts';

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
	const expectedIds = ['ornith-1.5-35b', 'qwen3.6-35b', 'qwen3-coder-next', 'gpt-oss-20b', 'qwen3.8-27b'];

	it('contains every evaluated model', () => {
		expect(MODELS.map((m) => m.id).sort()).toEqual([...expectedIds].sort());
	});

	it('marks qwen3.8-27b as not-recommended for every role', () => {
		const entry = MODELS.find((m) => m.id === 'qwen3.8-27b');
		expect(Object.values(entry?.roles ?? {})).toEqual(['not-recommended', 'not-recommended', 'not-recommended', 'not-recommended']);
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
		expect(qwen?.sampling?.thinkingOn).toEqual({ temperature: 0.6, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0 });
		expect(qwen?.sampling?.thinkingOff).toEqual({ temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5 });
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
