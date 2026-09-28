import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE, clearSessionCookie, deleteSession } from '$lib/server/auth';
import { db } from '$lib/server/db';
import type { RequestHandler } from './$types';

// Nur POST (Formular) — SvelteKits Origin-Check schützt es gegen CSRF.
export const POST: RequestHandler = ({ cookies, url }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (token) deleteSession(db(), token);
	clearSessionCookie(cookies, url);
	redirect(303, '/login');
};
