import { describe, expect, it } from 'vitest';
import {
	LOCALES,
	catalogue,
	localeFromEnv,
	negotiateLocale,
	placeholders,
	resolveLocale,
	translate,
	type Locale
} from './index.ts';
import { en } from './en.ts';

describe('catalogues', () => {
	const others = LOCALES.filter((locale) => locale !== 'en');

	it.each(others)('%s has exactly the keys of the English reference catalogue', (locale) => {
		expect(Object.keys(catalogue(locale)).sort()).toEqual(Object.keys(en).sort());
	});

	it.each(others)('%s uses the same placeholders as English in every message', (locale) => {
		const placeholdersPerKey = (locale: Locale) =>
			Object.fromEntries(
				Object.entries(catalogue(locale)).map(([key, text]) => [key, placeholders(text).sort()])
			);
		expect(placeholdersPerKey(locale)).toEqual(placeholdersPerKey('en'));
	});

	it('fills placeholders and leaves unknown ones visible', () => {
		expect(translate('de', 'auth.passwordTooShort', { min: 12 })).toBe(
			'Das Passwort braucht mindestens 12 Zeichen.'
		);
		expect(translate('en', 'auth.passwordTooShort')).toContain('{min}');
	});
});

describe('locale selection', () => {
	it.each([
		['de-DE,de;q=0.9,en;q=0.8', 'de'],
		['en-US,en;q=0.9,de;q=0.8', 'en'],
		['fr-FR,de;q=0.5,en;q=0.7', 'en'],
		['fr-FR,de;q=0.5', 'de'],
		['de;q=0,en', 'en'],
		['fr-FR', 'en'],
		['*', 'en'],
		['', 'en'],
		[null, 'en']
	])('Accept-Language %j selects %s', (header, locale) => {
		expect(negotiateLocale(header)).toBe(locale);
	});

	it('the language setting wins over the browser, an unknown setting does not', () => {
		expect(resolveLocale('de', 'en-US')).toBe('de');
		expect(resolveLocale('xx', 'de-DE')).toBe('de');
		expect(resolveLocale(undefined, 'en-US')).toBe('en');
	});

	it.each([
		[{ LANG: 'de_DE.UTF-8' }, 'de'],
		[{ LANG: 'en_US.UTF-8' }, 'en'],
		[{ LANG: 'de_DE.UTF-8', LC_MESSAGES: 'en_GB.UTF-8' }, 'en'],
		[{ LANG: 'en_US.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LC_ALL: 'de_AT.UTF-8' }, 'de'],
		[{ LANG: 'C' }, 'en'],
		[{ LANG: 'de_DE.UTF-8', LC_ALL: '' }, 'de'],
		[{}, 'en']
	])('the CLI environment %j selects %s', (env, locale) => {
		expect(localeFromEnv(env)).toBe(locale);
	});
});
