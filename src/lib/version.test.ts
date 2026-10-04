import { describe, expect, it } from 'vitest';
import { isPrerelease, resolveVersion } from './version';

describe('resolveVersion', () => {
	it('uses STUDIO_VERSION as-is when a container build set it from a tag', () => {
		const describe = () => {
			throw new Error('must not call git when STUDIO_VERSION is already set');
		};
		expect(resolveVersion({ STUDIO_VERSION: '0.1.0-alpha.3' }, describe)).toBe('0.1.0-alpha.3');
	});

	it('falls back to the local git describe output (a commit short hash without a reachable tag)', () => {
		expect(resolveVersion({}, () => 'a1b2c3d')).toBe('a1b2c3d');
	});

	it('falls back to "dev" when git itself is unavailable', () => {
		const describe = () => {
			throw new Error('git not found');
		};
		expect(resolveVersion({}, describe)).toBe('dev');
	});
});

describe('isPrerelease', () => {
	it('flags alpha and beta tags as a pre-release', () => {
		expect(isPrerelease('0.1.0-alpha.3')).toBe(true);
		expect(isPrerelease('0.1.0-beta.1')).toBe(true);
	});

	it('does not flag a final release or the local fallbacks', () => {
		expect(isPrerelease('0.1.0')).toBe(false);
		expect(isPrerelease('a1b2c3d')).toBe(false);
		expect(isPrerelease('dev')).toBe(false);
	});
});
