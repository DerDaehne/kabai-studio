import { isActionFailure } from '@sveltejs/kit';
import { expect, it } from 'vitest';
import { attempt, attemptJson, domainFail } from './domain-failure';
import { DomainError } from './domain/error';

const notFound = new DomainError('not_found', 'Ticket 7 gibt es nicht.', 'Eine echte ID wählen.');
const conflict = new DomainError('open_tasks', 'Noch offene Tasks.', 'Erst abschließen.');
const boom = () => {
	throw new Error('boom');
};

it('attempt returns the change result, defaulting to an empty object', () => {
	expect(attempt(() => ({ ref: 'STU-1' }))).toEqual({ ref: 'STU-1' });
	expect(attempt(() => undefined)).toEqual({});
});

it('attempt maps a DomainError to fail() with the hint appended to the message, 404 for not_found and 409 otherwise', () => {
	const refused = attempt(() => {
		throw notFound;
	});
	expect(isActionFailure(refused) && refused.status).toBe(404);
	expect(refused).toMatchObject({
		data: { message: 'Ticket 7 gibt es nicht. Eine echte ID wählen.' }
	});

	const other = attempt(() => {
		throw conflict;
	});
	expect(isActionFailure(other) && other.status).toBe(409);
});

it('attempt merges extra fields onto the default payload without disturbing the message', () => {
	const refused = attempt(
		() => {
			throw notFound;
		},
		(err) => ({ id: 42, field: err.code })
	);
	expect(refused).toMatchObject({
		status: 404,
		data: { id: 42, field: 'not_found', message: 'Ticket 7 gibt es nicht. Eine echte ID wählen.' }
	});
});

it('attempt re-throws anything that is not a DomainError', () => {
	expect(() => attempt(boom)).toThrow('boom');
});

it('domainFail always answers 400 with exactly the fields the caller builds, and re-throws anything else', () => {
	const built = (err: DomainError) => ({ action: 'update', code: err.code, hint: err.hint });
	let caught: unknown;
	try {
		throw conflict;
	} catch (err) {
		caught = domainFail(err, built);
	}
	expect(caught).toMatchObject({
		status: 400,
		data: { action: 'update', code: 'open_tasks', hint: 'Erst abschließen.' }
	});

	expect(() => {
		try {
			boom();
		} catch (err) {
			domainFail(err, built);
		}
	}).toThrow('boom');
});

it('attemptJson wraps a successful change in json(), and a DomainError in 400 with code, message and hint', async () => {
	const ok = attemptJson(() => ({ cancelled: 2 }));
	expect(ok.status).toBe(200);
	expect(await ok.json()).toEqual({ cancelled: 2 });

	const refused = attemptJson(() => {
		throw notFound;
	});
	expect(refused.status).toBe(400);
	expect(await refused.json()).toEqual({
		code: 'not_found',
		message: 'Ticket 7 gibt es nicht.',
		hint: 'Eine echte ID wählen.'
	});
});

it('attemptJson re-throws anything that is not a DomainError', () => {
	expect(() => attemptJson(boom)).toThrow('boom');
});
