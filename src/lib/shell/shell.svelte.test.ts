import { afterEach, describe, expect, it } from 'vitest';
import { bindCommands, boundCommands } from './shell.svelte';
import type { Suggestion } from './commands';

const suggestion = (id: string): Suggestion => ({ id, label: `:${id}` });

const unbinds: (() => void)[] = [];
function bind(suggestions: Suggestion[]) {
	const own = [...suggestions];
	unbinds.push(bindCommands(own));
	return own;
}

afterEach(() => {
	unbinds.splice(0).forEach((unbind) => unbind());
});

describe('bindCommands', () => {
	it('lists a bound command and drops it again once unbound', () => {
		const unbind = bindCommands([suggestion('run')]);
		expect(boundCommands().map((c) => c.id)).toEqual(['run']);
		unbind();
		expect(boundCommands()).toEqual([]);
	});

	it('keeps one binding intact while a second, unrelated one unbinds — two bindings never clobber each other', () => {
		bind([suggestion('run')]);
		const unbindSearch = bindCommands([suggestion('search')]);
		unbindSearch();
		expect(boundCommands().map((c) => c.id)).toEqual(['run']);
	});

	it('unbinds the layer that was removed, not whichever one sits on top of the stack', () => {
		bind([suggestion('run')]);
		bind([suggestion('search')]);
		// unbinding the first (oldest) layer must not remove the second, even though it was bound later
		unbinds[0]();
		unbinds.splice(0, 1);
		expect(boundCommands().map((c) => c.id)).toEqual(['search']);
	});

	it('lets the most recently bound layer win a colliding id, like bindKeys does for keys', () => {
		bind([suggestion('pause')]);
		const recent = suggestion('pause');
		bind([recent]);
		expect(boundCommands().find((c) => c.id === 'pause')).toBe(recent);
	});

	it('falls back to the older layer once the newer one unbinds', () => {
		const older = suggestion('pause');
		bind([older]);
		const unbindNewer = bindCommands([suggestion('pause')]);
		unbindNewer();
		expect(boundCommands().find((c) => c.id === 'pause')).toBe(older);
	});
});
