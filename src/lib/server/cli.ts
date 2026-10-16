// The `kabai-studio` CLI: argument parsing, the free-port probe for `start`, and the systemd/
// launchd `service` subcommand. Kept separate from server.ts so the logic here is unit-testable
// without spawning a real process.
import { parseArgs } from 'node:util';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localeFromEnv, translate, type Locale, type MessageKey } from '../i18n/index.ts';
import { DomainError, formatError } from './domain/error.ts';

export class CliUsageError extends Error {}

export type ServiceAction = 'install' | 'uninstall' | 'status';

export type Command =
	| { kind: 'start' }
	| { kind: 'service'; action: ServiceAction; print: boolean }
	| { kind: 'reset-password' }
	| { kind: 'restore'; file?: string }
	| { kind: 'runner-pair'; url: string; code: string; name?: string }
	| { kind: 'runner-start' }
	| { kind: 'runner-service'; action: ServiceAction; print: boolean }
	| { kind: 'version' }
	| { kind: 'help' };

const SERVICE_ACTIONS = new Set<string>(['install', 'uninstall', 'status']);
const locale = localeFromEnv(process.env);
export const HELP = translate(locale, 'cli.usage');

/** Pure so the error contract (unknown command/subcommand) is testable without spawning a process. */
export function parseCliArgs(argv: string[]): Command {
	const [sub, ...rest] = argv;
	if (sub === '--version' || sub === '-v') return { kind: 'version' };
	if (sub === '--help' || sub === '-h') return { kind: 'help' };
	if (sub === undefined || sub === 'start') return { kind: 'start' };
	if (sub === 'reset-password') return { kind: 'reset-password' };
	if (sub === 'restore') return { kind: 'restore', file: rest[0] };
	if (sub === 'service') return parseServiceArgs(rest);
	if (sub === 'runner') return parseRunnerArgs(rest);
	throw new CliUsageError(translate(locale, 'cli.unknownCommand', { command: sub, usage: HELP }));
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
			translate(locale, 'cli.unknownServiceCommand', { action: action ?? '' })
		);
	return { kind: 'service', action: action as ServiceAction, print: values.print === true };
}

/** `runner pair <url> <code> [--name <name>]`, `runner start` or `runner service <action> [--print]`; anything else is a usage error with a code and the way out. */
function parseRunnerArgs(rest: string[]): Command {
	const usage = () =>
		new CliUsageError(
			formatError(
				new DomainError(
					'invalid_arguments',
					translate(locale, 'cli.runner.usage'),
					translate(locale, 'cli.runner.usage.hint')
				)
			)
		);
	let parsed;
	try {
		parsed = parseArgs({
			args: rest,
			options: { name: { type: 'string' }, print: { type: 'boolean', default: false } },
			allowPositionals: true
		});
	} catch {
		throw usage(); // an unknown option or --name without a value
	}
	const [action, url, code, ...extra] = parsed.positionals;
	const { name, print } = parsed.values;
	if (action === 'start' && !url && !name && !print) return { kind: 'runner-start' };
	if (action === 'service' && isServiceAction(url) && !code && !name)
		return { kind: 'runner-service', action: url, print: print === true };
	if (print || action !== 'pair' || !url || !code || extra.length) throw usage();
	return { kind: 'runner-pair', url, code, name };
}

const isServiceAction = (value: string | undefined): value is ServiceAction =>
	SERVICE_ACTIONS.has(value ?? '');

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

const RUNNER_SYSTEMD_LABEL = 'kabai-studio-runner';
const RUNNER_LAUNCHD_LABEL = 'studio.kabai.kabai-studio-runner';
/** A revoked machine exits with 1; the pause keeps it from hammering studio and lets it reconnect after a new pairing. */
const RUNNER_RESTART_SECONDS = 30;

export const systemdUnitPath = (
	env: Record<string, string | undefined>,
	label = SYSTEMD_LABEL
): string =>
	join(
		env.XDG_CONFIG_HOME || join(env.HOME || '', '.config'),
		'systemd',
		'user',
		`${label}.service`
	);

export const launchdPlistPath = (
	env: Record<string, string | undefined>,
	label = LAUNCHD_LABEL
): string => join(env.HOME || '', 'Library', 'LaunchAgents', `${label}.plist`);

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

type ServiceTextId =
	| 'unavailable.systemd'
	| 'unavailable.launchd'
	| 'statusUnavailable.systemd'
	| 'statusUnavailable.launchd'
	| 'fs.write'
	| 'fs.remove'
	| 'installed.systemd'
	| 'installed.launchd'
	| 'none.systemd'
	| 'none.launchd'
	| 'removed.systemd'
	| 'removed.launchd'
	| 'running.systemd'
	| 'running.launchd'
	| 'stopped.systemd'
	| 'stopped.launchd'
	| 'unsupported';

type Say = (id: ServiceTextId, params?: Record<string, string>) => string;

/** What differs between the studio service and the runner service; the install/uninstall/status flow is shared. */
export type ServiceProfile = {
	systemdLabel: string;
	launchdLabel: string;
	systemdUnit: (ctx: ServiceContext) => string;
	launchdPlist: (ctx: ServiceContext) => string;
	say: Say;
	/** Checked after `--print` and before anything is written; a result stops the install. */
	preflight?: () => ServiceResult | undefined;
};

const STUDIO_TEXTS: Record<ServiceTextId, string> = {
	'unavailable.systemd':
		'systemd ist auf diesem Host nicht verfügbar. Mit --print lässt sich die Unit-Datei trotzdem ansehen.',
	'unavailable.launchd':
		'launchd ist auf diesem Host nicht verfügbar. Mit --print lässt sich die plist-Datei trotzdem ansehen.',
	'statusUnavailable.systemd':
		'systemd ist auf diesem Host nicht verfügbar. Mit --print lässt sich die Unit-Datei trotzdem ansehen. Kein Status abrufbar.',
	'statusUnavailable.launchd':
		'launchd ist auf diesem Host nicht verfügbar. Mit --print lässt sich die plist-Datei trotzdem ansehen. Kein Status abrufbar.',
	'fs.write': '{path} lässt sich nicht schreiben ({code}). Rechte im Verzeichnis prüfen.',
	'fs.remove': '{path} lässt sich nicht entfernen ({code}). Rechte im Verzeichnis prüfen.',
	'installed.systemd':
		'systemd-User-Unit installiert: {path}. ' +
		'Für Autostart auch ohne aktive Anmeldung: „loginctl enable-linger $(whoami)“.',
	'installed.launchd': 'launchd-Agent installiert: {path}.',
	'none.systemd': 'Keine systemd-User-Unit installiert — nichts zu tun.',
	'none.launchd': 'Kein launchd-Agent installiert — nichts zu tun.',
	'removed.systemd': 'systemd-User-Unit entfernt: {path}.',
	'removed.launchd': 'launchd-Agent entfernt: {path}.',
	'running.systemd': 'kabai studio läuft (systemd-User-Dienst aktiv).',
	'running.launchd': 'kabai studio läuft (launchd-Agent geladen).',
	'stopped.systemd':
		'kabai studio läuft nicht. Logs ansehen: „journalctl --user -u kabai-studio“ — ' +
		'oder „kabai-studio service install“ erneut ausführen.',
	'stopped.launchd':
		'kabai studio läuft nicht (oder nicht geladen). Logs: siehe StandardOutPath in der plist — ' +
		'oder „kabai-studio service install“ erneut ausführen.',
	unsupported:
		'service wird unter {platform} nicht unterstützt. Unterstützt: Linux (systemd), macOS (launchd).'
};

const fill = (template: string, params: Record<string, string> = {}): string =>
	template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? '');

export const STUDIO_PROFILE: ServiceProfile = {
	systemdLabel: SYSTEMD_LABEL,
	launchdLabel: LAUNCHD_LABEL,
	systemdUnit,
	launchdPlist,
	say: (id, params) => fill(STUDIO_TEXTS[id], params)
};

/** systemd splits unquoted values at spaces and expands % (and $ in ExecStart), so every value is quoted and escaped. */
const systemdQuote = (value: string, { dollar = false } = {}): string => {
	const escaped = value.replace(/[\\"]/g, '\\$&').replaceAll('%', '%%');
	return `"${dollar ? escaped.replaceAll('$', '$$$$') : escaped}"`;
};

const xmlEscape = (value: string): string =>
	value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Pure like `systemdUnit`; `XDG_CONFIG_HOME` is passed on only when set, so the service reads the folder `runner pair` wrote to. */
export function runnerSystemdUnit(ctx: ServiceContext): string {
	const configHome = ctx.env.XDG_CONFIG_HOME;
	const exec = [ctx.execPath, ctx.entryPath].map((v) => systemdQuote(v, { dollar: true }));
	return [
		'[Unit]',
		'Description=kabai studio runner',
		'After=network.target',
		'',
		'[Service]',
		`ExecStart=${exec.join(' ')} runner start`,
		...(configHome ? [`Environment=${systemdQuote(`XDG_CONFIG_HOME=${configHome}`)}`] : []),
		'Restart=on-failure',
		`RestartSec=${RUNNER_RESTART_SECONDS}`,
		'',
		'[Install]',
		'WantedBy=default.target',
		''
	].join('\n');
}

export function runnerLaunchdPlist(ctx: ServiceContext): string {
	const logPath = xmlEscape(
		join(ctx.env.HOME || '', 'Library', 'Logs', `${RUNNER_LAUNCHD_LABEL}.log`)
	);
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${RUNNER_LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xmlEscape(ctx.execPath)}</string>
		<string>${xmlEscape(ctx.entryPath)}</string>
		<string>runner</string>
		<string>start</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
	<key>ThrottleInterval</key><integer>${RUNNER_RESTART_SECONDS}</integer>
	<key>StandardOutPath</key><string>${logPath}</string>
	<key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
}

const RUNNER_FAILURE_CODES: Partial<Record<ServiceTextId, string>> = {
	'unavailable.systemd': 'service_manager_missing',
	'unavailable.launchd': 'service_manager_missing',
	'statusUnavailable.systemd': 'service_manager_missing',
	'statusUnavailable.launchd': 'service_manager_missing',
	'fs.write': 'unit_file_not_writable',
	'fs.remove': 'unit_file_not_removable',
	unsupported: 'platform_unsupported'
};

export function runnerServiceProfile(
	locale: Locale,
	preflight: ServiceProfile['preflight']
): ServiceProfile {
	return {
		systemdLabel: RUNNER_SYSTEMD_LABEL,
		launchdLabel: RUNNER_LAUNCHD_LABEL,
		systemdUnit: runnerSystemdUnit,
		launchdPlist: runnerLaunchdPlist,
		say: (id, params) => {
			const text = (key: string) =>
				translate(locale, `cli.runner.service.${key}` as MessageKey, params);
			const code = RUNNER_FAILURE_CODES[id];
			if (!code) return text(id);
			return formatError(new DomainError(code, text(id), text(`${id}.hint`)));
		},
		preflight
	};
}

/**
 * Runs an fs operation on the unit/plist file and turns a permission or disk error into the
 * same one-line exit-code-1 contract as every other CLI error, not a raw Node stack trace.
 */
function tryFs(
	profile: ServiceProfile,
	textId: 'fs.write' | 'fs.remove',
	path: string,
	fn: () => void
): ServiceResult | undefined {
	try {
		fn();
		return undefined;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
		return { exitCode: 1, message: profile.say(textId, { path, code }) };
	}
}

const writeUnitFile = (
	profile: ServiceProfile,
	path: string,
	content: string
): ServiceResult | undefined =>
	tryFs(profile, 'fs.write', path, () => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, { mode: 0o600 });
	});

const removeUnitFile = (profile: ServiceProfile, path: string): ServiceResult | undefined =>
	tryFs(profile, 'fs.remove', path, () => rmSync(path, { force: true }));

function installSystemd(
	ctx: ServiceContext,
	print: boolean,
	run: CommandRunner,
	profile: ServiceProfile
): ServiceResult {
	const unit = profile.systemdUnit(ctx);
	if (print) return { exitCode: 0, message: unit };
	const refused = profile.preflight?.();
	if (refused) return refused;
	if (run('systemctl', ['--version']).status !== 0)
		return { exitCode: 1, message: profile.say('unavailable.systemd') };
	const path = systemdUnitPath(ctx.env, profile.systemdLabel);
	const writeError = writeUnitFile(profile, path, unit);
	if (writeError) return writeError;
	run('systemctl', ['--user', 'daemon-reload']);
	run('systemctl', ['--user', 'enable', profile.systemdLabel]);
	return { exitCode: 0, message: profile.say('installed.systemd', { path }) };
}

function uninstallSystemd(
	ctx: ServiceContext,
	run: CommandRunner,
	profile: ServiceProfile
): ServiceResult {
	const path = systemdUnitPath(ctx.env, profile.systemdLabel);
	if (!existsSync(path)) return { exitCode: 0, message: profile.say('none.systemd') };
	run('systemctl', ['--user', 'disable', '--now', profile.systemdLabel]);
	const removeError = removeUnitFile(profile, path);
	if (removeError) return removeError;
	run('systemctl', ['--user', 'daemon-reload']);
	return { exitCode: 0, message: profile.say('removed.systemd', { path }) };
}

function statusSystemd(run: CommandRunner, profile: ServiceProfile): ServiceResult {
	const r = run('systemctl', ['--user', 'is-active', profile.systemdLabel]);
	if (r.status === null)
		return {
			exitCode: 1,
			message: profile.say('statusUnavailable.systemd')
		};
	if (r.stdout.trim() === 'active') return { exitCode: 0, message: profile.say('running.systemd') };
	return { exitCode: 0, message: profile.say('stopped.systemd') };
}

function installLaunchd(
	ctx: ServiceContext,
	print: boolean,
	run: CommandRunner,
	profile: ServiceProfile
): ServiceResult {
	const plist = profile.launchdPlist(ctx);
	if (print) return { exitCode: 0, message: plist };
	const refused = profile.preflight?.();
	if (refused) return refused;
	if (run('launchctl', ['list']).status !== 0)
		return { exitCode: 1, message: profile.say('unavailable.launchd') };
	const path = launchdPlistPath(ctx.env, profile.launchdLabel);
	const writeError = writeUnitFile(profile, path, plist);
	if (writeError) return writeError;
	run('launchctl', ['load', path]);
	return { exitCode: 0, message: profile.say('installed.launchd', { path }) };
}

function uninstallLaunchd(
	ctx: ServiceContext,
	run: CommandRunner,
	profile: ServiceProfile
): ServiceResult {
	const path = launchdPlistPath(ctx.env, profile.launchdLabel);
	if (!existsSync(path)) return { exitCode: 0, message: profile.say('none.launchd') };
	run('launchctl', ['unload', path]);
	const removeError = removeUnitFile(profile, path);
	if (removeError) return removeError;
	return { exitCode: 0, message: profile.say('removed.launchd', { path }) };
}

function statusLaunchd(run: CommandRunner, profile: ServiceProfile): ServiceResult {
	const r = run('launchctl', ['list', profile.launchdLabel]);
	if (r.status === null)
		return {
			exitCode: 1,
			message: profile.say('statusUnavailable.launchd')
		};
	if (r.status === 0) return { exitCode: 0, message: profile.say('running.launchd') };
	return { exitCode: 0, message: profile.say('stopped.launchd') };
}

/** Dispatches `service <action>` to the systemd (Linux) or launchd (macOS) implementation. */
export function runServiceCommand(
	action: ServiceAction,
	print: boolean,
	platform: string,
	ctx: ServiceContext,
	run: CommandRunner = realRunner,
	profile: ServiceProfile = STUDIO_PROFILE
): ServiceResult {
	if (platform !== 'linux' && platform !== 'darwin')
		return { exitCode: 1, message: profile.say('unsupported', { platform }) };
	const linux = platform === 'linux';
	if (action === 'install')
		return linux
			? installSystemd(ctx, print, run, profile)
			: installLaunchd(ctx, print, run, profile);
	if (action === 'uninstall')
		return linux ? uninstallSystemd(ctx, run, profile) : uninstallLaunchd(ctx, run, profile);
	return linux ? statusSystemd(run, profile) : statusLaunchd(run, profile);
}
