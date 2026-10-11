import { fail, redirect } from '@sveltejs/kit';
import { translate, type MessageKey } from '$lib/i18n';
import {
	authLimiter,
	checkSetupToken,
	clearSetupToken,
	createOwner,
	createSession,
	hasOwner,
	hashPassword,
	passwordProblem,
	setSessionCookie
} from '$lib/server/auth';
import { db } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	if (hasOwner(db())) redirect(303, '/login');
	return { token: url.searchParams.get('token') ?? '' };
};

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress, locals }) => {
		const form = await request.formData();
		const [token, name, password, confirm] = ['token', 'name', 'password', 'confirm'].map((k) =>
			String(form.get(k) ?? '')
		);
		const message = (key: MessageKey) => translate(locals.locale, key);
		const locked = () => fail(403, { name, error: message('setup.alreadyDone') });
		if (hasOwner(db())) return locked();

		const ip = getClientAddress();
		if (!authLimiter.attempt(ip))
			return fail(429, { name, error: message('auth.tooManyAttempts') });
		if (!checkSetupToken(token)) return fail(403, { name, error: message('setup.wrongToken') });
		authLimiter.succeed(ip);

		const problem = !name.trim()
			? message('setup.nameMissing')
			: password !== confirm
				? message('setup.passwordsDiffer')
				: passwordProblem(password, locals.locale);
		if (problem) return fail(400, { name, error: problem });

		const user = createOwner(db(), name.trim(), await hashPassword(password));
		if (!user) return locked();
		clearSetupToken();
		setSessionCookie(cookies, url, createSession(db(), user.id));
		redirect(303, '/');
	}
};
