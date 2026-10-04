import { fail } from '@sveltejs/kit';
import { DomainError } from './domain/error';

/** Runs a domain change for a form action; a broken rule comes back as one sentence with its way out. */
export function attempt<T>(change: () => T) {
	try {
		return change() ?? {};
	} catch (err) {
		if (!(err instanceof DomainError)) throw err;
		return fail(err.code === 'not_found' ? 404 : 409, { message: `${err.message} ${err.hint}` });
	}
}
