import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '$lib/i18n';
import { db } from '$lib/server/db';
import { issuePairingCode, PAIRING_CODE_TTL_MS } from '$lib/server/domain/runners';
import { POST } from './+server';

// A DB of its own in a temp directory; db() reads the directory only on its first call.
const dir = mkdtempSync(join(tmpdir(), 'studio-runner-pair-'));
process.env.STUDIO_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

let lastIp = 0;
/** Every test pairs from an address of its own, so the shared rate limit never leaks between tests. */
const freshIp = () => `10.1.0.${++lastIp}`;

type Call = {
	body?: unknown;
	ip?: string;
	origin?: string;
	studio?: string;
	locale?: Locale;
};

async function pair({
	body,
	ip = freshIp(),
	origin,
	studio = 'http://127.0.0.1:3000',
	locale = 'en'
}: Call) {
	const url = new URL('/runner/pair', studio);
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (origin) headers.origin = origin;
	const request = new Request(url, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
	const response = await POST({
		request,
		url,
		getClientAddress: () => ip,
		locals: { locale }
	} as never);
	return {
		status: response.status,
		cache: response.headers.get('cache-control'),
		body: await response.json()
	};
}

const runnerRows = () => db().prepare('SELECT * FROM runners').all();

describe('POST /runner/pair', () => {
	it('hands the credential out exactly once, keeps only its SHA-256 and never logs it', async () => {
		const output = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
			vi.spyOn(console, method)
		);
		const { code } = issuePairingCode();

		const first = await pair({ body: { code, name: 'laptop' } });
		const again = await pair({ body: { code, name: 'laptop' } });

		expect(first.status).toBe(201);
		expect(first.cache).toBe('no-store');
		const credential = first.body.credential as string;
		expect(first.body).toEqual({ id: expect.any(Number), name: 'laptop', credential });
		expect(credential).toMatch(/^[\w-]{43}$/);
		const hash = createHash('sha256').update(credential).digest('hex');
		expect(runnerRows()).toContainEqual(
			expect.objectContaining({ name: 'laptop', credential_hash: hash })
		);
		expect(JSON.stringify(runnerRows())).not.toContain(credential);
		expect(again.status).toBe(400);
		expect(JSON.stringify(again.body)).not.toContain(credential);
		expect(JSON.stringify(output.map((spy) => spy.mock.calls))).not.toContain(credential);
		output.forEach((spy) => spy.mockRestore());
	});

	it('refuses every Origin with 403, its own included, without using up the code', async () => {
		const { code } = issuePairingCode();

		for (const origin of ['http://127.0.0.1:3000', 'https://evil.example', 'null'])
			expect(await pair({ body: { code, name: 'laptop' }, origin })).toMatchObject({
				status: 403,
				body: { code: 'browser_origin_forbidden', hint: expect.stringContaining('terminal') }
			});

		expect((await pair({ body: { code, name: 'browserless' } })).status).toBe(201);
	});

	it('answers 429 with a hint after five failed attempts per minute from one address, and lets it try again after that minute', async () => {
		vi.useFakeTimers();
		issuePairingCode();
		const ip = freshIp();
		const guess = () => pair({ body: { code: 'ABCDEFGH', name: 'x' }, ip });

		for (let attempt = 1; attempt <= 5; attempt++) expect((await guess()).status).toBe(400);
		const blocked = await guess();
		const otherAddress = await pair({ body: { code: 'ABCDEFGH', name: 'x' } });
		vi.advanceTimersByTime(60_000);

		expect(blocked).toMatchObject({
			status: 429,
			body: { code: 'too_many_attempts', hint: 'Wait a minute, then run the command again.' }
		});
		expect(otherAddress.status).toBe(400);
		expect((await guess()).status).toBe(400);
	});

	it('refuses an expired, a used and an unknown code with the same code and hint', async () => {
		vi.useFakeTimers();
		const used = issuePairingCode().code;
		await pair({ body: { code: used, name: 'one' } });
		const answers = [await pair({ body: { code: used, name: 'two' } })];
		issuePairingCode();
		answers.push(await pair({ body: { code: 'ABCDEFGH', name: 'two' } }));
		const expiring = issuePairingCode().code;
		vi.advanceTimersByTime(PAIRING_CODE_TTL_MS);
		answers.push(await pair({ body: { code: expiring, name: 'two' } }));

		expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
		expect(answers[0]).toEqual({
			status: 400,
			cache: 'no-store',
			body: {
				code: 'pairing_code_invalid',
				message: 'The pairing code is expired, already used or unknown.',
				hint: expect.stringContaining('Connect a machine')
			}
		});
	});

	it('answers in the language of the request', async () => {
		const answer = await pair({ body: { code: 'ABCDEFGH', name: 'x' }, locale: 'de' });

		expect(answer.body.message).toBe(
			'Der Kopplungs-Code ist abgelaufen, schon benutzt oder unbekannt.'
		);
	});

	it('hands out no credential over plain http to an address other than loopback', async () => {
		const { code } = issuePairingCode();

		const plain = await pair({ body: { code, name: 'laptop' }, studio: 'http://studio.lan' });
		const tls = await pair({ body: { code, name: 'laptop' }, studio: 'https://studio.lan' });

		expect(plain).toMatchObject({
			status: 403,
			body: { code: 'insecure_transport', message: expect.stringContaining('http://studio.lan') }
		});
		expect(tls.status).toBe(201);
	});

	it('refuses a body without code and name, and a name that is too long, each with its hint', async () => {
		const { code } = issuePairingCode();

		expect(await pair({ body: { name: 'laptop' } })).toMatchObject({
			status: 400,
			body: { code: 'invalid_request' }
		});
		expect(await pair({ body: { code, name: 'x'.repeat(65) } })).toMatchObject({
			status: 400,
			body: {
				code: 'invalid_runner_name',
				message: 'The machine name must have 1 to 64 printable characters.',
				hint: 'Pass another name with --name <name>.'
			}
		});
	});
});
