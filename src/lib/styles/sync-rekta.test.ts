import { execFileSync, spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	buildAt,
	buildRelease,
	check,
	latestReleaseTag,
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
	'dist/rekta.css': components,
	'dist/rekta.js': 'script',
	'dist/rekta.d.ts': 'declarations'
});

describe('provenanceHeader', () => {
	it('names the generator and the output file it is given', () => {
		const header = provenanceHeader('a'.repeat(40), 'scripts/build.mjs', 'dist/rekta.css', 'x');
		expect(header).toContain(' * Generator: scripts/build.mjs of Rekta Design\n');
		expect(header).toContain(' * Output: dist/rekta.css\n');
		expect(splitVendored(header + 'x').sha256).toBe(sha256('x'));
	});
});

describe('provenanceHeader tag line', () => {
	it('names the tag when the commit has one and leaves the line out when it has none', () => {
		const commit = 'a'.repeat(40);
		expect(
			provenanceHeader(commit, 'scripts/build.mjs', 'dist/rekta.css', 'x', 'v0.4.0')
		).toContain(` * Commit: ${commit}\n * Tag: v0.4.0\n`);
		expect(provenanceHeader(commit, 'scripts/build.mjs', 'dist/rekta.css', 'x')).not.toContain(
			' * Tag:'
		);
	});
});

describe('buildAt', () => {
	it('returns all vendored files of one build and its commit', () => {
		const { source, commit } = fakeRekta(buildScript(upstreamFiles('tokens', 'components')));
		expect(buildAt(clone(source), 'origin/HEAD')).toEqual({
			commit,
			generator: 'scripts/build.mjs',
			files: {
				'rekta.tokens.css': 'tokens',
				'rekta.css': 'components',
				'rekta.js': 'script',
				'rekta.d.ts': 'declarations'
			}
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

	it('names the script when only the script is missing', () => {
		const { 'dist/rekta.js': _script, ...withoutScript } = upstreamFiles('tokens', 'components');
		const { source } = fakeRekta(buildScript(withoutScript));
		expect(() => buildAt(clone(source), 'origin/HEAD')).toThrow(/wrote no dist\/rekta\.js/);
	});
});

describe('check', () => {
	const files = {
		'rekta.tokens.css': 'tokens',
		'rekta.css': 'components',
		'rekta.js': 'script',
		'rekta.d.ts': 'declarations'
	} as const;

	function pinnedRekta() {
		const pinned = fakeRekta(buildScript(upstreamFiles('tokens', 'components')));
		const git = (...args: string[]) =>
			execFileSync('git', [...gitIdentity, ...args], {
				cwd: pinned.source,
				encoding: 'utf8'
			}).trim();
		git('tag', 'v0.1.0');
		return { ...pinned, git };
	}

	function commitComponents(pinned: ReturnType<typeof pinnedRekta>, components: string): string {
		writeFileSync(
			join(pinned.source, 'scripts/build.mjs'),
			generatorThatWrites(upstreamFiles('tokens', components))
		);
		pinned.git('commit', '--quiet', '-am', 'change components');
		return pinned.git('rev-parse', 'HEAD');
	}

	it('is silent when every file matches the pin and upstream', () => {
		const { source, commit } = pinnedRekta();
		expect(check(source, vendoredFor(commit, files))).toEqual([]);
	});

	it('names the tag, commit and file of a newer release and the command that adopts it', () => {
		const pinned = pinnedRekta();
		const head = commitComponents(pinned, 'new components');
		pinned.git('tag', 'v0.2.0');

		const problems = check(pinned.source, vendoredFor(pinned.commit, files));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(
			`Rekta Design v0.2.0 (${head}) changed rekta.css against the pinned ${pinned.commit}`
		);
		expect(problems[0]).not.toContain('rekta.tokens.css');
		expect(problems[0]).toContain('`node scripts/sync-rekta.ts --ref v0.2.0`');
	});

	it('names the pinned tag when the vendored header has one', () => {
		const pinned = pinnedRekta();
		commitComponents(pinned, 'new components');
		pinned.git('tag', 'v0.2.0');
		const taggedHeaders = Object.fromEntries(
			VENDORED_FILES.map(({ output, target }) => [
				target,
				provenanceHeader(pinned.commit, 'scripts/build.mjs', output, files[target], 'v0.1.0') +
					files[target]
			])
		) as Record<TargetName, string>;

		expect(check(pinned.source, taggedHeaders)[0]).toContain('against the pinned v0.1.0;');
	});

	it('ignores commits after the newest tag, even when they change a file', () => {
		const pinned = pinnedRekta();
		commitComponents(pinned, 'unreleased components');

		expect(check(pinned.source, vendoredFor(pinned.commit, files))).toEqual([]);
	});

	it('ignores a pre-release tag above the newest release', () => {
		const pinned = pinnedRekta();
		commitComponents(pinned, 'candidate components');
		pinned.git('tag', 'v0.2.0-rc.1');

		expect(check(pinned.source, vendoredFor(pinned.commit, files))).toEqual([]);
	});

	it('prefers a release over its own release candidate', () => {
		const pinned = pinnedRekta();
		const released = commitComponents(pinned, 'released components');
		pinned.git('tag', 'v0.2.0');
		pinned.git('tag', 'v0.2.0-rc.1');

		expect(check(pinned.source, vendoredFor(pinned.commit, files))[0]).toContain(
			`Rekta Design v0.2.0 (${released})`
		);
	});

	it('ignores a tag that starts with v but is no version', () => {
		const pinned = pinnedRekta();
		commitComponents(pinned, 'vendor components');
		pinned.git('tag', 'vendor-snapshot');

		expect(check(pinned.source, vendoredFor(pinned.commit, files))).toEqual([]);
	});

	it('compares against the newest tag in version order: v0.10.0 comes after v0.9.0', () => {
		const pinned = pinnedRekta();
		commitComponents(pinned, 'new components');
		pinned.git('tag', 'v0.10.0');
		pinned.git('tag', 'v0.9.0');

		expect(check(pinned.source, vendoredFor(pinned.commit, files))[0]).toContain('v0.10.0');
	});

	it('reports upstream without any release tag as one line with a way out', () => {
		const { source, commit } = fakeRekta(buildScript(upstreamFiles('tokens', 'components')));

		const problems = check(source, vendoredFor(commit, files));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('has no release tag');
		expect(problems[0]).toContain('--ref <commit>');
	});

	it("reports upstream dropping one vendored output instead of reading the pinned build's stale file", () => {
		const pinned = pinnedRekta();
		const { 'dist/rekta.css': _dropped, ...rest } = upstreamFiles('tokens', 'components');
		writeFileSync(
			join(pinned.source, 'scripts/build.mjs'),
			generatorThatWrites({ ...rest, 'dist/rekta.components.css': 'components' })
		);
		pinned.git('commit', '--quiet', '-am', 'rename the component sheet');
		pinned.git('tag', 'v0.2.0');

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
		pinned.git('tag', 'v0.2.0');

		const problems = check(pinned.source, vendoredFor(pinned.commit, files));

		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/has no scripts\/build.mjs/);
	});
});

describe('the default release', () => {
	function taggedThenMoved() {
		const { source, commit } = fakeRekta(buildScript(upstreamFiles('tokens', 'components')));
		const git = (...args: string[]) =>
			execFileSync('git', [...gitIdentity, ...args], { cwd: source, encoding: 'utf8' }).trim();
		git('tag', 'v1.0.0');
		writeFileSync(
			join(source, 'scripts/build.mjs'),
			generatorThatWrites(upstreamFiles('tokens', 'unreleased components'))
		);
		git('commit', '--quiet', '-am', 'unreleased');
		return { source, released: commit };
	}

	it('builds the newest release tag rather than the default branch when no ref is given', () => {
		const { source, released } = taggedThenMoved();

		const build = buildRelease(clone(source));

		expect(build.commit).toBe(released);
		expect(build.tag).toBe('v1.0.0');
		expect(build.files['rekta.css']).toBe('components');
	});

	it('still builds an explicit ref', () => {
		const { source } = taggedThenMoved();

		expect(buildRelease(clone(source), 'origin/HEAD').files['rekta.css']).toBe(
			'unreleased components'
		);
	});

	it('refuses to pick a default when upstream has no release tag', () => {
		const { source } = fakeRekta(buildScript(upstreamFiles('tokens', 'components')));

		expect(() => latestReleaseTag(clone(source))).toThrow(RektaProblem);
		expect(() => buildRelease(clone(source))).toThrow(/has no release tag/);
	});
});

describe('the sync command', () => {
	/** Runs a copy of the script, so its writes land below a scratch src/lib instead of the app's. */
	function runSync(...args: string[]) {
		const root = mkdtempSync(join(tmpdir(), 'sync-cli-'));
		scratchDirs.push(root);
		mkdirSync(join(root, 'scripts'));
		copyFileSync('scripts/sync-rekta.ts', join(root, 'scripts/sync-rekta.ts'));
		const run = spawnSync(process.execPath, [join(root, 'scripts/sync-rekta.ts'), ...args], {
			encoding: 'utf8'
		});
		const vendoredCss = join(root, 'src/lib/styles/rekta.css');
		return { ...run, css: existsSync(vendoredCss) ? readFileSync(vendoredCss, 'utf8') : undefined };
	}

	it('vendors the newest release tag, not the default branch, when no ref is given', () => {
		const { source } = fakeRekta(buildScript(upstreamFiles('tokens', 'components')));
		const git = (...args: string[]) =>
			execFileSync('git', [...gitIdentity, ...args], { cwd: source, encoding: 'utf8' }).trim();
		git('tag', 'v1.0.0');
		writeFileSync(
			join(source, 'scripts/build.mjs'),
			generatorThatWrites(upstreamFiles('tokens', 'unreleased components'))
		);
		git('commit', '--quiet', '-am', 'unreleased');

		const { status, css } = runSync(source);

		expect(status).toBe(0);
		expect(splitVendored(css!)).toMatchObject({ body: 'components', tag: 'v1.0.0' });
	});

	it('reports upstream without a release tag as one line and writes nothing', () => {
		const { source } = fakeRekta(buildScript(upstreamFiles('tokens', 'components')));

		const { status, stderr, css } = runSync(source);

		expect(status).toBe(1);
		expect(stderr.trim().split('\n')).toEqual([expect.stringContaining('has no release tag')]);
		expect(css).toBeUndefined();
	});
});
