// Pairs a machine end to end: the code comes from the page, the real `kabai-studio runner pair` process trades it
// against the server under test, and "Trennen" revokes the credential that process stored.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerByCredential } from '../../src/lib/server/domain/runners.ts';
import { expect, open, test } from './fixtures.ts';

const ROOT = new URL('../..', import.meta.url);
const MACHINE = 'browser-suite-machine';

/** Runs the copied command with `node server.ts` in place of the installed `kabai-studio`, in a home of its own. */
function runCopiedCommand(command: string, home: string) {
	const [, ...args] = command.split(' ');
	const child = spawn(process.execPath, ['server.ts', ...args, '--name', MACHINE], {
		cwd: ROOT,
		env: {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: join(home, '.config'),
			LANG: 'de_DE.UTF-8'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (chunk: Buffer) => (output += chunk.toString()));
	return new Promise<{ exitCode: number | null; output: string }>((resolve) =>
		child.on('close', (exitCode) => resolve({ exitCode, output }))
	);
}

test('a machine pairs with the copied command, is listed as never connected, and "Trennen" revokes it', async ({
	page,
	db,
	baseURL
}) => {
	const home = mkdtempSync(join(tmpdir(), 'kabai-studio-runner-home-'));
	try {
		await open(page, '/settings/runners');
		await page.getByRole('button', { name: 'Rechner verbinden' }).focus();
		await page.keyboard.press('Enter');

		const dialog = page.getByRole('dialog', { name: 'Rechner verbinden' });
		const command = dialog.getByRole('textbox', { name: 'Befehl' });
		await expect(command).toBeFocused();
		await expect(command).toHaveCSS('outline-style', 'solid'); // visible focus
		await expect(dialog.getByRole('textbox')).toHaveCount(1); // exactly one command
		await expect(dialog.getByRole('button', { name: 'Befehl kopieren' })).toBeVisible();
		const copied = await command.inputValue();
		const [, code] = copied.match(/^kabai-studio runner pair \S+ ([A-HJ-NP-Z2-9]{8})$/) ?? [];
		expect(copied.split(' ')[3]).toBe(baseURL);
		await expect(dialog.locator('strong')).toHaveText(code);

		const pairing = await runCopiedCommand(copied, home);
		expect(pairing.output).toContain(`„${MACHINE}“`);
		expect(pairing.output).toContain('kabai-studio runner start');
		expect(pairing.exitCode).toBe(0);
		const credentialFile = join(home, '.config', 'kabai-studio', 'runner-credential.json');
		expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
		const { credential } = JSON.parse(readFileSync(credentialFile, 'utf8'));
		expect(runnerByCredential(db, credential)?.name).toBe(MACHINE);

		await page.keyboard.press('Escape');
		const row = page.getByRole('listitem').filter({ hasText: MACHINE });
		await expect(row).toContainText('noch nie verbunden');

		await row.getByRole('button', { name: 'Trennen' }).click();
		const sheet = page.getByRole('dialog', { name: `„${MACHINE}“ trennen?` });
		await expect(sheet.getByRole('button', { name: 'Abbrechen' })).toBeFocused(); // the safe answer
		await page.keyboard.press('Tab');
		await expect(sheet.getByRole('button', { name: 'Trennen' })).toBeFocused();
		await page.keyboard.press('Enter');

		await expect(row).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Rechner verbinden' })).toBeFocused();
		expect(runnerByCredential(db, credential)).toBeNull();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
