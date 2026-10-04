// Public by design (hooks.server.ts) — this test locks the response to exactly {ok, version, migration}, so a
// future change cannot leak a path, hostname or counter here.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { GET } from './+server';

const tmp = mkdtempSync(join(tmpdir(), 'studio-health-'));
process.env.STUDIO_DATA_DIR = tmp; // db() reads the directory on its first call
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

it('answers 200 with exactly ok, version and migration, nothing else', async () => {
	const res = await GET({} as never);
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(Object.keys(body).sort()).toEqual(['migration', 'ok', 'version']);
	expect(body).toEqual({
		ok: true,
		version: __STUDIO_VERSION__,
		migration: expect.stringMatching(/\.sql$/)
	});
});
