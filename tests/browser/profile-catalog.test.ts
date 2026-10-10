// The model catalog (src/lib/agents/model-catalog.ts) had no view of its own anywhere in the app; the agent
// profile form's model field is where its owner actually meets it, so this checks the catalog reaches the browser.
import { expect, open, test } from './fixtures.ts';

test('the model field offers the current catalog models with their price for Anthropic and OpenAI', async ({
	page
}) => {
	await open(page, '/settings/profiles/new');
	const provider = page.getByLabel('Provider');
	const model = page.getByLabel('Modell');
	const datalistOptions = () =>
		model.evaluate((input: HTMLInputElement) => {
			const list = input.list;
			return list ? [...list.options].map((option) => option.value + '|' + option.textContent) : [];
		});

	await provider.selectOption('anthropic');
	const anthropicOptions = await datalistOptions();
	const sonnet = anthropicOptions.find((entry) => entry.startsWith('claude-sonnet-5-5|'));
	expect(sonnet).toBeDefined();
	expect(sonnet).toContain('$');

	await provider.selectOption('openai');
	const openaiOptions = await datalistOptions();
	expect(openaiOptions.some((entry) => entry.startsWith('gpt-6.1-sol|'))).toBe(true);
});
