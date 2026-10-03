import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { DomainError } from '$lib/server/domain/core';
import { deleteSecret, listSecrets, setSecret } from '$lib/server/secrets';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ secrets: listSecrets(db()) });

// Antworten enthalten nie den Wert — auch nicht bei Fehlern oder zum Wiederbefüllen (das Feld behält ihn im Browser).
// `field` ordnet die Antwort dem Secret-Feld zu: Name eines vorhandenen Secrets, '' für „neu“.
export const actions: Actions = {
	setSecret: async ({ request }) => {
		const form = await request.formData();
		const field = String(form.get('field') ?? '');
		try {
			setSecret(
				db(),
				String(form.get('name') ?? ''),
				String(form.get('value') ?? ''),
				form.get('replace') === '1'
			);
		} catch (err) {
			if (err instanceof DomainError)
				return fail(400, { field, code: err.code, message: err.message, hint: err.hint });
			throw err;
		}
		return { field };
	},
	deleteSecret: async ({ request }) => {
		const field = String((await request.formData()).get('field') ?? '');
		deleteSecret(db(), field);
		return { field };
	}
};
