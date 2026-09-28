import { fail, redirect } from '@sveltejs/kit';
import { authLimiter, checkLogin, createSession, hasOwner, setSessionCookie } from '$lib/server/auth';
import { db } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!hasOwner(db())) redirect(303, '/setup');
	if (locals.user) redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '');
		const ip = getClientAddress();
		if (!authLimiter.attempt(ip)) return fail(429, { name, error: 'Zu viele Fehlversuche — bitte eine Minute warten.' });

		const user = await checkLogin(db(), name, String(form.get('password') ?? ''));
		if (!user) return fail(400, { name, error: 'Name oder Passwort falsch.' });
		authLimiter.succeed(ip);
		setSessionCookie(cookies, url, createSession(db(), user.id));
		redirect(303, '/');
	}
};
