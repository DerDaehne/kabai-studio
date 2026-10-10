import { describe, expect, it } from 'vitest';
import {
	catalogDefaults,
	defaultPool,
	extraPromptWarning,
	NEW_PROFILE,
	pricingNotice,
	thinkingBudgetWarning,
	withCatalogDefaults,
	type ProfileValues
} from './profile-defaults';

const values = (patch: Partial<ProfileValues>): ProfileValues => ({ ...NEW_PROFILE, ...patch });

describe('catalog defaults for a known model', () => {
	it('suggests thinking, max_tokens, prompt variant and the recommended role, each with one sentence why', () => {
		const ornith = catalogDefaults('Ornith-1.5-35B-A3B-GGUF:Q8_0');
		expect(ornith).toMatchObject({
			id: 'ornith-1.5-35b',
			role: 'refine',
			thinking: true,
			maxTokens: 32000,
			promptVariant: 'compact'
		});
		expect(ornith?.reasons.role).toContain('strongest refinement quality');
		expect(ornith?.reasons.thinking).toContain('without thinking enabled');
		expect(ornith?.reasons.maxTokens).toContain('consumes it all');
		expect(ornith?.reasons.promptVariant).toMatch(/kompakt/);
	});

	it('follows the role-specific settings of the catalog', () => {
		expect(catalogDefaults('qwen3.6:35b')).toMatchObject({
			role: 'code',
			thinking: true,
			maxTokens: 16000
		});
		expect(catalogDefaults('qwen3.6-35b', 'tour')).toMatchObject({
			role: 'tour',
			thinking: false,
			maxTokens: 8000
		});
	});

	it('leaves the switch out for a model whose thinking is built in, and says so', () => {
		const gptOss = catalogDefaults('gpt-oss:20b');
		expect(gptOss?.thinking).toBeUndefined();
		expect(gptOss?.reasons.thinking).toMatch(/fest eingebaut/);
	});

	it('knows nothing about an unknown model', () => {
		expect(catalogDefaults('llama3')).toBeNull();
		expect(catalogDefaults('')).toBeNull();
	});

	it('fills the form fields, and every field stays an editable value that can be overridden', () => {
		const filled = withCatalogDefaults(values({ model: 'ornith-1.5-35b', max_tokens: '100' }));
		expect(filled).toMatchObject({
			role: 'refine',
			thinking: 'on',
			max_tokens: '32000',
			prompt_variant: 'compact'
		});
		const overridden = { ...filled, thinking: 'off', max_tokens: '4000', role: 'tour' } as const;
		expect(withCatalogDefaults({ ...overridden, model: 'llama3' })).toEqual({
			...overridden,
			model: 'llama3'
		});
	});
});

describe('warnings for risky values', () => {
	it('warns when thinking would use up a max_tokens below the minimum, with a way out', () => {
		const warning = thinkingBudgetWarning(
			values({ model: 'ornith-1.5-35b', thinking: 'on', max_tokens: '12000' })
		);
		expect(warning).toContain('Das Denken verbraucht das Budget, es kommt keine Antwort.');
		expect(warning).toMatch(/Ausweg: max_tokens auf mindestens 32000 erhöhen oder Thinking aus/);
	});

	it('counts the catalog default as thinking, also when it is built in', () => {
		expect(
			thinkingBudgetWarning(values({ model: 'ornith-1.5-35b', max_tokens: '12000' }))
		).not.toBeNull();
		expect(thinkingBudgetWarning(values({ model: 'gpt-oss-20b', max_tokens: '4000' }))).toContain(
			'8000'
		);
	});

	it('stays quiet when the budget is enough, thinking is off, max_tokens is empty or the model unknown', () => {
		const quiet = [
			values({ model: 'ornith-1.5-35b', thinking: 'on', max_tokens: '32000' }),
			values({ model: 'ornith-1.5-35b', thinking: 'off', max_tokens: '12000' }),
			values({ model: 'ornith-1.5-35b', thinking: 'on', max_tokens: '' }),
			values({ model: 'qwen3.6-35b', role: 'tour', max_tokens: '8000' }),
			values({ model: 'llama3', thinking: 'on', max_tokens: '10' })
		];
		expect(quiet.map(thinkingBudgetWarning)).toEqual([null, null, null, null, null]);
	});

	it('warns about the prompt budget when the extra prompt exceeds 300 tokens (characters / 4)', () => {
		expect(extraPromptWarning('x'.repeat(1200))).toBeNull();
		const warning = extraPromptWarning('x'.repeat(1201));
		expect(warning).toContain('301 Tokens');
		expect(warning).toContain('Prompt-Budget');
		expect(warning).toMatch(/Ausweg: \S/);
	});
});

describe('providers', () => {
	it('defaults the pool to local for OpenAI-compatible servers and to cloud otherwise', () => {
		expect(defaultPool('openai-compatible')).toBe('local');
		expect(defaultPool('openai')).toBe('cloud');
		expect(defaultPool('anthropic')).toBe('cloud');
	});

	it('says that a cloud model without a catalog price counts as 0, and nothing for priced or local models', () => {
		const notice =
			'Kein Preis im Katalog — Kosten dieses Profils zählen als 0, keine Denk-Zusammenfassung.';
		expect(pricingNotice('anthropic', 'claude-unknown-9')).toBe(notice);
		expect(pricingNotice('openai', 'gpt-unknown-9')).toBe(notice);
		expect(pricingNotice('anthropic', 'claude-sonnet-5')).toBeNull();
		expect(pricingNotice('openai', 'gpt-6-sol')).toBeNull();
		expect(pricingNotice('openai-compatible', 'qwen3.6-35b')).toBeNull();
		expect(pricingNotice('anthropic', '')).toBeNull();
	});
});
