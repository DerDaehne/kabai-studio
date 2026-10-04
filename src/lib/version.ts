import { execFileSync } from 'node:child_process';

/** True for a pre-release tag such as 0.1.0-alpha.3 or 0.1.0-beta.1; false for a final release or a commit hash. */
export function isPrerelease(version: string): boolean {
	return /-(alpha|beta)\.\d+/.test(version);
}

/**
 * The running version shown in /settings and /api/health: the STUDIO_VERSION build arg baked into the container
 * image, else `git describe --tags --always --dirty` for a local build, else 'dev' when git itself is unavailable
 * (e.g. an extracted release tarball without a .git directory).
 */
export function resolveVersion(
	env: Record<string, string | undefined> = process.env,
	describe: () => string = gitDescribe
): string {
	if (env.STUDIO_VERSION) return env.STUDIO_VERSION;
	try {
		return describe();
	} catch {
		return 'dev';
	}
}

function gitDescribe(): string {
	return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
		encoding: 'utf8'
	}).trim();
}
