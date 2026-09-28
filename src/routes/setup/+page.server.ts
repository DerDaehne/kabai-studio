import { fail, redirect } from '@sveltejs/kit';
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
	default: async ({ request, cookies, url, getClientAddress }) => {
		const form = await request.formData();
		const [token, name, password, confirm] = ['token', 'name', 'password', 'confirm'].map((k) => String(form.get(k) ?? ''));
		const locked = () => fail(403, { name, error: 'Studio ist bereits eingerichtet.' });
		if (hasOwner(db())) return locked();

		const ip = getClientAddress();
		if (!authLimiter.attempt(ip)) return fail(429, { name, error: 'Zu viele Fehlversuche — bitte eine Minute warten.' });
		if (!checkSetupToken(token)) return fail(403, { name, error: 'Setup-Token falsch. Er steht in der Server-Konsole.' });
		authLimiter.succeed(ip);

		const problem = !name.trim() ? 'Name fehlt.' : password !== confirm ? 'Die Passwörter stimmen nicht überein.' : passwordProblem(password);
		if (problem) return fail(400, { name, error: problem });

		const user = createOwner(db(), name.trim(), await hashPassword(password));
		if (!user) return locked();
		clearSetupToken();
		setSessionCookie(cookies, url, createSession(db(), user.id));
		redirect(303, '/');
	}
};
