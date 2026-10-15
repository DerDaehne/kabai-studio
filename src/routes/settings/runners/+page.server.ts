import { RUNNERS_DEPENDENCY } from '$lib/live';
import { db } from '$lib/server/db';
import { attempt } from '$lib/server/domain-failure';
import { disconnectRunner, issuePairingCode, listRunners } from '$lib/server/domain/runners';
import { runnerChannel } from '$lib/server/runner-channel';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends(RUNNERS_DEPENDENCY);
	const connected = runnerChannel().connected();
	return {
		runners: listRunners(db()).map((runner) => {
			const live = connected.get(runner.name);
			return {
				...runner,
				connection: live ? { ...live, connectedAt: new Date(live.connectedAt).toISOString() } : null
			};
		})
	};
};

export const actions: Actions = {
	connect: ({ url }) => {
		const { code } = issuePairingCode();
		return { pairing: { code, command: `kabai-studio runner pair ${url.origin} ${code}` } };
	},
	disconnect: async ({ request }) => {
		const id = Number((await request.formData()).get('id'));
		const name = listRunners(db()).find((runner) => runner.id === id)?.name;
		return attempt(
			() => {
				disconnectRunner(db(), id);
				if (name) runnerChannel().revoke(name);
			},
			() => ({ id })
		);
	}
};
