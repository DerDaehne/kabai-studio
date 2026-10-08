// Vendors the Rekta Design tokens: builds dist/rekta.css in a throwaway clone of Rekta Design and writes it,
// byte for byte, below a provenance header into src/lib/styles/rekta.css.
//
//   node scripts/sync-rekta.ts [source] [--ref <commit>]   update the vendored file (default: upstream, its HEAD)
//   node scripts/sync-rekta.ts --check [source]             rebuild the pinned commit and upstream HEAD, report drift
//
// `source` is anything `git clone` accepts; a local checkout stays untouched. The header always names the public
// upstream, never the source given here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const UPSTREAM = 'https://github.com/DerDaehne/Rekta-Design';
const VENDORED = new URL('../src/lib/styles/rekta.css', import.meta.url);
const HEADER_END = '\n */\n';

export interface Vendored {
	body: string;
	commit: string | undefined;
	sha256: string | undefined;
}

export function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export function provenanceHeader(commit: string, body: string): string {
	return [
		'/*!',
		' * Rekta Design tokens, vendored unchanged. Regenerate with scripts/sync-rekta.ts; never edit by hand.',
		` * Source: ${UPSTREAM}`,
		` * Commit: ${commit}`,
		' * Generator: scripts/build-css.mjs of Rekta Design',
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

/** Checks out `ref` in the clone, runs Rekta's own completeness and AA check, then its CSS build. */
function buildAt(clone: string, ref: string): { commit: string; css: string } {
	git(clone, 'checkout', '--quiet', '--detach', ref);
	const node = (...args: string[]) =>
		execFileSync(process.execPath, ['scripts/build-css.mjs', ...args], {
			cwd: clone,
			stdio: ['ignore', 'inherit', 'inherit']
		});
	node('--check');
	node();
	return {
		commit: git(clone, 'rev-parse', 'HEAD'),
		css: readFileSync(join(clone, 'dist', 'rekta.css'), 'utf8')
	};
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
	const { commit, css } = withClone(source, (clone) => buildAt(clone, ref));
	writeFileSync(VENDORED, provenanceHeader(commit, css) + css);
	console.log(`src/lib/styles/rekta.css now holds Rekta Design ${commit}.`);
}

/** Returns the problems found; an empty list means the vendored file is genuine and current. */
function check(source: string): string[] {
	const vendored = splitVendored(readFileSync(VENDORED, 'utf8'));
	if (!vendored.commit) return ['rekta.css has no provenance header; run the sync to recreate it.'];
	if (sha256(vendored.body) !== vendored.sha256)
		return ['rekta.css differs from the hash in its header: it was edited by hand. Run the sync.'];
	const pinned = vendored.commit;
	return withClone(source, (clone) => {
		const problems: string[] = [];
		if (buildAt(clone, pinned).css !== vendored.body)
			problems.push(`The pinned commit ${pinned} no longer builds the vendored rekta.css.`);
		const upstream = buildAt(clone, 'origin/HEAD');
		if (upstream.css !== vendored.body)
			problems.push(`Rekta Design ${upstream.commit} changed the tokens; run the sync to update.`);
		else
			console.log(
				`Rekta Design HEAD is ${upstream.commit}; the tokens match the pinned ${pinned}.`
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
	if (!values.check) return sync(source, values.ref);
	const problems = check(source);
	for (const problem of problems) console.error(problem);
	if (problems.length > 0) process.exit(1);
	console.log('rekta.css is genuine and current.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
