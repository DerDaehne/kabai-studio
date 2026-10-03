// Unit tests for the pure decision in ../server.ts (the production entry point). The actual
// server-start behaviour (no 403, the error message, the explicit-ORIGIN regression) is covered
// end-to-end in tests/browser/origin-default.test.ts, which needs the real built server.
import { describe, expect, it } from 'vitest';
import { decideOrigin } from '../server.ts';

describe('decideOrigin', () => {
	it.each([
		['unset', undefined],
		['empty', ''],
		['127.0.0.1', '127.0.0.1']
	])('defaults ORIGIN to http://127.0.0.1:<PORT> for %s HOST', (_, host) => {
		expect(decideOrigin({ HOST: host, PORT: '4000' })).toEqual({
			kind: 'default',
			origin: 'http://127.0.0.1:4000'
		});
	});

	it('defaults the port to 3000 when PORT is not set', () => {
		expect(decideOrigin({})).toEqual({ kind: 'default', origin: 'http://127.0.0.1:3000' });
	});

	it.each([
		['localhost', 'localhost'],
		['uppercase LOCALHOST', 'LOCALHOST']
	])(
		// Not 127.0.0.1: "localhost" can resolve to ::1 on one machine and 127.0.0.1 on another, but
		// the ORIGIN check compares the Origin header against this string, never a resolved IP — the
		// browser's address bar says "localhost" too, so matching the literal host always matches.
		'defaults ORIGIN to http://localhost:<PORT>, not an IP, for HOST=%s',
		(_, host) => {
			expect(decideOrigin({ HOST: host, PORT: '4000' })).toEqual({
				kind: 'default',
				origin: 'http://localhost:4000'
			});
		}
	);

	it('defaults ORIGIN to the bracketed http://[::1]:<PORT> for the IPv6 loopback HOST=::1', () => {
		expect(decideOrigin({ HOST: '::1', PORT: '4000' })).toEqual({
			kind: 'default',
			origin: 'http://[::1]:4000'
		});
	});

	it.each([
		['the Dockerfile default', '0.0.0.0'],
		['a non-loopback address', '192.0.2.5'] // RFC 5737 documentation range, not a real host
	])(
		'refuses a non-loopback HOST without ORIGIN with a plain-text error naming both (%s)',
		(_, host) => {
			const decision = decideOrigin({ HOST: host, PORT: '4000' });
			expect(decision.kind).toBe('error');
			if (decision.kind !== 'error') throw new Error('unreachable');
			expect(decision.message).toContain(`HOST=${host}`);
			expect(decision.message).toContain('ORIGIN');
			expect(decision.message).toContain('4000'); // the way out names the actual port
		}
	);

	it.each([
		['loopback', '127.0.0.1'],
		['non-loopback', '0.0.0.0'],
		['unset', undefined]
	])('never overwrites an explicitly set ORIGIN, regardless of HOST (%s)', (_, host) => {
		expect(decideOrigin({ HOST: host, ORIGIN: 'http://studio.example:443' })).toEqual({
			kind: 'keep'
		});
	});
});
