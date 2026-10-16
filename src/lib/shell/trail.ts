import type { AfterNavigate } from '@sveltejs/kit';

/** The places this tab has been through, in history order, so a crumb knows whether its parent is the one below. */
let places: string[] = [];
let at = -1;

/** Follows the history: a navigation adds a place after the current one, back and forward only move along. */
export function recordNavigation({
	type,
	delta,
	to
}: Pick<AfterNavigate, 'type' | 'delta' | 'to'>) {
	const path = to?.url.pathname;
	if (!path) return;
	if (type === 'popstate' && delta !== undefined && places[at + delta] === path) {
		at += delta;
	} else if (type === 'enter' || type === 'popstate' || at < 0) {
		places = [path];
		at = 0;
	} else if (places[at] !== path) {
		places = [...places.slice(0, at + 1), path];
		at++;
	}
}

/** The place one step back in history, if this tab has seen it. */
export const placeBelow = (): string | undefined => places[at - 1];
