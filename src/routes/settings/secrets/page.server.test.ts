import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { resolveRef } from '$lib/server/secrets';
import { actions, load } from './+page.server';

// A DB and key of its own in a temp directory; db() and secretKey() read them only on the first call.
const dir = mkdtempSync(join(tmpdir(), 'studio-secrets-route-'));
process.env.STUDIO_DATA_DIR = dir;
delete process.env.STUDIO_SECRET_KEY;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const VALUE = 'test-token-route-0001';

async function post(action: keyof typeof actions, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const request = new Request('http://localhost/settings/secrets', { method: 'POST', body });
	return actions[action]({ request } as never);
}

it('never returns secret values from any endpoint — neither load nor actions, not even on errors', async () => {
	const responses = [
		await post('setSecret', { field: '', name: 'demo', value: VALUE }),
		await post('setSecret', { field: '', name: 'demo', value: VALUE }), // already exists
		await post('setSecret', { field: '', name: VALUE, value: VALUE }), // key in both fields
		await post('setSecret', {
			field: 'demo',
			name: 'demo',
			value: VALUE.slice(0, 5),
			replace: '1'
		}), // too short
		await post('setSecret', { field: 'demo', name: 'demo', value: `${VALUE}-neu`, replace: '1' }),
		await load({} as never)
	];
	expect(resolveRef(db(), 'secret:demo')).toBe(`${VALUE}-neu`); // so it was stored
	responses.push(await post('deleteSecret', { field: 'demo' }), await load({} as never));

	const wire = JSON.stringify(responses);
	expect(wire).not.toContain(VALUE.slice(0, 5)); // a prefix covers the full value, the replaced one and the too short fragment
	expect(
		responses.map((r) =>
			r && 'status' in r ? `${r.status}:${(r.data as { code: string }).code}` : 'ok'
		)
	).toEqual([
		'ok',
		'400:secret_exists',
		'400:secret_name_is_value',
		'400:secret_too_short',
		'ok',
		'ok',
		'ok',
		'ok'
	]);
	expect(responses[5]).toEqual({
		secrets: [{ name: 'demo', created_at: expect.any(String), updated_at: expect.any(String) }]
	});
	expect(responses[7]).toEqual({ secrets: [] });
});
