// Vendors the Rekta Design tokens: builds the token stylesheet in a throwaway clone of Rekta Design and writes it,
// byte for byte, below a provenance header into src/lib/styles/rekta.css. Which generator and output file hold the
// tokens depends on the Rekta version (BUILD_LAYOUTS).
//
//   node scripts/sync-rekta.ts [source] [--ref <commit>]   update the vendored file (default: upstream, its HEAD)
//   node scripts/sync-rekta.ts --check [source]             rebuild the pinned commit and upstream HEAD, report drift
//
// `source` is anything `git clone` accepts; a local checkout stays untouched. The header always names the public
// upstream, never the source given here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const UPSTREAM = 'https://github.com/DerDaehne/Rekta-Design';
const VENDORED = new URL('../src/lib/styles/rekta.css', import.meta.url);
const HEADER_END = '\n */\n';

/** Known Rekta build layouts. Since 0.2 dist/rekta.css is the component sheet, so the tokens live elsewhere. */
export const BUILD_LAYOUTS = [
	{ generator: 'scripts/build-css.mjs', output: 'dist/rekta.css' },
	{ generator: 'scripts/build.mjs', output: 'dist/rekta.tokens.css' }
] as const;

/** A failure the maintainer can act on; reported as one line instead of a stack trace. */
export class RektaProblem extends Error {}

export interface Build {
	commit: string;
	generator: string;
	css: string;
}

export interface Vendored {
	body: string;
	commit: string | undefined;
	sha256: string | undefined;
}

export function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export function provenanceHeader(commit: string, generator: string, body: string): string {
	return [
		'/*!',
		' * Rekta Design tokens, vendored unchanged. Regenerate with scripts/sync-rekta.ts; never edit by hand.',
		` * Source: ${UPSTREAM}`,
		` * Commit: ${commit}`,
		` * Generator: ${generator} of Rekta Design`,
		` * SHA-256 of everything below this header: ${sha256(body)}`,
		' * License: MIT, Copyright (c) 2026 DerDaehne; full text in NOTICE.',
		' * Notice: some token values derive from the Porsche Design System source code (Apache License 2.0).',
		' * No Porsche fonts, icons, assets or marks are included.',
		' */',
		''
	].join('\n');
}

/** Splits the vendored file into its provenance fields and the generated CSS below the header. */
export function splitVendored(text: string): Vendored {
	const end = text.startsWith('/*!') ? text.indexOf(HEADER_END) : -1;
	if (end < 0) return { body: text, commit: undefined, sha256: undefined };
	const header = text.slice(0, end);
	return {
		body: text.slice(end + HEADER_END.length),
		commit: header.match(/^ \* Commit: ([0-9a-f]{40})$/m)?.[1],
		sha256: header.match(/^ \* SHA-256 of everything below this header: ([0-9a-f]{64})$/m)?.[1]
	};
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Checks out `ref` in the clone, runs the generator's own completeness and AA check, then its build. */
export function buildAt(clone: string, ref: string): Build {
	git(clone, 'checkout', '--quiet', '--detach', ref);
	const commit = git(clone, 'rev-parse', 'HEAD');
	const layout = BUILD_LAYOUTS.find(({ generator }) => existsSync(join(clone, generator)));
	if (!layout) {
		const looked = BUILD_LAYOUTS.map(({ generator }) => generator).join(', ');
		throw new RektaProblem(
			`Rekta Design ${commit} has no known build (looked for ${looked}); adapt scripts/sync-rekta.ts.`
		);
	}
	const { generator, output } = layout;
	try {
		for (const args of [[generator, '--check'], [generator]])
			execFileSync(process.execPath, args, { cwd: clone, stdio: ['ignore', 'inherit', 'inherit'] });
	} catch {
		throw new RektaProblem(
			`Rekta Design ${commit}: ${generator} failed (output above); fix the source or pin another commit.`
		);
	}
	return { commit, generator, css: readFileSync(join(clone, output), 'utf8') };
}

function withClone<T>(source: string, work: (clone: string) => T): T {
	const scratch = mkdtempSync(join(tmpdir(), 'rekta-sync-'));
	try {
		const clone = join(scratch, 'rekta');
		execFileSync('git', ['clone', '--quiet', source, clone], { stdio: 'inherit' });
		return work(clone);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function sync(source: string, ref: string): void {
	const { commit, generator, css } = withClone(source, (clone) => buildAt(clone, ref));
	writeFileSync(VENDORED, provenanceHeader(commit, generator, css) + css);
	console.log(`src/lib/styles/rekta.css now holds Rekta Design ${commit}.`);
}

function attempt(build: () => Build, problems: string[]): Build | undefined {
	try {
		return build();
	} catch (error) {
		if (!(error instanceof RektaProblem)) throw error;
		problems.push(error.message);
	}
}

/** Returns the problems found; an empty list means the vendored file is genuine and current. */
export function check(source: string, vendoredText: string): string[] {
	const vendored = splitVendored(vendoredText);
	if (!vendored.commit) return ['rekta.css has no provenance header; run the sync to recreate it.'];
	if (sha256(vendored.body) !== vendored.sha256)
		return ['rekta.css differs from the hash in its header: it was edited by hand. Run the sync.'];
	const pinned = vendored.commit;
	return withClone(source, (clone) => {
		const problems: string[] = [];
		const rebuilt = attempt(() => buildAt(clone, pinned), problems);
		if (rebuilt && rebuilt.css !== vendored.body)
			problems.push(
				`The pinned commit ${pinned} no longer builds the vendored rekta.css (generator ${rebuilt.generator}).`
			);
		const upstream = attempt(() => buildAt(clone, 'origin/HEAD'), problems);
		if (!upstream) return problems;
		if (upstream.css === vendored.body) {
			console.log(
				`Rekta Design HEAD is ${upstream.commit}; the tokens match the pinned ${pinned}.`
			);
			return problems;
		}
		const pinnedGenerator = rebuilt?.generator ?? 'unknown';
		const advice =
			upstream.generator === pinnedGenerator
				? 'run the sync to update.'
				: 'the generator changed, so review the new Rekta version before syncing.';
		problems.push(
			`Rekta Design ${upstream.commit} (generator ${upstream.generator}) changed the tokens against the pinned ${pinned} (generator ${pinnedGenerator}); ${advice}`
		);
		return problems;
	});
}

function main(): void {
	const { values, positionals } = parseArgs({
		options: {
			check: { type: 'boolean', default: false },
			ref: { type: 'string', default: 'origin/HEAD' }
		},
		allowPositionals: true
	});
	const source = positionals[0] ?? UPSTREAM;
	try {
		if (!values.check) return sync(source, values.ref);
	} catch (error) {
		if (!(error instanceof RektaProblem)) throw error;
		console.error(error.message);
		process.exit(1);
	}
	const problems = check(source, readFileSync(VENDORED, 'utf8'));
	for (const problem of problems) console.error(problem);
	if (problems.length > 0) process.exit(1);
	console.log('rekta.css is genuine and current.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
