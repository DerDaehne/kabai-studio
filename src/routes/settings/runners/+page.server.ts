import { db } from '$lib/server/db';
import { attempt } from '$lib/server/domain-failure';
import { disconnectRunner, issuePairingCode, listRunners } from '$lib/server/domain/runners';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ runners: listRunners(db()) });

export const actions: Actions = {
	connect: ({ url }) => {
		const { code } = issuePairingCode();
		return { pairing: { code, command: `kabai-studio runner pair ${url.origin} ${code}` } };
	},
	disconnect: async ({ request }) => {
		const id = Number((await request.formData()).get('id'));
		return attempt(
			() => disconnectRunner(db(), id),
			() => ({ id })
		);
	}
};
