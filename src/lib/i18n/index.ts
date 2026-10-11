// Human-facing texts in every supported language. Plain TypeScript with relative imports only, so the CLI can
// load it directly under Node, without Vite. Components use `t` from ./t.ts instead of `translate`.
import { de } from './de.ts';
import { en } from './en.ts';

export type MessageKey = keyof typeof en;
export type Catalogue = Record<MessageKey, string>;
export type MessageParams = Record<string, string | number>;

const CATALOGUES = { en, de } satisfies Record<string, Catalogue>;

export type Locale = keyof typeof CATALOGUES;
export const LOCALES = Object.keys(CATALOGUES) as Locale[];
export const FALLBACK_LOCALE: Locale = 'en';

/** The language setting's cookie; once set, it wins over the browser's Accept-Language. */
export const LOCALE_COOKIE = 'studio-locale';

const PLACEHOLDER = /\{(\w+)\}/g;

export const isLocale = (value: unknown): value is Locale =>
	typeof value === 'string' && Object.hasOwn(CATALOGUES, value);

export const catalogue = (locale: Locale): Catalogue => CATALOGUES[locale];

/** The `{name}` placeholders a message expects, in order of appearance. */
export const placeholders = (message: string): string[] =>
	Array.from(message.matchAll(PLACEHOLDER), (match) => match[1]);

export function translate(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
	// Handlers called without the server hook (unit tests, scripts) have no locale yet.
	const template = (CATALOGUES[locale] ?? CATALOGUES[FALLBACK_LOCALE])[key];
	return template.replace(PLACEHOLDER, (match, name: string) => String(params[name] ?? match));
}

/** The supported locale for a language tag such as `de-AT`, `en_US.UTF-8` or `C`, if there is one. */
function supportedLanguage(tag: string): Locale | undefined {
	const language = tag
		.trim()
		.split(/[-_.@]/)[0]
		.toLowerCase();
	return isLocale(language) ? language : undefined;
}

function parseLanguageRange(range: string): { tag: string; quality: number } {
	const [tag, ...params] = range.split(';');
	const quality = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
	return { tag, quality: quality === undefined ? 1 : Number(quality.slice(2)) };
}

/** Picks the best supported locale from an Accept-Language header, by quality; falls back to English. */
export function negotiateLocale(acceptLanguage: string | null): Locale {
	const ranges = (acceptLanguage ?? '')
		.split(',')
		.map(parseLanguageRange)
		.filter((range) => range.quality > 0)
		.sort((a, b) => b.quality - a.quality);
	return ranges.map((range) => supportedLanguage(range.tag)).find(isLocale) ?? FALLBACK_LOCALE;
}

/** The setting's cookie first, then the browser's preference. */
export const resolveLocale = (
	setting: string | undefined,
	acceptLanguage: string | null
): Locale => (isLocale(setting) ? setting : negotiateLocale(acceptLanguage));

/** The CLI's locale, with POSIX precedence: LC_ALL, then LC_MESSAGES, then LANG; falls back to English. */
export function localeFromEnv(env: Record<string, string | undefined>): Locale {
	const setting = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
	return supportedLanguage(setting) ?? FALLBACK_LOCALE;
}
