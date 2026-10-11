import { page } from '$app/state';
import { translate, type MessageKey, type MessageParams } from './index.ts';

/** Translates into the locale the server resolved for this request; reactive, call it in markup. */
export const t = (key: MessageKey, params?: MessageParams): string =>
	translate(page.data.locale, key, params);
