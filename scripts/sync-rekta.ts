// Vendors Rekta Design: builds a Rekta commit once in a throwaway clone and writes its token stylesheet and its
// component stylesheet, byte for byte, each below its own provenance header into src/lib/styles.
//
//   node scripts/sync-rekta.ts [source] [--ref <commit>]   update the vendored files (default: upstream, its HEAD)
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
const STYLES = new URL('../src/lib/styles/', import.meta.url);
const HEADER_END = '\n */\n';

export const GENERATOR = 'scripts/build.mjs';

/** What the generator writes and where the app keeps it. */
export const VENDORED_FILES = [
	{ output: 'dist/rekta.tokens.css', target: 'rekta.tokens.css' },
	{ output: 'dist/rekta.css', target: 'rekta.css' }
] as const;

export type TargetName = (typeof VENDORED_FILES)[number]['target'];

/** A failure the maintainer can act on; reported as one line instead of a stack trace. */
export class RektaProblem extends Error {}

export interface Build {
	commit: string;
	generator: string;
	files: Record<TargetName, string>;
}

export interface Vendored {
	body: string;
	commit: string | undefined;
	sha256: string | undefined;
}

export function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export function provenanceHeader(
	commit: string,
	generator: string,
	output: string,
	body: string
): string {
	return [
		'/*!',
		' * Rekta Design, vendored unchanged. Regenerate with scripts/sync-rekta.ts; never edit by hand.',
		` * Source: ${UPSTREAM}`,
		` * Commit: ${commit}`,
		` * Generator: ${generator} of Rekta Design`,
		` * Output: ${output}`,
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
	if (!existsSync(join(clone, GENERATOR)))
		throw new RektaProblem(
			`Rekta Design ${commit} has no ${GENERATOR}; adapt scripts/sync-rekta.ts to its new build.`
		);
	try {
		for (const args of [[GENERATOR, '--check'], [GENERATOR]])
			execFileSync(process.execPath, args, { cwd: clone, stdio: ['ignore', 'inherit', 'inherit'] });
	} catch {
		throw new RektaProblem(
			`Rekta Design ${commit}: ${GENERATOR} failed (output above); fix the source or pin another commit.`
		);
	}
	const files = Object.fromEntries(
		VENDORED_FILES.map(({ output, target }) => [target, readFileSync(join(clone, output), 'utf8')])
	) as Record<TargetName, string>;
	return { commit, generator: GENERATOR, files };
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
	const { commit, generator, files } = withClone(source, (clone) => buildAt(clone, ref));
	for (const { output, target } of VENDORED_FILES)
		writeFileSync(
			new URL(target, STYLES),
			provenanceHeader(commit, generator, output, files[target]) + files[target]
		);
	console.log(`src/lib/styles/rekta.tokens.css and rekta.css now hold Rekta Design ${commit}.`);
}

function attempt(build: () => Build, problems: string[]): Build | undefined {
	try {
		return build();
	} catch (error) {
		if (!(error instanceof RektaProblem)) throw error;
		problems.push(error.message);
	}
}

/** The first reason the vendored files cannot be trusted offline, or undefined when they can. */
function offlineProblem(vendored: Record<TargetName, Vendored>): string | undefined {
	for (const { target } of VENDORED_FILES) {
		if (!vendored[target].commit)
			return `${target} has no provenance header; run the sync to recreate it.`;
		if (sha256(vendored[target].body) !== vendored[target].sha256)
			return `${target} differs from the hash in its header: it was edited by hand. Run the sync.`;
	}
	const [first, ...others] = VENDORED_FILES;
	const mixed = others.find(
		({ target }) => vendored[target].commit !== vendored[first.target].commit
	);
	if (mixed)
		return `${mixed.target} comes from another Rekta commit than ${first.target}; run the sync.`;
}

/** Returns the problems found; an empty list means both vendored files are genuine and current. */
export function check(source: string, vendoredTexts: Record<TargetName, string>): string[] {
	const vendored = Object.fromEntries(
		VENDORED_FILES.map(({ target }) => [target, splitVendored(vendoredTexts[target])])
	) as Record<TargetName, Vendored>;
	const offline = offlineProblem(vendored);
	if (offline) return [offline];
	const pinned = vendored[VENDORED_FILES[0].target].commit!;
	const differing = (build: Build) =>
		VENDORED_FILES.map(({ target }) => target).filter(
			(target) => build.files[target] !== vendored[target].body
		);
	return withClone(source, (clone) => {
		const problems: string[] = [];
		const rebuilt = attempt(() => buildAt(clone, pinned), problems);
		for (const target of rebuilt ? differing(rebuilt) : [])
			problems.push(`The pinned commit ${pinned} no longer builds the vendored ${target}.`);
		const upstream = attempt(() => buildAt(clone, 'origin/HEAD'), problems);
		const drifted = upstream ? differing(upstream) : [];
		if (upstream && drifted.length === 0)
			console.log(
				`Rekta Design HEAD is ${upstream.commit}; both files match the pinned ${pinned}.`
			);
		if (upstream && drifted.length > 0)
			problems.push(
				`Rekta Design ${upstream.commit} changed ${drifted.join(' and ')} against the pinned ${pinned}; review the Rekta changelog, then run the sync to update.`
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
	const texts = Object.fromEntries(
		VENDORED_FILES.map(({ target }) => [target, readFileSync(new URL(target, STYLES), 'utf8')])
	) as Record<TargetName, string>;
	const problems = check(source, texts);
	for (const problem of problems) console.error(problem);
	if (problems.length > 0) process.exit(1);
	console.log('rekta.tokens.css and rekta.css are genuine and current.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
