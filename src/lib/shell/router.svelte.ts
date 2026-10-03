import { untrack } from 'svelte';
import { anyLetter, keymap, splitPending, type KeyAction } from './keys';
import { shell } from './shell.svelte';

/** Runs a bound action; `count` is the typed count or 1, `key` the last key pressed (j or k, 1–3, the project letter). */
export type KeyHandler = (count: number, key: string) => void;
export type KeyHandlers = Partial<Record<KeyAction, KeyHandler>>;

export type KeyInput = Pick<
	KeyboardEvent,
	| 'key'
	| 'code'
	| 'altKey'
	| 'ctrlKey'
	| 'metaKey'
	| 'shiftKey'
	| 'target'
	| 'getModifierState'
	| 'preventDefault'
>;

/** Single keys off: every single-character key needs Alt, so speech input or a slip of the hand triggers nothing. */
export const keyboard = $state({ singleKeys: true });

const singleKeysStorage = 'studio-single-keys';

export function setSingleKeys(on: boolean): void {
	keyboard.singleKeys = on;
	try {
		if (on) localStorage.removeItem(singleKeysStorage);
		else localStorage.setItem(singleKeysStorage, 'off');
	} catch {
		// without storage (private mode) the choice lasts until the next reload
	}
}

export function restoreSingleKeys(): void {
	try {
		keyboard.singleKeys = localStorage.getItem(singleKeysStorage) !== 'off';
	} catch {
		// without storage single keys stay on
	}
}

let layers = $state.raw<KeyHandlers[]>([]);
const actions = Object.keys(keymap) as KeyAction[];

/** Binds handlers to keymap actions until the returned function unbinds them; return it from an `$effect`. */
export function bindKeys(handlers: KeyHandlers): () => void {
	// untracked: an effect that binds must not depend on the layers it changes, or it reruns forever
	untrack(() => (layers = [...layers, handlers]));
	return () => untrack(() => (layers = layers.filter((layer) => layer !== handlers)));
}

function handlerFor(action: KeyAction): KeyHandler | undefined {
	return layers.findLast((layer) => layer[action])?.[action];
}

export function boundActions(): Set<KeyAction> {
	return new Set(actions.filter(handlerFor));
}

/** The sequences of all bound actions, in keymap order. */
function boundSequences(): { action: KeyAction; keys: string[] }[] {
	return actions
		.filter(handlerFor)
		.flatMap((action) => keymap[action].keys.map((keys) => ({ action, keys })));
}

const fits = (expected: string, pressed: string) =>
	expected === pressed || (expected === anyLetter && /^[a-z]$/.test(pressed));

const startsWith = (keys: string[], pressed: string[]) =>
	keys.length >= pressed.length && pressed.every((key, index) => fits(keys[index], key));

function actionFor(pressed: string[]): KeyAction | undefined {
	return boundSequences().find(
		({ keys }) => keys.length === pressed.length && startsWith(keys, pressed)
	)?.action;
}

const isContinued = (pressed: string[]) =>
	boundSequences().some(({ keys }) => keys.length > pressed.length && startsWith(keys, pressed));

/** Digits count, unless a decision is in focus (then 1–3 answer it) or nothing bound takes a count. */
function readsAsCount(key: string): boolean {
	const { count, prefix } = splitPending(shell.pendingKeys);
	if (!/^\d$/.test(key) || prefix || handlerFor('answer')) return false;
	const somethingCounts = boundSequences().some(({ action }) => keymap[action].counted);
	return somethingCounts && (key !== '0' || count !== '');
}

// Text entry and open dialogs handle their own keys; Enter and Space activate a focused control.
const ownKeys =
	'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"]), textarea, select, [contenteditable], dialog[open]';
const activatable = 'a[href], button, summary, input';

function belongsToTarget(event: KeyInput): boolean {
	const target = event.target as Element | null;
	if (target?.closest(ownKeys)) return true;
	return (event.key === 'Enter' || event.key === ' ') && Boolean(target?.closest(activatable));
}

// macOS types another character with Alt (Alt+j is ∆); then the physical key names the intended one.
function characterBehind(event: KeyInput): string {
	if (/^[ -~]$/.test(event.key)) return event.key;
	if (event.code.startsWith('Key')) {
		const letter = event.code.slice(3).toLowerCase();
		return event.shiftKey ? letter.toUpperCase() : letter;
	}
	if (event.code.startsWith('Digit')) return event.code.slice(5);
	return event.key;
}

/** The key as the keymap names it, or null when it is the browser's or single keys are off. */
export function readKey(event: KeyInput): string | null {
	const altGraph = event.getModifierState('AltGraph');
	// Windows reports AltGr as Ctrl+Alt; AltGr only types characters such as { and }
	const ctrl = event.ctrlKey && !altGraph;
	const alt = event.altKey && !(altGraph && event.ctrlKey);
	if (event.metaKey) return null;
	if (ctrl) return `Ctrl+${event.key}`;
	if (alt) return characterBehind(event);
	if (event.key.length === 1 && !keyboard.singleKeys) return null;
	return event.key;
}

function runOrWait(key: string, event: KeyInput): void {
	const { count, prefix } = splitPending(shell.pendingKeys);
	const pressed = [...prefix, key];
	const action = actionFor(pressed);
	if (action) {
		shell.pendingKeys = '';
		event.preventDefault();
		handlerFor(action)?.(Number(count || 1), key);
	} else if (isContinued(pressed)) {
		shell.pendingKeys += key;
		event.preventDefault();
	} else {
		shell.pendingKeys = '';
	}
}

/** The window keydown listener: a count, prefix or leader waits in `shell.pendingKeys` until a sequence completes. */
export function handleKey(event: KeyInput): void {
	if (belongsToTarget(event)) return;
	const key = readKey(event);
	if (key === null) return;
	if (key === 'Escape' && shell.pendingKeys) {
		shell.pendingKeys = '';
		event.preventDefault();
	} else if (readsAsCount(key)) {
		shell.pendingKeys += key;
		event.preventDefault();
	} else {
		runOrWait(key, event);
	}
}
