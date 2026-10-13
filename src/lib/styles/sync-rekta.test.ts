import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	buildAt,
	check,
	provenanceHeader,
	RektaProblem,
	sha256,
	splitVendored
} from '../../../scripts/sync-rekta.ts';

// Builds throwaway git repos that imitate Rekta Design layouts, so the drift check runs without a network.

const scratchDirs: string[] = [];
afterEach(() => {
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gitIdentity = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];
const generatorThatWrites = (files: Record<string, string>) =>
	`import { mkdirSync, writeFileSync } from 'node:fs';
	 if (process.argv.includes('--check')) process.exit(0);
	 mkdirSync('dist', { recursive: true });
	 for (const [file, text] of Object.entries(${JSON.stringify(files)})) writeFileSync(file, text);`;

/** Creates a repo whose single commit holds `files`; returns its path and commit. */
function fakeRekta(files: Record<string, string>): { source: string; commit: string } {
	const source = mkdtempSync(join(tmpdir(), 'fake-rekta-'));
	scratchDirs.push(source);
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(dirname(join(source, file)), { recursive: true });
		writeFileSync(join(source, file), text);
	}
	const git = (...args: string[]) =>
		execFileSync('git', [...gitIdentity, ...args], { cwd: source, encoding: 'utf8' }).trim();
	git('init', '--quiet');
	git('add', '.');
	git('commit', '--quiet', '-m', 'fake');
	return { source, commit: git('rev-parse', 'HEAD') };
}

function clone(source: string): string {
	const scratch = mkdtempSync(join(tmpdir(), 'fake-rekta-clone-'));
	scratchDirs.push(scratch);
	const target = join(scratch, 'rekta');
	execFileSync('git', ['clone', '--quiet', source, target]);
	return target;
}

const vendoredFor = (commit: string, generator: string, css: string) =>
	provenanceHeader(commit, generator, css) + css;

describe('provenanceHeader', () => {
	it('names the generator it is given', () => {
		const header = provenanceHeader('a'.repeat(40), 'scripts/build.mjs', 'x');
		expect(header).toContain(' * Generator: scripts/build.mjs of Rekta Design\n');
		expect(splitVendored(header + 'x').sha256).toBe(sha256('x'));
	});
});

describe('buildAt', () => {
	it('takes the tokens from dist/rekta.tokens.css for scripts/build.mjs, never the component sheet', () => {
		const { source, commit } = fakeRekta({
			'scripts/build.mjs': generatorThatWrites({
				'dist/rekta.tokens.css': 'tokens',
				'dist/rekta.css': 'components'
			})
		});
		expect(buildAt(clone(source), 'origin/HEAD')).toEqual({
			commit,
			generator: 'scripts/build.mjs',
			css: 'tokens'
		});
	});

	it('takes the tokens from dist/rekta.css for the older scripts/build-css.mjs', () => {
		const { source } = fakeRekta({
			'scripts/build-css.mjs': generatorThatWrites({ 'dist/rekta.css': 'old tokens' })
		});
		expect(buildAt(clone(source), 'origin/HEAD')).toMatchObject({
			generator: 'scripts/build-css.mjs',
			css: 'old tokens'
		});
	});

	it('reports an unknown layout with commit, searched generators and a way out', () => {
		const { source, commit } = fakeRekta({ 'README.md': 'nothing to build' });
		expect(() => buildAt(clone(source), 'origin/HEAD')).toThrow(
			new RektaProblem(
				`Rekta Design ${commit} has no known build (looked for scripts/build-css.mjs, scripts/build.mjs); adapt scripts/sync-rekta.ts.`
			)
		);
	});

	it('reports a failing generator with commit and generator instead of the raw exit error', () => {
		const { source, commit } = fakeRekta({ 'scripts/build.mjs': 'process.exit(3);' });
		expect(() => buildAt(clone(source), 'origin/HEAD')).toThrow(
			new RektaProblem(
				`Rekta Design ${commit}: scripts/build.mjs failed (output above); fix the source or pin another commit.`
			)
		);
	});
});

describe('check', () => {
	it('reports drift naming both commits and both generators, and advises a review', () => {
		const pinned = fakeRekta({
			'scripts/build-css.mjs': generatorThatWrites({ 'dist/rekta.css': 'old tokens' })
		});
		const git = (...args: string[]) =>
			execFileSync('git', [...gitIdentity, ...args], {
				cwd: pinned.source,
				encoding: 'utf8'
			}).trim();
		writeFileSync(
			join(pinned.source, 'scripts/build.mjs'),
			generatorThatWrites({ 'dist/rekta.tokens.css': 'new tokens', 'dist/rekta.css': 'old tokens' })
		);
		git('rm', '--quiet', 'scripts/build-css.mjs');
		git('add', '.');
		git('commit', '--quiet', '-m', 'next');
		const head = git('rev-parse', 'HEAD');

		const problems = check(
			pinned.source,
			vendoredFor(pinned.commit, 'scripts/build-css.mjs', 'old tokens')
		);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(`Rekta Design ${head} (generator scripts/build.mjs)`);
		expect(problems[0]).toContain(`pinned ${pinned.commit} (generator scripts/build-css.mjs)`);
		expect(problems[0]).toContain('review the new Rekta version before syncing');
	});

	it('turns an unbuildable upstream into a problem line instead of throwing', () => {
		const pinned = fakeRekta({
			'scripts/build-css.mjs': generatorThatWrites({ 'dist/rekta.css': 'old tokens' })
		});
		const git = (...args: string[]) =>
			execFileSync('git', [...gitIdentity, ...args], {
				cwd: pinned.source,
				encoding: 'utf8'
			}).trim();
		git('rm', '--quiet', 'scripts/build-css.mjs');
		git('commit', '--quiet', '-m', 'drop generator');

		const problems = check(
			pinned.source,
			vendoredFor(pinned.commit, 'scripts/build-css.mjs', 'old tokens')
		);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/has no known build/);
	});
});
