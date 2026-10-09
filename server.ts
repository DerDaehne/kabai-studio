// Production entry point and `kabai-studio` CLI: `node server.ts [command]` instead of `node build`
// (Dockerfile, CLAUDE.md). No subcommand (or `start`) runs the server; `service`, `reset-password`,
// `restore` and `--version` are the rest of the CLI, implemented in src/lib/server/cli.ts.
//
// adapter-node's handler.js reads ORIGIN at import time, at the top of the module — before
// `hooks.server.ts`'s `init` hook ever runs. A default set there (like the existing HOST default,
// which works because index.js reads HOST only afterwards) would already be too late for ORIGIN.
// So this default has to run before build/index.js (and with it handler.js) is imported at all.
//
// The origin's host must be the same string the browser's address bar uses, not whatever address
// it happens to resolve to: adapter-node (like the browser's Origin header) compares origins as
// plain strings, never resolved IPs — "localhost" can resolve to ::1 on one machine and 127.0.0.1
// on another, so defaulting it to a fixed "127.0.0.1" origin would mismatch on the ::1 ones.
import { defaultDataDir } from './src/lib/server/data-dir.ts';
import {
	CliUsageError,
	HELP,
	findFreePort,
	parseCliArgs,
	realRunner,
	runServiceCommand,
	type Command
} from './src/lib/server/cli.ts';
import { resolveVersion } from './src/lib/version.ts';

const LOOPBACK_ORIGIN_HOST: Record<string, string> = {
	'': '127.0.0.1',
	'127.0.0.1': '127.0.0.1',
	localhost: 'localhost',
	'::1': '[::1]' // bracketed: URL syntax for a literal IPv6 host
};

export type OriginDecision =
	| { kind: 'keep' } // ORIGIN is already set explicitly — never overwritten
	| { kind: 'default'; origin: string } // loopback bind — safe to default
	| { kind: 'error'; message: string }; // not a loopback bind, and no ORIGIN to fall back to

/** Pure so it can be unit-tested without starting a server; `main()` below applies the result. */
export function decideOrigin(env: Record<string, string | undefined>): OriginDecision {
	if (env.ORIGIN) return { kind: 'keep' };
	const host = (env.HOST ?? '').trim().toLowerCase();
	const port = env.PORT || '3000';
	const originHost = LOOPBACK_ORIGIN_HOST[host];
	if (originHost !== undefined) return { kind: 'default', origin: `http://${originHost}:${port}` };
	return {
		kind: 'error',
		message:
			`kabai studio: HOST=${host} ist kein Loopback-Bind, und ORIGIN ist nicht gesetzt.\n` +
			'Ohne ORIGIN weist SvelteKits CSRF-Schutz Setup, Login und Logout mit einer generischen ' +
			'Fehlermeldung ab, weil adapter-node sonst https statt http annimmt.\n' +
			`Ausweg: mit ORIGIN=http://<von außen erreichbare Adresse>:${port} neu starten — ` +
			'genau der Adresse, unter der der Browser den Server erreicht.'
	};
}

/** The one error contract for every CLI path: exit code ≠ 0 means stderr, 0 means stdout. */
function finish(exitCode: number, message: string): void {
	(exitCode === 0 ? console.log : console.error)(message);
	process.exitCode = exitCode;
}

async function runStart(): Promise<void> {
	if (!process.env.STUDIO_DATA_DIR)
		process.env.STUDIO_DATA_DIR = defaultDataDir(process.platform, process.env);
	const host = (process.env.HOST ?? '').trim().toLowerCase() || '127.0.0.1';
	const requestedPort = Number(process.env.PORT) || 3000;
	let port: number;
	try {
		port = await findFreePort(requestedPort, host);
	} catch (err) {
		finish(1, (err as Error).message);
		return;
	}
	if (port !== requestedPort)
		console.log(`Port ${requestedPort} ist belegt, benutze stattdessen ${port}.`);
	process.env.PORT = String(port);

	const decision = decideOrigin(process.env);
	if (decision.kind === 'default') process.env.ORIGIN = decision.origin;
	else if (decision.kind === 'error') {
		finish(1, decision.message);
		return;
	}
	// A plain string constant, not a literal in the import() call: build/ only exists after `npm run
	// build` (svelte-check runs before it in CI), and a literal specifier would make it resolve the
	// module for types right now and fail.
	const entry = './build/index.js';
	await import(entry);
}

/** `entryPath` is this same file's own path: whatever path started this process is the right one to
 * start again on the next boot, whether that's server.ts in a worktree or the shipped binary. */
function runService(command: Extract<Command, { kind: 'service' }>): void {
	const ctx = {
		env: process.env,
		execPath: process.execPath,
		entryPath: process.argv[1] ?? '',
		dataDir: process.env.STUDIO_DATA_DIR || defaultDataDir(process.platform, process.env)
	};
	const result = runServiceCommand(
		command.action,
		command.print,
		process.platform,
		ctx,
		realRunner
	);
	finish(result.exitCode, result.message);
}

/** Re-execs an existing standalone script (reset-password.ts/restore.ts) as a subcommand: trims this
 * process's own argv down to what the script itself reads, then imports it — the script's top-level
 * code does the rest, exactly as `node src/lib/server/<script>.ts` already does. */
async function runLegacyScript(relativePath: string, extraArgs: string[]): Promise<void> {
	process.argv = [process.argv[0] ?? '', process.argv[1] ?? '', ...extraArgs];
	await import(relativePath);
}

async function main(): Promise<void> {
	let command: Command;
	try {
		command = parseCliArgs(process.argv.slice(2));
	} catch (err) {
		if (!(err instanceof CliUsageError)) throw err;
		finish(1, err.message);
		return;
	}
	if (command.kind === 'version') return void console.log(resolveVersion());
	if (command.kind === 'help') return void console.log(HELP);
	if (command.kind === 'service') return runService(command);
	if (command.kind === 'reset-password')
		return runLegacyScript('./src/lib/server/reset-password.ts', []);
	if (command.kind === 'restore')
		return runLegacyScript('./src/lib/server/restore.ts', command.file ? [command.file] : []);
	return runStart();
}

if (import.meta.main) await main();
