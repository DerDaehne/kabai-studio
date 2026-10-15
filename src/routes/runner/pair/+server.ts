import { json } from '@sveltejs/kit';
import { translate, type Locale, type MessageKey } from '$lib/i18n';
import { isLoopbackHost, rateLimiter } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { isDomainError } from '$lib/server/domain/error';
import { RUNNER_NAME_MAX, pairRunner } from '$lib/server/domain/runners';
import type { RequestHandler } from './$types';

/** Pairing attempts per minute and client address; a success does not count. */
const pairLimiter = rateLimiter(5, 60_000);

const REFUSALS = {
	browser_origin_forbidden: [403, 'runners.pair.browserOrigin'],
	insecure_transport: [403, 'runners.pair.insecureTransport'],
	too_many_attempts: [429, 'runners.pair.tooManyAttempts'],
	invalid_request: [400, 'runners.pair.invalidRequest'],
	pairing_code_invalid: [400, 'runners.pair.codeInvalid'],
	invalid_runner_name: [400, 'runners.pair.nameInvalid']
} as const satisfies Record<string, [number, MessageKey]>;
type RefusalCode = keyof typeof REFUSALS;

// The answer carries the credential (or a refusal about it); no cache may keep it.
const NO_STORE = { 'cache-control': 'no-store' };

function refuse(locale: Locale, code: RefusalCode, params: Record<string, string | number> = {}) {
	const [status, key] = REFUSALS[code];
	const hint = translate(locale, `${key}.hint`);
	return json(
		{ code, message: translate(locale, key, params), hint },
		{ status, headers: NO_STORE }
	);
}

async function readPairRequest(request: Request): Promise<{ code: string; name: string } | null> {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (typeof body?.code !== 'string' || typeof body.name !== 'string') return null;
	return { code: body.code, name: body.name };
}

/**
 * Exchanges a one-time code for a runner credential. Only the kabai-studio CLI calls this: browsers always send an
 * Origin on a POST, so any Origin means a browser or a page trying to obtain a credential, and is refused.
 */
export const POST: RequestHandler = async ({ request, url, getClientAddress, locals }) => {
	if (request.headers.has('origin')) return refuse(locals.locale, 'browser_origin_forbidden');
	if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname))
		return refuse(locals.locale, 'insecure_transport', { origin: url.origin });
	const ip = getClientAddress();
	if (!pairLimiter.attempt(ip)) return refuse(locals.locale, 'too_many_attempts');

	const pairing = await readPairRequest(request);
	if (!pairing) return refuse(locals.locale, 'invalid_request');
	try {
		const runner = pairRunner(db(), pairing);
		pairLimiter.succeed(ip);
		return json(runner, { status: 201, headers: NO_STORE });
	} catch (err) {
		if (!isDomainError(err) || !(err.code in REFUSALS)) throw err;
		return refuse(locals.locale, err.code as RefusalCode, { max: RUNNER_NAME_MAX });
	}
};
