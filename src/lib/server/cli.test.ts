import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	CliUsageError,
	type CommandRunner,
	findFreePort,
	launchdPlist,
	launchdPlistPath,
	parseCliArgs,
	runServiceCommand,
	runnerServiceProfile,
	systemdUnit,
	systemdUnitPath
} from './cli.ts';
import { localeFromEnv, translate } from '../i18n/index.ts';

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

	it('parses runner start without arguments', () => {
		expect(parseCliArgs(['runner', 'start'])).toEqual({ kind: 'runner-start' });
	});

	it('parses runner pair with address, code and an optional --name', () => {
		expect(parseCliArgs(['runner', 'pair', 'https://studio.example', 'ABCD2345'])).toEqual({
			kind: 'runner-pair',
			url: 'https://studio.example',
			code: 'ABCD2345',
			name: undefined
		});
		expect(
			parseCliArgs(['runner', 'pair', 'https://studio.example', 'ABCD2345', '--name', 'laptop'])
		).toMatchObject({ kind: 'runner-pair', name: 'laptop' });
	});

	it.each([
		['no action', ['runner']],
		['an unknown action', ['runner', 'stop']],
		['start with an argument', ['runner', 'start', 'https://studio.example']],
		['no code', ['runner', 'pair', 'https://studio.example']],
		['an extra argument', ['runner', 'pair', 'https://studio.example', 'ABCD2345', 'more']],
		['--name without a value', ['runner', 'pair', 'https://studio.example', 'ABCD2345', '--name']],
		['an unknown option', ['runner', 'pair', 'https://studio.example', 'ABCD2345', '--force']]
	])('rejects runner with %s with a coded usage error and the way out', (_, argv) => {
		// cli.ts picks its language from LANG at load time, so the hint is expected in that same language.
		const hint = translate(localeFromEnv(process.env), 'cli.runner.usage.hint');
		expect(() => parseCliArgs(argv)).toThrow(/^\[invalid_arguments\] .*kabai-studio runner pair /);
		expect(() => parseCliArgs(argv)).toThrow(hint);
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
			blockers.map(
				(s, i) => new Promise<void>((resolve) => s.listen(21350 + i, '127.0.0.1', resolve))
			)
		);
		try {
			await expect(findFreePort(21350, '127.0.0.1', 2)).rejects.toThrow(/Keine freien Ports/);
		} finally {
			await Promise.all(
				blockers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
			);
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

	it('uninstall fails with a plain-text message, not a crash, when the unit file cannot be removed', () => {
		const run: CommandRunner = () => ({ status: 0, stdout: '' });
		runServiceCommand('install', false, 'linux', ctx(dir), run);
		const unitDir = dirname(systemdUnitPath(ctx(dir).env));
		chmodSync(unitDir, 0o500); // directory not writable: rmSync(force:true) still throws EACCES
		try {
			const result = runServiceCommand('uninstall', false, 'linux', ctx(dir), run);
			expect(result.exitCode).toBe(1);
			expect(result.message.split('\n')).toHaveLength(1);
		} finally {
			chmodSync(unitDir, 0o700); // afterEach's rmSync(dir) needs write access back
		}
	});

	it('refuses an unsupported platform with exit code 1', () => {
		const result = runServiceCommand('install', false, 'win32', ctx(dir));
		expect(result.exitCode).toBe(1);
		expect(result.message).toContain('win32');
	});
});

describe('CLI language', () => {
	const SERVER_ENTRY = fileURLToPath(new URL('../../../server.ts', import.meta.url));
	const cli = (args: string[], env: Record<string, string>) =>
		spawnSync(process.execPath, [SERVER_ENTRY, ...args], {
			env: { ...process.env, LC_ALL: undefined, LC_MESSAGES: undefined, LANG: undefined, ...env },
			encoding: 'utf8'
		});

	it('speaks English with LANG=en_US.UTF-8, in the help and in a usage error', () => {
		expect(cli(['--help'], { LANG: 'en_US.UTF-8' }).stdout).toMatch(/^Usage: kabai-studio \[/);
		const unknown = cli(['bogus'], { LANG: 'en_US.UTF-8' });
		expect(unknown.status).toBe(1);
		expect(unknown.stderr).toMatch(/^Unknown subcommand “bogus”\. Usage: kabai-studio \[/);
	});

	it('speaks German with LANG=de_DE.UTF-8', () => {
		expect(cli(['--help'], { LANG: 'de_DE.UTF-8' }).stdout).toMatch(/^Verwendung: kabai-studio \[/);
	});
});

describe('parseCliArgs runner service', () => {
	it.each(['install', 'uninstall', 'status'] as const)('parses runner service %s', (action) => {
		expect(parseCliArgs(['runner', 'service', action])).toEqual({
			kind: 'runner-service',
			action,
			print: false
		});
	});

	it('parses --print', () => {
		expect(parseCliArgs(['runner', 'service', 'install', '--print'])).toMatchObject({
			kind: 'runner-service',
			print: true
		});
	});

	it.each([
		['no action', ['runner', 'service']],
		['an unknown action', ['runner', 'service', 'bogus']],
		['an extra argument', ['runner', 'service', 'install', 'more']],
		['--print on start', ['runner', 'start', '--print']]
	])('rejects %s with a coded usage error', (_, argv) => {
		expect(() => parseCliArgs(argv)).toThrow(/^\[invalid_arguments\] /);
	});
});

describe('runner service', () => {
	let dir: string;
	beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'kabai-studio-runner-service-'))));
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const ctx = (extraEnv: Record<string, string> = {}) => ({
		env: { HOME: dir, ...extraEnv },
		execPath: '/usr/bin/node',
		entryPath: '/opt/kabai-studio/server.ts',
		dataDir: ''
	});
	const profile = (locale: 'en' | 'de' = 'en', refusal?: string) =>
		runnerServiceProfile(locale, () => (refusal ? { exitCode: 1, message: refusal } : undefined));
	const recorder = (stdout = ''): { calls: string[][]; run: CommandRunner } => {
		const calls: string[][] = [];
		return {
			calls,
			run: (cmd, args) => {
				calls.push([cmd, ...args]);
				return { status: 0, stdout };
			}
		};
	};
	const unitPath = () => systemdUnitPath({ HOME: dir }, 'kabai-studio-runner');
	const plistPath = () => launchdPlistPath({ HOME: dir }, 'studio.kabai.kabai-studio-runner');

	it('prints a systemd unit that runs runner start and waits 30 s between restarts', () => {
		const { calls, run } = recorder();
		const result = runServiceCommand('install', true, 'linux', ctx(), run, profile());
		expect(result.message).toContain(
			'ExecStart=/usr/bin/node /opt/kabai-studio/server.ts runner start'
		);
		expect(result.message).toContain('Restart=on-failure');
		expect(result.message).toContain('RestartSec=30');
		expect(result.message).toContain('WantedBy=default.target');
		expect(result.message).not.toContain('XDG_CONFIG_HOME');
		expect(calls).toEqual([]);
		expect(existsSync(dir + '/.config')).toBe(false);
	});

	it('passes XDG_CONFIG_HOME on only when it is set', () => {
		const result = runServiceCommand(
			'install',
			true,
			'linux',
			ctx({ XDG_CONFIG_HOME: '/custom/xdg' }),
			recorder().run,
			profile()
		);
		expect(result.message).toContain('Environment=XDG_CONFIG_HOME=/custom/xdg');
	});

	it('prints a launchd plist that keeps the runner alive with a 30 s throttle', () => {
		const result = runServiceCommand('install', true, 'darwin', ctx(), recorder().run, profile());
		expect(result.message).toContain('studio.kabai.kabai-studio-runner');
		expect(result.message).toContain('<string>runner</string>\n\t\t<string>start</string>');
		expect(result.message).toContain('<key>RunAtLoad</key><true/>');
		expect(result.message).toContain('<key>KeepAlive</key><true/>');
		expect(result.message).toContain('<key>ThrottleInterval</key><integer>30</integer>');
	});

	it.each([['linux'], ['darwin']])(
		'install on %s writes nothing and runs no command when the pairing check fails',
		(platform) => {
			const { calls, run } = recorder();
			const refusal = '[not_paired] This machine is not paired yet. Pair it first.';
			const result = runServiceCommand(
				'install',
				false,
				platform,
				ctx(),
				run,
				profile('en', refusal)
			);
			expect(result).toEqual({ exitCode: 1, message: refusal });
			expect(calls).toEqual([]);
			expect(existsSync(unitPath())).toBe(false);
			expect(existsSync(plistPath())).toBe(false);
		}
	);

	it('install writes the unit 0600, reloads, enables without --now and names one start command', () => {
		const { calls, run } = recorder();
		const result = runServiceCommand('install', false, 'linux', ctx(), run, profile());
		expect(result.exitCode).toBe(0);
		expect(statSync(unitPath()).mode & 0o777).toBe(0o600);
		expect(calls).toContainEqual(['systemctl', '--user', 'daemon-reload']);
		expect(calls).toContainEqual(['systemctl', '--user', 'enable', 'kabai-studio-runner']);
		expect(calls.flat()).not.toContain('--now');
		expect(result.message).toContain('systemctl --user start kabai-studio-runner');
		expect(result.message).toContain('loginctl enable-linger');
	});

	it('install writes the plist 0600 and loads it on macOS', () => {
		const { calls, run } = recorder();
		const result = runServiceCommand('install', false, 'darwin', ctx(), run, profile());
		expect(result.exitCode).toBe(0);
		expect(statSync(plistPath()).mode & 0o777).toBe(0o600);
		expect(calls).toContainEqual(['launchctl', 'load', plistPath()]);
	});

	it('uninstall disables --now and removes the file on Linux and macOS', () => {
		const { calls, run } = recorder();
		runServiceCommand('install', false, 'linux', ctx(), run, profile());
		runServiceCommand('install', false, 'darwin', ctx(), run, profile());
		runServiceCommand('uninstall', false, 'linux', ctx(), run, profile());
		runServiceCommand('uninstall', false, 'darwin', ctx(), run, profile());
		expect(calls).toContainEqual([
			'systemctl',
			'--user',
			'disable',
			'--now',
			'kabai-studio-runner'
		]);
		expect(calls).toContainEqual(['launchctl', 'unload', plistPath()]);
		expect(existsSync(unitPath())).toBe(false);
		expect(existsSync(plistPath())).toBe(false);
	});

	it('status says running or not running and names the way out', () => {
		const running = runServiceCommand(
			'status',
			false,
			'linux',
			ctx(),
			recorder('active\n').run,
			profile()
		);
		expect(running.message).toMatch(/is running/);
		const stopped = runServiceCommand(
			'status',
			false,
			'linux',
			ctx(),
			recorder('inactive\n').run,
			profile()
		);
		expect(stopped.message).toContain('not running');
		expect(stopped.message).toContain('journalctl --user -u kabai-studio-runner');
		const mac = runServiceCommand(
			'status',
			false,
			'darwin',
			ctx(),
			() => ({ status: 113, stdout: '' }),
			profile()
		);
		expect(mac.message).toContain('runner service install');
		const de = runServiceCommand(
			'status',
			false,
			'linux',
			ctx(),
			recorder('active\n').run,
			profile('de')
		);
		expect(de.message).toContain('läuft');
	});

	it('leaves the studio service texts and unit content untouched', () => {
		const result = runServiceCommand('status', false, 'linux', ctx(), recorder('active\n').run);
		expect(result.message).toBe('kabai studio läuft (systemd-User-Dienst aktiv).');
	});

	it('has every runner service text in both catalogues, with failures as one line', () => {
		const ids = [
			'unavailable.systemd',
			'unavailable.launchd',
			'noStatus',
			'fs.write',
			'fs.remove',
			'installed.systemd',
			'installed.launchd',
			'none.systemd',
			'none.launchd',
			'removed.systemd',
			'removed.launchd',
			'running.systemd',
			'running.launchd',
			'stopped.systemd',
			'stopped.launchd',
			'unsupported'
		] as const;
		for (const locale of ['en', 'de'] as const) {
			const { say } = profile(locale);
			for (const id of ids) {
				const text = say(id, { path: '/p', code: 'EACCES', platform: 'win32' });
				expect(text).not.toBe(`cli.runner.service.${id}`);
				expect(text).not.toContain('\n');
			}
		}
	});
});
