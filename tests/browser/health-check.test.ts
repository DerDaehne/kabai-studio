// Proves the Dockerfile's HEALTHCHECK command — read literally out of the Dockerfile, never retyped — reports
// healthy against the real built server. Docker itself is unavailable in this environment.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function healthcheckCommand(): string[] {
	const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
	const cmd = dockerfile.match(/HEALTHCHECK[\s\S]*?CMD (\[[\s\S]*?\])\r?\n/)?.[1];
	if (!cmd) throw new Error('Dockerfile has no HEALTHCHECK CMD to extract');
	return JSON.parse(cmd) as string[];
}

test('the Dockerfile HEALTHCHECK command reports healthy against the running server', async ({
	baseURL
}) => {
	const [node, flag, script] = healthcheckCommand();
	expect(script).toContain('/api/health'); // not the old /login probe

	expect(() =>
		execFileSync(node, [flag, script], {
			env: { ...process.env, PORT: new URL(baseURL!).port }
		})
	).not.toThrow(); // the script itself calls process.exit(1) (and throws here) on anything but a healthy answer
});
