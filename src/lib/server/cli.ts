// The `kabai-studio` CLI: argument parsing, the free-port probe for `start`, and the systemd/
// launchd `service` subcommand. Kept separate from server.ts so the logic here is unit-testable
// without spawning a real process.
import { parseArgs } from 'node:util';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class CliUsageError extends Error {}

export type ServiceAction = 'install' | 'uninstall' | 'status';

export type Command =
	| { kind: 'start' }
	| { kind: 'service'; action: ServiceAction; print: boolean }
	| { kind: 'reset-password' }
	| { kind: 'restore'; file?: string }
	| { kind: 'version' }
	| { kind: 'help' };

const SERVICE_ACTIONS = new Set<string>(['install', 'uninstall', 'status']);
const HELP =
	'Verwendung: kabai-studio [start|service <install|uninstall|status>|reset-password|restore <datei>|--version]';

/** Pure so the error contract (unknown command/subcommand) is testable without spawning a process. */
export function parseCliArgs(argv: string[]): Command {
	const [sub, ...rest] = argv;
	if (sub === '--version' || sub === '-v') return { kind: 'version' };
	if (sub === '--help' || sub === '-h') return { kind: 'help' };
	if (sub === undefined || sub === 'start') return { kind: 'start' };
	if (sub === 'reset-password') return { kind: 'reset-password' };
	if (sub === 'restore') return { kind: 'restore', file: rest[0] };
	if (sub === 'service') return parseServiceArgs(rest);
	throw new CliUsageError(`Unbekanntes Unterkommando „${sub}“. ${HELP}`);
}

function parseServiceArgs(rest: string[]): Command {
	const { values, positionals } = parseArgs({
		args: rest,
		options: { print: { type: 'boolean', default: false } },
		allowPositionals: true
	});
	const action = positionals[0];
	if (!action || !SERVICE_ACTIONS.has(action))
		throw new CliUsageError(
			`Unbekanntes service-Unterkommando „${action ?? ''}“. Verfügbar: install, uninstall, status.`
		);
	return { kind: 'service', action: action as ServiceAction, print: values.print === true };
}

/**
 * The first free port at or after `startPort` on `host`. A pre-start probe, not a hold: another
 * process could still grab the port between this check and the real listen() — acceptable for a
 * single-user host app.
 * ponytail: TOCTOU race between the probe and the real listen(); add a retry-on-EADDRINUSE around
 * the real listen() if this ever matters in practice.
 */
export async function findFreePort(
	startPort: number,
	host: string,
	maxAttempts = 20
): Promise<number> {
	for (let port = startPort; port < startPort + maxAttempts; port++) {
		if (await isPortFree(port, host)) return port;
	}
	throw new Error(
		`Keine freien Ports zwischen ${startPort} und ${startPort + maxAttempts - 1} auf ${host} gefunden. ` +
			`Mit PORT=<port> einen anderen Bereich wählen.`
	);
}

function isPortFree(port: number, host: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.once('error', () => resolve(false));
		probe.listen(port, host, () => probe.close(() => resolve(true)));
	});
}

// --- service install/uninstall/status (systemd user unit on Linux, launchd agent on macOS) ---

export type ServiceContext = {
	env: Record<string, string | undefined>;
	execPath: string;
	entryPath: string;
	dataDir: string;
};

export type ServiceResult = { exitCode: number; message: string };

export type CommandRunner = (
	cmd: string,
	args: string[]
) => { status: number | null; stdout: string };

/** The real runner, used in production; tests inject a fake one so no real unit is ever touched. */
export const realRunner: CommandRunner = (cmd, args) => {
	const r = spawnSync(cmd, args, { encoding: 'utf8' });
	return { status: r.status, stdout: r.stdout ?? '' };
};

const SYSTEMD_LABEL = 'kabai-studio';
const LAUNCHD_LABEL = 'studio.kabai.kabai-studio';

export const systemdUnitPath = (env: Record<string, string | undefined>): string =>
	join(env.XDG_CONFIG_HOME || join(env.HOME || '', '.config'), 'systemd', 'user', 'kabai-studio.service');

export const launchdPlistPath = (env: Record<string, string | undefined>): string =>
	join(env.HOME || '', 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);

export function systemdUnit(ctx: ServiceContext): string {
	return [
		'[Unit]',
		'Description=kabai studio',
		'After=network.target',
		'',
		'[Service]',
		`ExecStart=${ctx.execPath} ${ctx.entryPath}`,
		`Environment=STUDIO_DATA_DIR=${ctx.dataDir}`,
		'Restart=on-failure',
		'',
		'[Install]',
		'WantedBy=default.target',
		''
	].join('\n');
}

export function launchdPlist(ctx: ServiceContext): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${ctx.execPath}</string>
		<string>${ctx.entryPath}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>STUDIO_DATA_DIR</key><string>${ctx.dataDir}</string>
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

const UNAVAILABLE = {
	systemd: 'systemd ist auf diesem Host nicht verfügbar. Mit --print lässt sich die Unit-Datei trotzdem ansehen.',
	launchd: 'launchd ist auf diesem Host nicht verfügbar. Mit --print lässt sich die plist-Datei trotzdem ansehen.'
};

function installSystemd(ctx: ServiceContext, print: boolean, run: CommandRunner): ServiceResult {
	const unit = systemdUnit(ctx);
	if (print) return { exitCode: 0, message: unit };
	if (run('systemctl', ['--version']).status !== 0)
		return { exitCode: 1, message: UNAVAILABLE.systemd };
	const path = systemdUnitPath(ctx.env);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, unit, { mode: 0o600 });
	run('systemctl', ['--user', 'daemon-reload']);
	run('systemctl', ['--user', 'enable', SYSTEMD_LABEL]);
	return {
		exitCode: 0,
		message:
			`systemd-User-Unit installiert: ${path}. ` +
			`Für Autostart auch ohne aktive Anmeldung: „loginctl enable-linger $(whoami)“.`
	};
}

function uninstallSystemd(ctx: ServiceContext, run: CommandRunner): ServiceResult {
	const path = systemdUnitPath(ctx.env);
	if (!existsSync(path)) return { exitCode: 0, message: 'Keine systemd-User-Unit installiert — nichts zu tun.' };
	run('systemctl', ['--user', 'disable', '--now', SYSTEMD_LABEL]);
	rmSync(path, { force: true });
	run('systemctl', ['--user', 'daemon-reload']);
	return { exitCode: 0, message: `systemd-User-Unit entfernt: ${path}.` };
}

function statusSystemd(run: CommandRunner): ServiceResult {
	const r = run('systemctl', ['--user', 'is-active', SYSTEMD_LABEL]);
	if (r.status === null) return { exitCode: 1, message: `${UNAVAILABLE.systemd} Kein Status abrufbar.` };
	if (r.stdout.trim() === 'active')
		return { exitCode: 0, message: 'kabai studio läuft (systemd-User-Dienst aktiv).' };
	return {
		exitCode: 0,
		message:
			'kabai studio läuft nicht. Logs ansehen: „journalctl --user -u kabai-studio“ — ' +
			'oder „kabai-studio service install“ erneut ausführen.'
	};
}

function installLaunchd(ctx: ServiceContext, print: boolean, run: CommandRunner): ServiceResult {
	const plist = launchdPlist(ctx);
	if (print) return { exitCode: 0, message: plist };
	if (run('launchctl', ['list']).status !== 0) return { exitCode: 1, message: UNAVAILABLE.launchd };
	const path = launchdPlistPath(ctx.env);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, plist, { mode: 0o600 });
	run('launchctl', ['load', path]);
	return { exitCode: 0, message: `launchd-Agent installiert: ${path}.` };
}

function uninstallLaunchd(ctx: ServiceContext, run: CommandRunner): ServiceResult {
	const path = launchdPlistPath(ctx.env);
	if (!existsSync(path)) return { exitCode: 0, message: 'Kein launchd-Agent installiert — nichts zu tun.' };
	run('launchctl', ['unload', path]);
	rmSync(path, { force: true });
	return { exitCode: 0, message: `launchd-Agent entfernt: ${path}.` };
}

function statusLaunchd(run: CommandRunner): ServiceResult {
	const r = run('launchctl', ['list', LAUNCHD_LABEL]);
	if (r.status === null) return { exitCode: 1, message: `${UNAVAILABLE.launchd} Kein Status abrufbar.` };
	if (r.status === 0) return { exitCode: 0, message: 'kabai studio läuft (launchd-Agent geladen).' };
	return {
		exitCode: 0,
		message:
			'kabai studio läuft nicht (oder nicht geladen). Logs: siehe StandardOutPath in der plist — ' +
			'oder „kabai-studio service install“ erneut ausführen.'
	};
}

/** Dispatches `service <action>` to the systemd (Linux) or launchd (macOS) implementation. */
export function runServiceCommand(
	action: ServiceAction,
	print: boolean,
	platform: string,
	ctx: ServiceContext,
	run: CommandRunner = realRunner
): ServiceResult {
	if (platform !== 'linux' && platform !== 'darwin')
		return {
			exitCode: 1,
			message: `service wird unter ${platform} nicht unterstützt. Unterstützt: Linux (systemd), macOS (launchd).`
		};
	const linux = platform === 'linux';
	if (action === 'install') return linux ? installSystemd(ctx, print, run) : installLaunchd(ctx, print, run);
	if (action === 'uninstall') return linux ? uninstallSystemd(ctx, run) : uninstallLaunchd(ctx, run);
	return linux ? statusSystemd(run) : statusLaunchd(run);
}
