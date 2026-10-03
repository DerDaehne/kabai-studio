import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { DomainError } from '$lib/server/domain/core';
import { deleteProfile, getProfile, listProfiles } from '$lib/server/domain/runs';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({
	profiles: listProfiles(db()).map(({ id, name, provider, model, pool }) => ({
		id,
		name,
		provider,
		model,
		pool
	}))
});

export const actions: Actions = {
	delete: async ({ request }) => {
		const id = Number((await request.formData()).get('id'));
		try {
			const { name } = getProfile(db(), id);
			deleteProfile(db(), { kind: 'user' }, id);
			return { deleted: name };
		} catch (err) {
			if (!(err instanceof DomainError)) throw err;
			return fail(err.code === 'not_found' ? 404 : 409, {
				id,
				message: `${err.message} ${err.hint}`
			});
		}
	}
};
