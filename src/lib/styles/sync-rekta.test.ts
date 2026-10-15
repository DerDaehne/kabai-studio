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
	splitVendored,
	VENDORED_FILES,
	type TargetName
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

const buildScript = (files: Record<string, string>) => ({
	'scripts/build.mjs': generatorThatWrites(files)
});

const vendoredFor = (commit: string, files: Record<TargetName, string>) =>
	Object.fromEntries(
		VENDORED_FILES.map(({ output, target }) => [
			target,
			provenanceHeader(commit, 'scripts/build.mjs', output, files[target]) + files[target]
		])
	) as Record<TargetName, string>;

const upstreamFiles = (tokens: string, components: string) => ({
	'dist/rekta.tokens.css': tokens,
	'dist/rekta.css': components
});

describe('provenanceHeader', () => {
	it('names the generator and the output file it is given', () => {
		const header = provenanceHeader('a'.repeat(40), 'scripts/build.mjs', 'dist/rekta.css', 'x');
		expect(header).toContain(' * Generator: scripts/build.mjs of Rekta Design\n');
		expect(header).toContain(' * Output: dist/rekta.css\n');
		expect(splitVendored(header + 'x').sha256).toBe(sha256('x'));
	});
});

describe('buildAt', () => {
	it('returns both stylesheets of one build and its commit', () => {
		const { source, commit } = fakeRekta(buildScript(upstreamFiles('tokens', 'components')));
		expect(buildAt(clone(source), 'origin/HEAD')).toEqual({
			commit,
			generator: 'scripts/build.mjs',
			files: { 'rekta.tokens.css': 'tokens', 'rekta.css': 'components' }
		});
	});

	it('reports a missing generator with commit and a way out', () => {
		const { source, commit } = fakeRekta({ 'README.md': 'nothing to build' });
		expect(() => buildAt(clone(source), 'origin/HEAD')).toThrow(
			new RektaProblem(
				`Rekta Design ${commit} has no scripts/build.mjs; adapt scripts/sync-rekta.ts to its new build.`
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

describe('buildAt without a vendored output', () => {
	it('is a one-line problem, not a stack trace', () => {
		const { source } = fakeRekta(buildScript({ 'dist/rekta.tokens.css': 'tokens' }));
		expect(() => buildAt(clone(source), 'origin/HEAD')).toThrow(/wrote no dist\/rekta\.css/);
	});
});

describe('check', () => {
	const files = { 'rekta.tokens.css': 'tokens', 'rekta.css': 'components' } as const;

	function pinnedRekta() {
		const pinned = fakeRekta(buildScript(upstreamFiles('tokens', 'components')));
		const git = (...args: string[]) =>
			execFileSync('git', [...gitIdentity, ...args], {
				cwd: pinned.source,
				encoding: 'utf8'
			}).trim();
		return { ...pinned, git };
	}

	it('is silent when both files match the pin and upstream', () => {
		const { source, commit } = pinnedRekta();
		expect(check(source, vendoredFor(commit, files))).toEqual([]);
	});

	it('names the one file that drifted upstream, with both commits and a way out', () => {
		const pinned = pinnedRekta();
		writeFileSync(
			join(pinned.source, 'scripts/build.mjs'),
			generatorThatWrites(upstreamFiles('tokens', 'new components'))
		);
		pinned.git('commit', '--quiet', '-am', 'next');
		const head = pinned.git('rev-parse', 'HEAD');

		const problems = check(pinned.source, vendoredFor(pinned.commit, files));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(
			`Rekta Design ${head} changed rekta.css against the pinned ${pinned.commit}`
		);
		expect(problems[0]).not.toContain('rekta.tokens.css');
		expect(problems[0]).toContain('run the sync to update');
	});

	it("reports upstream dropping one vendored output instead of reading the pinned build's stale file", () => {
		const pinned = pinnedRekta();
		writeFileSync(
			join(pinned.source, 'scripts/build.mjs'),
			generatorThatWrites({
				'dist/rekta.tokens.css': 'tokens',
				'dist/rekta.components.css': 'components'
			})
		);
		pinned.git('commit', '--quiet', '-am', 'rename the component sheet');

		const problems = check(pinned.source, vendoredFor(pinned.commit, files));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('rekta.css');
	});

	it('flags a pinned commit that no longer builds the vendored file', () => {
		const { source, commit } = pinnedRekta();
		const problems = check(source, vendoredFor(commit, { ...files, 'rekta.css': 'other' }));
		expect(problems[0]).toBe(
			`The pinned commit ${commit} no longer builds the vendored rekta.css.`
		);
	});

	it('flags a file edited by hand', () => {
		const { source, commit } = pinnedRekta();
		const texts = vendoredFor(commit, files);
		texts['rekta.css'] += '/* tweak */';
		expect(check(source, texts)).toEqual([
			'rekta.css differs from the hash in its header: it was edited by hand. Run the sync.'
		]);
	});

	it('flags two files that come from different commits', () => {
		const { source, commit } = pinnedRekta();
		const texts = vendoredFor(commit, files);
		const other = vendoredFor('b'.repeat(40), files);
		texts['rekta.css'] = other['rekta.css'];
		expect(check(source, texts)[0]).toContain('rekta.css comes from another Rekta commit');
	});

	it('turns an unbuildable upstream into a problem line instead of throwing', () => {
		const pinned = pinnedRekta();
		pinned.git('rm', '--quiet', 'scripts/build.mjs');
		pinned.git('commit', '--quiet', '-m', 'drop generator');

		const problems = check(pinned.source, vendoredFor(pinned.commit, files));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/has no scripts\/build.mjs/);
	});
});
