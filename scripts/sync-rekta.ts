// Vendors Rekta Design: builds a Rekta commit once in a throwaway clone and writes its token stylesheet, its component
// stylesheet, its script and the script's declarations, byte for byte, each below its own provenance header.
//
//   node scripts/sync-rekta.ts [source] [--ref <commit>]   update the vendored files (default: upstream, its HEAD)
//   node scripts/sync-rekta.ts --check [source]             rebuild the pinned commit and upstream HEAD, report drift
//
// `source` is anything `git clone` accepts; a local checkout stays untouched. The header always names the public
// upstream, never the source given here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const UPSTREAM = 'https://github.com/DerDaehne/Rekta-Design';
const LIB = new URL('../src/lib/', import.meta.url);
const HEADER_END = '\n */\n';

export const GENERATOR = 'scripts/build.mjs';

/** What the generator writes and where the app keeps it, below src/lib. */
export const VENDORED_FILES = [
	{ output: 'dist/rekta.tokens.css', target: 'rekta.tokens.css', directory: 'styles' },
	{ output: 'dist/rekta.css', target: 'rekta.css', directory: 'styles' },
	{ output: 'dist/rekta.js', target: 'rekta.js', directory: 'rekta' },
	{ output: 'dist/rekta.d.ts', target: 'rekta.d.ts', directory: 'rekta' }
] as const;

const vendoredUrl = ({ directory, target }: (typeof VENDORED_FILES)[number]) =>
	new URL(`${directory}/${target}`, LIB);

export type TargetName = (typeof VENDORED_FILES)[number]['target'];

/** A failure the maintainer can act on; reported as one line instead of a stack trace. */
export class RektaProblem extends Error {}

export interface Build {
	commit: string;
	tag: string | undefined;
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
	body: string,
	tag?: string
): string {
	return [
		'/*!',
		' * Rekta Design, vendored unchanged. Regenerate with scripts/sync-rekta.ts; never edit by hand.',
		` * Source: ${UPSTREAM}`,
		` * Commit: ${commit}`,
		...(tag ? [` * Tag: ${tag}`] : []),
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

function tagOf(clone: string): string | undefined {
	try {
		return git(clone, 'describe', '--tags', '--exact-match', 'HEAD');
	} catch {
		return undefined; // an untagged commit has no tag line
	}
}

/** Checks out `ref` in the clone, runs the generator's own completeness and AA check, then its build. */
export function buildAt(clone: string, ref: string): Build {
	git(clone, 'checkout', '--quiet', '--detach', ref);
	const commit = git(clone, 'rev-parse', 'HEAD');
	const tag = tagOf(clone);
	if (!existsSync(join(clone, GENERATOR)))
		throw new RektaProblem(
			`Rekta Design ${commit} has no ${GENERATOR}; adapt scripts/sync-rekta.ts to its new build.`
		);
	// dist/ is untracked, so a file left over from an earlier build in this clone must not pass for this commit's output
	for (const { output } of VENDORED_FILES) rmSync(join(clone, output), { force: true });
	try {
		for (const args of [[GENERATOR, '--check'], [GENERATOR]])
			execFileSync(process.execPath, args, { cwd: clone, stdio: ['ignore', 'inherit', 'inherit'] });
	} catch {
		throw new RektaProblem(
			`Rekta Design ${commit}: ${GENERATOR} failed (output above); fix the source or pin another commit.`
		);
	}
	for (const { output } of VENDORED_FILES)
		if (!existsSync(join(clone, output)))
			throw new RektaProblem(
				`Rekta Design ${commit}: ${GENERATOR} wrote no ${output}; adapt VENDORED_FILES in scripts/sync-rekta.ts to its new build.`
			);
	const files = Object.fromEntries(
		VENDORED_FILES.map(({ output, target }) => [target, readFileSync(join(clone, output), 'utf8')])
	) as Record<TargetName, string>;
	return { commit, tag, generator: GENERATOR, files };
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
	const { commit, tag, generator, files } = withClone(source, (clone) => buildAt(clone, ref));
	for (const file of VENDORED_FILES) {
		mkdirSync(new URL(`${file.directory}/`, LIB), { recursive: true });
		writeFileSync(
			vendoredUrl(file),
			provenanceHeader(commit, generator, file.output, files[file.target], tag) + files[file.target]
		);
	}
	console.log(`The vendored Rekta Design files now hold ${commit}${tag ? ` (${tag})` : ''}.`);
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

/** Returns the problems found; an empty list means all vendored files are genuine and current. */
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
				`Rekta Design HEAD is ${upstream.commit}; all vendored files match the pinned ${pinned}.`
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
		VENDORED_FILES.map((file) => [file.target, readFileSync(vendoredUrl(file), 'utf8')])
	) as Record<TargetName, string>;
	const problems = check(source, texts);
	for (const problem of problems) console.error(problem);
	if (problems.length > 0) process.exit(1);
	console.log('The vendored Rekta Design files are genuine and current.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
