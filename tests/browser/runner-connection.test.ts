// A paired machine runs the real `kabai-studio runner start` process against the server under test: the page shows it
// live, "Trennen" ends it, and the subcommand needs neither the database nor a listening port.
import { spawn, type ChildProcess } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	disconnectRunner,
	issuePairingCode,
	pairRunner
} from '../../src/lib/server/domain/runners.ts';
import { expect, open, test } from './fixtures.ts';

const ROOT = new URL('../..', import.meta.url);
const MACHINE = 'browser-suite-connected-machine';

type Machine = { home: string; credential: string; start: () => Runner };
type Runner = { child: ChildProcess; output: () => string; exit: Promise<number | null> };

/** A home directory holding what `runner pair` would have left behind for a machine paired in the test's own process. */
function pairedMachine(
	db: Parameters<typeof pairRunner>[0],
	baseURL: string
): Machine & { id: number } {
	const home = mkdtempSync(join(tmpdir(), 'kabai-studio-runner-connection-'));
	const configDir = join(home, '.config', 'kabai-studio');
	const workspace = join(home, 'workspace');
	mkdirSync(configDir, { recursive: true });
	mkdirSync(workspace);
	const { id, credential } = pairRunner(db, { code: issuePairingCode().code, name: MACHINE });
	writeFileSync(
		join(configDir, 'runner-credential.json'),
		JSON.stringify({ studioOrigin: baseURL, name: MACHINE, credential }),
		{ mode: 0o600 }
	);
	writeFileSync(
		join(configDir, 'runner.json'),
		JSON.stringify({
			studioOrigin: baseURL,
			slots: 2,
			workspaces: { site: { path: workspace } },
			agents: { claude: { command: 'claude-agent-acp' } }
		})
	);
	const start = () => spawnRunner(home, {});
	return { id, home, credential, start };
}

function spawnRunner(
	home: string,
	extraEnv: Record<string, string>,
	nodeArgs: string[] = []
): Runner {
	const child = spawn(process.execPath, [...nodeArgs, 'server.ts', 'runner', 'start'], {
		cwd: ROOT,
		env: {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: join(home, '.config'),
			STUDIO_DATA_DIR: join(home, 'must-stay-absent'),
			LANG: 'de_DE.UTF-8',
			...extraEnv
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (chunk: Buffer) => (output += chunk.toString()));
	const exit = new Promise<number | null>((resolve) => child.on('close', resolve));
	return { child, output: () => output, exit };
}

/** True when the process holds a socket that listens (state 0A in /proc/net/tcp*). */
function listensOnAPort(pid: number): boolean {
	const inodes = new Set(
		readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
			const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
			return target.startsWith('socket:[') ? [target.slice(8, -1)] : [];
		})
	);
	return ['tcp', 'tcp6'].some((table) =>
		readFileSync(`/proc/net/${table}`, 'utf8')
			.split('\n')
			.slice(1)
			.some((row) => {
				const columns = row.trim().split(/\s+/);
				return columns[3] === '0A' && inodes.has(columns[9]);
			})
	);
}

test('the page follows a runner live: connected with slots, workspaces and agents, then not connected; "Trennen" ends it', async ({
	page,
	db,
	baseURL
}) => {
	const machine = pairedMachine(db, baseURL!);
	let runner: Runner | undefined;
	try {
		await open(page, '/settings/runners');
		const row = page.getByRole('listitem').filter({ hasText: MACHINE });
		await expect(row).toContainText('noch nie verbunden');

		runner = machine.start();
		await expect(row).toContainText('verbunden seit');
		await expect(row).toContainText('Slots: 2 · Workspaces: site · Agents: claude');
		expect(runner.output()).toContain(`Verbunden mit ${baseURL} als „${MACHINE}“.`);

		runner.child.kill('SIGTERM');
		expect(await runner.exit).toBe(0);
		await expect(row).toContainText('nicht verbunden seit');
		await expect(row).toContainText('kabai-studio runner start');

		runner = machine.start();
		await expect(row).toContainText('verbunden seit');
		await row.getByRole('button', { name: 'Trennen' }).click();
		await page.getByRole('dialog').getByRole('button', { name: 'Trennen' }).click();

		expect(await runner.exit).toBe(1);
		expect(runner.output()).toContain('[credential_revoked]');
		expect(runner.output()).toContain(`kabai-studio runner pair ${baseURL} <Code>`);
		expect(runner.output()).not.toContain(machine.credential);
	} finally {
		runner?.child.kill('SIGKILL');
		try {
			disconnectRunner(db, machine.id);
		} catch {
			// already disconnected through the page
		}
		rmSync(machine.home, { recursive: true, force: true });
	}
});

test('runner start loads neither the database nor the server bundle and listens on no port', async ({
	db,
	baseURL
}) => {
	const machine = pairedMachine(db, baseURL!);
	const record = join(machine.home, 'imports.txt');
	const loader = new URL('./record-imports.mjs', import.meta.url).pathname;
	const runner = spawnRunner(machine.home, { RECORD_IMPORTS_TO: record }, ['--import', loader]);
	try {
		await expect.poll(() => runner.output()).toContain('Verbunden mit');
		const imported = readFileSync(record, 'utf8');
		expect(imported).toContain('/src/lib/server/runner-start.ts');
		expect(imported).not.toMatch(/\/server\/db\.ts$/m);
		expect(imported).not.toContain('/build/index.js');
		expect(existsSync(join(machine.home, 'must-stay-absent'))).toBe(false);
		expect(listensOnAPort(runner.child.pid!)).toBe(false);
	} finally {
		runner.child.kill('SIGKILL');
		disconnectRunner(db, machine.id);
		rmSync(machine.home, { recursive: true, force: true });
	}
});
