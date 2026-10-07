import { fail, json, type ActionFailure } from '@sveltejs/kit';
import { DomainError } from './domain/error';

/** Narrows `unknown` to `DomainError`, or re-throws — a rule violation is the only error every caller here expects. */
function assertDomainError(err: unknown): asserts err is DomainError {
	if (!(err instanceof DomainError)) throw err;
}

/**
 * Runs a domain change for a form action; a broken rule comes back as one sentence with its way out,
 * 404 for `not_found` and 409 for every other rule. `extra` adds the fields a route's component reads
 * beyond that (e.g. `id`), without disturbing the default message.
 */
export function attempt<T, E extends Record<string, unknown> = Record<never, never>>(
	change: () => T,
	extra?: (err: DomainError) => E
): T | {} | ActionFailure<{ message: string } & E> {
	try {
		return change() ?? {};
	} catch (err) {
		assertDomainError(err);
		const status = err.code === 'not_found' ? 404 : 409;
		return fail(status, { message: `${err.message} ${err.hint}`, ...extra?.(err) });
	}
}

/**
 * Maps a DomainError straight to a form's `fail(400, …)` with a caller-built payload; everything else
 * re-throws. For a route whose payload (wording, extra fields) differs too much from `attempt`'s default
 * to share it, or whose success path must stay untouched (e.g. a falsy check on the result).
 */
export function domainFail<T extends Record<string, unknown>>(
	err: unknown,
	toFields: (err: DomainError) => T
) {
	assertDomainError(err);
	return fail(400, toFields(err));
}

/**
 * Runs a domain change for a JSON API route; a broken rule comes back as 400 with `{code,message,hint}`,
 * so a refusal is never indistinguishable from a server crash.
 */
export function attemptJson<T>(change: () => T) {
	try {
		return json(change());
	} catch (err) {
		assertDomainError(err);
		return json({ code: err.code, message: err.message, hint: err.hint }, { status: 400 });
	}
}
