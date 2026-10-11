import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixedEntryPoints = ['server.ts', 'src/lib/server/cli.ts'];

// server.ts loads the legacy CLI scripts through a dynamic import, so they are entry points of their own.
function legacyScripts(server: string): string[] {
	return [...server.matchAll(/runLegacyScript\('\.\/([^']+)'/g)].map(([, path]) => path);
}

type ReadSource = (file: string) => string;

function copiedPaths(dockerfile: string): string[] {
	return dockerfile
		.split('\n')
		.filter((line) => line.startsWith('COPY --from=build '))
		.flatMap((line) => line.split(/\s+/).slice(2, -1))
		.map((source) => source.replace(/^\/app\//, '').replace(/\/$/, ''));
}

function isCopied(file: string, copied: string[]): boolean {
	return copied.some((source) => file === source || file.startsWith(`${source}/`));
}

/** Static relative imports that survive type stripping, as paths relative to the repo root. */
function runtimeImports(file: string, source: string): string[] {
	const statement = /^(?:import|export)\b([^;'"]*?)(?:from\s*)?['"](\.\.?\/[^'"]+)['"]/gm;
	return [...source.matchAll(statement)]
		.filter(([, clause]) => !/^\s*type\b/.test(clause))
		.map(([, , specifier]) => normalize(join(dirname(file), specifier)))
		.filter((imported) => !imported.startsWith('build/'));
}

/** Files the image needs at runtime but does not copy, each with the file that imports it. */
function missingFromImage(dockerfile: string, readSource: ReadSource): string[] {
	const copied = copiedPaths(dockerfile);
	const entryPoints = [...fixedEntryPoints, ...legacyScripts(readSource('server.ts'))];
	const uncopiedEntries = entryPoints.filter((entry) => !isCopied(entry, copied));
	const importers = new Map<string, string>();
	const queue = [...entryPoints];
	const seen = new Set(queue);
	for (const file of queue) {
		for (const imported of runtimeImports(file, readSource(file))) {
			if (!isCopied(imported, copied)) importers.set(imported, file);
			if (seen.has(imported)) continue;
			seen.add(imported);
			queue.push(imported);
		}
	}
	return [
		...uncopiedEntries.map(
			(entry) =>
				`${entry} is a runtime entry point but no COPY --from=build line in the Dockerfile covers it; add it to the runtime stage's COPY lines`
		),
		...[...importers].map(
			([imported, importer]) =>
				`${imported} is imported by ${importer} but no COPY --from=build line in the Dockerfile covers it; add it to the runtime stage's COPY lines`
		)
	];
}

describe('runtime image closure', () => {
	it('copies every file the server and the CLI entry points import at runtime', () => {
		const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
		const readSource: ReadSource = (file) => readFileSync(join(repoRoot, file), 'utf8');

		expect(missingFromImage(dockerfile, readSource)).toEqual([]);
	});

	describe('detection', () => {
		const dockerfile =
			'COPY --from=build /app/server.ts ./server.ts\nCOPY --from=build /app/src/lib/server/cli.ts ./src/lib/server/';
		const reading =
			(sources: Record<string, string>): ReadSource =>
			(file) =>
				sources[file] ?? '';

		it('names the missing file and its importer', () => {
			const read = reading({ 'server.ts': "import { a } from './src/lib/a.ts';" });

			expect(missingFromImage(dockerfile, read)).toEqual([
				expect.stringContaining('src/lib/a.ts is imported by server.ts')
			]);
		});

		it('follows imports transitively, including multi-line ones', () => {
			const copying = `${dockerfile}\nCOPY --from=build /app/src/lib/a.ts ./src/lib/`;
			const read = reading({
				'server.ts': "import {\n\ta,\n} from './src/lib/a.ts';",
				'src/lib/a.ts': "export { b } from './b.ts';"
			});

			expect(missingFromImage(copying, read)).toEqual([
				expect.stringContaining('src/lib/b.ts is imported by src/lib/a.ts')
			]);
		});

		it('ignores type-only imports, node: modules and build output', () => {
			const read = reading({
				'server.ts': [
					"import type { A } from './src/lib/a.ts';",
					"import type {\n\tB,\n} from './src/lib/b.ts';",
					"import { readFileSync } from 'node:fs';",
					"import { handler } from './build/handler.js';"
				].join('\n')
			});

			expect(missingFromImage(dockerfile, read)).toEqual([]);
		});

		it('accepts files covered through a copied directory, with or without a trailing slash', () => {
			const read = reading({ 'server.ts': "import { a } from './src/lib/a.ts';" });

			for (const source of ['/app/src/lib', '/app/src/lib/'])
				expect(
					missingFromImage(`${dockerfile}\nCOPY --from=build ${source} ./src/lib/`, read)
				).toEqual([]);
		});

		it('names a legacy CLI script that server.ts loads dynamically but the image does not copy', () => {
			const read = reading({
				'server.ts': "return runLegacyScript('./src/lib/server/restore.ts', []);"
			});

			expect(missingFromImage(dockerfile, read)).toEqual([
				expect.stringContaining('src/lib/server/restore.ts is a runtime entry point')
			]);
		});
	});
});
