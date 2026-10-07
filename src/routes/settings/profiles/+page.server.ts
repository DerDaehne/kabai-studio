import { db } from '$lib/server/db';
import { attempt } from '$lib/server/domain-failure';
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
		return attempt(
			() => {
				const { name } = getProfile(db(), id);
				deleteProfile(db(), { kind: 'user' }, id);
				return { deleted: name };
			},
			() => ({ id })
		);
	}
};
