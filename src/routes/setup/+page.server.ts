import { fail, redirect } from '@sveltejs/kit';
import {
	TOO_MANY,
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
		const locked = () => fail(403, { name, error: 'Studio ist bereits eingerichtet — bitte unter /login anmelden.' });
		if (hasOwner(db())) return locked();

		const ip = getClientAddress();
		if (!authLimiter.attempt(ip)) return fail(429, { name, error: TOO_MANY });
		if (!checkSetupToken(token))
			return fail(403, {
				name,
				error: 'Setup-Token falsch. Den gültigen zeigt die Server-Konsole beim Start (Zeile „Setup-Token“); nach einem Neustart gilt ein neuer.'
			});
		authLimiter.succeed(ip);

		const problem = !name.trim()
			? 'Bitte einen Namen eingeben.'
			: password !== confirm
				? 'Die beiden Passwörter stimmen nicht überein — bitte beide Felder gleich ausfüllen.'
				: passwordProblem(password);
		if (problem) return fail(400, { name, error: problem });

		const user = createOwner(db(), name.trim(), await hashPassword(password));
		if (!user) return locked();
		clearSetupToken();
		setSessionCookie(cookies, url, createSession(db(), user.id));
		redirect(303, '/');
	}
};
