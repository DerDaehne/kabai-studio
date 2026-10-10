// Server loads and src/lib/server modules get the live contract from `$lib/live`, never from the client shell:
// the shell modules use runes and browser state that must not run, or leak into, the server bundle.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROUTES_DIR = fileURLToPath(new URL('./routes', import.meta.url));
const SERVER_LIB_DIR = fileURLToPath(new URL('./lib/server', import.meta.url));

const tsFilesUnder = (dir: string): string[] =>
	(readdirSync(dir, { recursive: true }) as string[])
		.filter((name) => name.endsWith('.ts'))
		.map((name) => join(dir, name));

const isServerLoadFile = (path: string) => /^\+.*\.server\.ts$/.test(path.split('/').pop()!);

const SHELL_IMPORT = /from\s+['"]\$lib\/shell\//;

describe('server/client boundary', () => {
	it('no SvelteKit server load and no src/lib/server module imports the client shell ($lib/shell/*)', () => {
		const serverFiles = [
			...tsFilesUnder(ROUTES_DIR).filter(isServerLoadFile),
			...tsFilesUnder(SERVER_LIB_DIR)
		];
		const violations = serverFiles.filter((file) => SHELL_IMPORT.test(readFileSync(file, 'utf8')));
		expect(violations).toEqual([]);
	});
});
