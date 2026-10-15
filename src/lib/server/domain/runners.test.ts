import { createHash, timingSafeEqual } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from '../db';
import { DomainError } from './error';
import {
	PAIRING_CODE_TTL_MS,
	disconnectRunner,
	issuePairingCode,
	listRunners,
	pairRunner,
	runnerByCredential
} from './runners';

vi.mock('node:crypto', async (importOriginal) => {
	const crypto = await importOriginal<typeof import('node:crypto')>();
	return { ...crypto, timingSafeEqual: vi.fn(crypto.timingSafeEqual) };
});

let db: ReturnType<typeof openDb>;
beforeEach(() => {
	db = openDb(':memory:');
	migrate(db);
});
afterEach(() => vi.useRealTimers());

const refusal = (fn: () => unknown) => {
	try {
		fn();
	} catch (err) {
		if (err instanceof DomainError) return { code: err.code, message: err.message, hint: err.hint };
		throw err;
	}
	throw new Error('expected a refusal');
};

describe('pairing code', () => {
	it('is eight characters without look-alikes, and a new code invalidates the previous one', () => {
		const first = issuePairingCode().code;
		const second = issuePairingCode().code;

		expect(first).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
		expect(refusal(() => pairRunner(db, { code: first, name: 'laptop' })).code).toBe(
			'pairing_code_invalid'
		);
		expect(pairRunner(db, { code: second, name: 'laptop' }).name).toBe('laptop');
	});

	it('is valid for ten minutes and not a millisecond longer', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
		const stillValid = issuePairingCode().code;
		vi.advanceTimersByTime(PAIRING_CODE_TTL_MS - 1);
		expect(pairRunner(db, { code: stillValid, name: 'a' }).name).toBe('a');

		const expired = issuePairingCode().code;
		vi.advanceTimersByTime(PAIRING_CODE_TTL_MS);
		expect(refusal(() => pairRunner(db, { code: expired, name: 'b' })).code).toBe(
			'pairing_code_invalid'
		);
	});

	it('works only once', () => {
		const { code } = issuePairingCode();
		pairRunner(db, { code, name: 'laptop' });

		expect(refusal(() => pairRunner(db, { code, name: 'other' })).code).toBe(
			'pairing_code_invalid'
		);
		expect(listRunners(db).map((runner) => runner.name)).toEqual(['laptop']);
	});

	it('refuses an expired, a used and an unknown code with the very same answer, so a guess learns nothing', () => {
		vi.useFakeTimers();
		const used = issuePairingCode().code;
		pairRunner(db, { code: used, name: 'one' });
		const afterUse = refusal(() => pairRunner(db, { code: used, name: 'two' }));

		issuePairingCode();
		const unknown = refusal(() => pairRunner(db, { code: 'ABCDEFGH', name: 'two' }));

		const expiring = issuePairingCode().code;
		vi.advanceTimersByTime(PAIRING_CODE_TTL_MS);
		const expired = refusal(() => pairRunner(db, { code: expiring, name: 'two' }));

		expect(afterUse).toEqual(unknown);
		expect(expired).toEqual(unknown);
		expect(unknown.hint).toContain('neuen Code');
	});

	it('compares the code in constant time', () => {
		const { code } = issuePairingCode();
		vi.mocked(timingSafeEqual).mockClear();

		refusal(() => pairRunner(db, { code: 'ABCDEFGH', name: 'laptop' }));
		pairRunner(db, { code, name: 'laptop' });

		expect(timingSafeEqual).toHaveBeenCalledTimes(2);
	});

	it('accepts the code in lower case and with spaces or a dash, as people type it', () => {
		const { code } = issuePairingCode();
		const typed = `${code.slice(0, 4)}-${code.slice(4)} `.toLowerCase();

		expect(pairRunner(db, { code: typed, name: 'laptop' }).name).toBe('laptop');
	});
});

describe('pairing a runner', () => {
	it('stores only the SHA-256 of the credential and hands the credential out exactly once', () => {
		const { code } = issuePairingCode();
		const paired = pairRunner(db, { code, name: 'laptop' });

		expect(paired.credential).toMatch(/^[\w-]{43}$/); // 32 bytes, base64url
		const rows = db.prepare('SELECT * FROM runners').all();
		expect(rows).toEqual([
			{
				id: paired.id,
				name: 'laptop',
				credential_hash: createHash('sha256').update(paired.credential).digest('hex'),
				created_at: expect.any(String),
				last_seen_at: null
			}
		]);
		expect(JSON.stringify(rows)).not.toContain(paired.credential);
		expect(JSON.stringify(listRunners(db))).not.toMatch(/credential/);
	});

	it('gives a second machine with the same name a numbered suffix', () => {
		const names = ['laptop', 'laptop', ' laptop '].map(
			(name) => pairRunner(db, { code: issuePairingCode().code, name }).name
		);

		expect(names).toEqual(['laptop', 'laptop-2', 'laptop-3']);
	});

	it('refuses an empty, overlong or control-character name before using up the code', () => {
		const { code } = issuePairingCode();
		for (const name of ['  ', 'x'.repeat(65), 'evil\nname'])
			expect(refusal(() => pairRunner(db, { code, name })).code).toBe('invalid_runner_name');

		expect(pairRunner(db, { code, name: 'x'.repeat(64) }).name).toHaveLength(64);
	});
});

describe('disconnecting a runner', () => {
	it('revokes its credential at once and leaves other runners paired', () => {
		const laptop = pairRunner(db, { code: issuePairingCode().code, name: 'laptop' });
		const desktop = pairRunner(db, { code: issuePairingCode().code, name: 'desktop' });
		expect(runnerByCredential(db, laptop.credential)).toEqual({ id: laptop.id, name: 'laptop' });

		disconnectRunner(db, laptop.id);

		expect(runnerByCredential(db, laptop.credential)).toBeNull();
		expect(runnerByCredential(db, desktop.credential)?.name).toBe('desktop');
		expect(refusal(() => disconnectRunner(db, laptop.id)).code).toBe('not_found');
	});
});
