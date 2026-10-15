import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { pairRunner, runnerByCredential } from '$lib/server/domain/runners';
import { actions, load } from './+page.server';

// A DB of its own in a temp directory; db() reads the directory only on its first call.
const dir = mkdtempSync(join(tmpdir(), 'studio-runners-route-'));
process.env.STUDIO_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const url = new URL('https://studio.example/settings/runners');

async function disconnect(id: number) {
	const body = new FormData();
	body.set('id', String(id));
	return actions.disconnect({ request: new Request(url, { method: 'POST', body }), url } as never);
}

it('offers exactly one command with the studio origin and a code that pairs once', async () => {
	const { pairing } = (await actions.connect({ url } as never)) as {
		pairing: { code: string; command: string };
	};
	expect(pairing.command).toBe(`kabai-studio runner pair https://studio.example ${pairing.code}`);

	const paired = pairRunner(db(), { code: pairing.code, name: 'laptop' });
	expect(await load({ depends: () => {} } as never)).toEqual({
		runners: [
			{
				id: paired.id,
				name: 'laptop',
				created_at: expect.any(String),
				last_seen_at: null,
				connection: null
			}
		]
	});
	expect(() => pairRunner(db(), { code: pairing.code, name: 'again' })).toThrow();
});

it('disconnecting revokes the credential and reports a machine that is already gone', async () => {
	const { pairing } = (await actions.connect({ url } as never)) as { pairing: { code: string } };
	const paired = pairRunner(db(), { code: pairing.code, name: 'desktop' });

	expect(await disconnect(paired.id)).toEqual({});
	expect(runnerByCredential(db(), paired.credential)).toBeNull();
	expect(await disconnect(paired.id)).toMatchObject({ status: 404, data: { id: paired.id } });
});
