import tsParser from '@typescript-eslint/parser';
import svelteParser from 'svelte-eslint-parser';

const readabilityRules = {
	'max-depth': ['error', 3],
	'max-lines-per-function': ['warn', { max: 40, skipBlankLines: true, skipComments: true }],
	complexity: ['warn', 15]
};

export default [
	{ ignores: ['build/', '.svelte-kit/', 'node_modules/', 'data/'] },
	{
		files: ['**/*.{js,ts}'],
		languageOptions: { parser: tsParser },
		rules: readabilityRules
	},
	{
		files: ['**/*.svelte'],
		languageOptions: { parser: svelteParser, parserOptions: { parser: tsParser } },
		rules: readabilityRules
	},
	{
		// A describe() block groups test cases; its length says nothing about readability.
		files: ['**/*.test.ts'],
		rules: { 'max-lines-per-function': 'off' }
	}
];
