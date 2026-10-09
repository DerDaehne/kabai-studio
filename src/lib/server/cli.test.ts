import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	CliUsageError,
	type CommandRunner,
	findFreePort,
	launchdPlist,
	launchdPlistPath,
	parseCliArgs,
	runServiceCommand,
	systemdUnit,
	systemdUnitPath
} from './cli.ts';

describe('parseCliArgs', () => {
	it('defaults to start when no subcommand is given', () => {
		expect(parseCliArgs([])).toEqual({ kind: 'start' });
	});

	it('parses --version', () => {
		expect(parseCliArgs(['--version'])).toEqual({ kind: 'version' });
	});

	it('parses restore with its file argument', () => {
		expect(parseCliArgs(['restore', '/tmp/x.db'])).toEqual({ kind: 'restore', file: '/tmp/x.db' });
	});

	it('parses service install with --print', () => {
		expect(parseCliArgs(['service', 'install', '--print'])).toEqual({
			kind: 'service',
			action: 'install',
			print: true
		});
	});

	it('rejects an unknown subcommand with a usage error', () => {
		expect(() => parseCliArgs(['bogus'])).toThrow(CliUsageError);
	});

	it('rejects an unknown service subcommand with a usage error', () => {
		expect(() => parseCliArgs(['service', 'bogus'])).toThrow(CliUsageError);
	});
});

describe('findFreePort', () => {
	it('returns the requested port when it is free', async () => {
		const port = await findFreePort(21345, '127.0.0.1');
		expect(port).toBe(21345);
	});

	it('returns the next free port when the requested one is occupied', async () => {
		const occupied = createServer();
		await new Promise<void>((resolve) => occupied.listen(21346, '127.0.0.1', resolve));
		try {
			const port = await findFreePort(21346, '127.0.0.1');
			expect(port).toBe(21347);
		} finally {
			await new Promise<void>((resolve) => occupied.close(() => resolve()));
		}
	});

	it('fails with a plain-text message when no port is free in range', async () => {
		const blockers = [createServer(), createServer()];
		await Promise.all(
			blockers.map((s, i) => new Promise<void>((resolve) => s.listen(21350 + i, '127.0.0.1', resolve)))
		);
		try {
			await expect(findFreePort(21350, '127.0.0.1', 2)).rejects.toThrow(/Keine freien Ports/);
		} finally {
			await Promise.all(blockers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
		}
	});
});

describe('service unit content', () => {
	const ctx = {
		env: {},
		execPath: '/usr/bin/node',
		entryPath: '/opt/kabai-studio/server.ts',
		dataDir: '/home/x/.local/share/kabai-studio'
	};

	it('systemd unit sets ExecStart, the data dir and Restart=on-failure', () => {
		const unit = systemdUnit(ctx);
		expect(unit).toContain('ExecStart=/usr/bin/node /opt/kabai-studio/server.ts');
		expect(unit).toContain('Environment=STUDIO_DATA_DIR=/home/x/.local/share/kabai-studio');
		expect(unit).toContain('Restart=on-failure');
		expect(unit).toContain('WantedBy=default.target');
	});

	it('launchd plist sets ProgramArguments, the data dir and RunAtLoad', () => {
		const plist = launchdPlist(ctx);
		expect(plist).toContain('<string>/usr/bin/node</string>');
		expect(plist).toContain('<string>/opt/kabai-studio/server.ts</string>');
		expect(plist).toContain('/home/x/.local/share/kabai-studio');
		expect(plist).toContain('<key>RunAtLoad</key><true/>');
	});

	it('places the systemd unit under XDG_CONFIG_HOME/systemd/user', () => {
		expect(systemdUnitPath({ XDG_CONFIG_HOME: '/custom/xdg' })).toBe(
			'/custom/xdg/systemd/user/kabai-studio.service'
		);
	});

	it('places the launchd agent under ~/Library/LaunchAgents', () => {
		expect(launchdPlistPath({ HOME: '/Users/x' })).toContain('/Users/x/Library/LaunchAgents/');
	});
});

describe('runServiceCommand', () => {
	let dir: string;
	beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'kabai-studio-service-'))));
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const ctx = (dir: string) => ({
		env: { XDG_CONFIG_HOME: dir, HOME: dir },
		execPath: '/usr/bin/node',
		entryPath: '/opt/kabai-studio/server.ts',
		dataDir: join(dir, 'data')
	});

	it('install --print never touches the filesystem or calls a real command', () => {
		const calls: string[] = [];
		const run: CommandRunner = (cmd) => {
			calls.push(cmd);
			return { status: 0, stdout: '' };
		};
		const result = runServiceCommand('install', true, 'linux', ctx(dir), run);
		expect(result.exitCode).toBe(0);
		expect(result.message).toContain('ExecStart=');
		expect(calls).toEqual([]);
	});

	it('install writes the unit file and calls systemctl enable through the injected runner', () => {
		const calls: string[][] = [];
		const run: CommandRunner = (cmd, args) => {
			calls.push([cmd, ...args]);
			return { status: 0, stdout: '' };
		};
		const result = runServiceCommand('install', false, 'linux', ctx(dir), run);
		expect(result.exitCode).toBe(0);
		const path = systemdUnitPath(ctx(dir).env);
		expect(readFileSync(path, 'utf8')).toContain('ExecStart=');
		expect(calls).toContainEqual(['systemctl', '--user', 'enable', 'kabai-studio']);
	});

	it('install fails with exit code 1 and a plain-text way out when systemd is unavailable', () => {
		const run: CommandRunner = () => ({ status: null, stdout: '' });
		const result = runServiceCommand('install', false, 'linux', ctx(dir), run);
		expect(result.exitCode).toBe(1);
		expect(result.message).toMatch(/nicht verfügbar/);
	});

	it('status reports one sentence that the service is not running, with a next step', () => {
		const run: CommandRunner = () => ({ status: 0, stdout: 'inactive\n' });
		const result = runServiceCommand('status', false, 'linux', ctx(dir), run);
		expect(result.exitCode).toBe(0);
		expect(result.message).toContain('läuft nicht');
		expect(result.message).toMatch(/journalctl|service install/);
	});

	it('status reports the service as running when systemctl says active', () => {
		const run: CommandRunner = () => ({ status: 0, stdout: 'active\n' });
		const result = runServiceCommand('status', false, 'linux', ctx(dir), run);
		expect(result.message).toContain('läuft');
		expect(result.message).not.toContain('läuft nicht');
	});

	it('uninstall removes the unit file written by install', () => {
		const run: CommandRunner = () => ({ status: 0, stdout: '' });
		runServiceCommand('install', false, 'linux', ctx(dir), run);
		const result = runServiceCommand('uninstall', false, 'linux', ctx(dir), run);
		expect(result.exitCode).toBe(0);
		expect(() => readFileSync(systemdUnitPath(ctx(dir).env), 'utf8')).toThrow();
	});

	it('install fails with a plain-text message, not a crash, when the unit directory cannot be created', () => {
		writeFileSync(join(dir, 'systemd'), 'not a directory'); // blocks mkdirSync(.../systemd/user) with ENOTDIR
		const run: CommandRunner = () => ({ status: 0, stdout: '' });
		const result = runServiceCommand('install', false, 'linux', ctx(dir), run);
		expect(result.exitCode).toBe(1);
		expect(result.message.split('\n')).toHaveLength(1);
		expect(result.message).not.toContain('at '); // no stack trace frame
	});

	it('refuses an unsupported platform with exit code 1', () => {
		const result = runServiceCommand('install', false, 'win32', ctx(dir));
		expect(result.exitCode).toBe(1);
		expect(result.message).toContain('win32');
	});
});
