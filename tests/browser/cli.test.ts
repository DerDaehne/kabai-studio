// End-to-end coverage for the `kabai-studio` CLI in ../../server.ts: spawns the real process (like
// origin-default.test.ts), because the behaviour under test — OS-default paths, a real free-port
// probe, a real process exit code — only shows up in an actual process, not in a direct function call.
// The pure decision tables (findFreePort, service unit generation, parseCliArgs) are unit-tested in
// src/lib/server/cli.test.ts; this file proves the wiring in server.ts actually uses them.
import { expect, test } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { findFreePort } from './free-port.ts';

const ROOT = new URL('../..', import.meta.url);

type Server = { proc: ChildProcess; output: () => string };

function startServer(args: string[], env: Record<string, string | undefined>): Server {
	let output = '';
	const proc = spawn(process.execPath, ['server.ts', ...args], {
		cwd: ROOT,
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	for (const stream of [proc.stdout, proc.stderr])
		stream?.on('data', (chunk: Buffer) => (output += chunk.toString()));
	return { proc, output: () => output };
}

async function waitUntilListening(server: Server, port: number, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (server.proc.exitCode !== null)
			throw new Error(
				`server exited (${server.proc.exitCode}) before listening:\n${server.output()}`
			);
		try {
			if ((await fetch(`http://127.0.0.1:${port}/login`)).ok) return;
		} catch {
			// not listening yet
		}
		await sleep(100);
	}
	throw new Error(
		`server did not answer on 127.0.0.1:${port} within ${timeoutMs}ms:\n${server.output()}`
	);
}

/** The port the server says it fell back to; the next free one is not always busyPort + 1. */
async function announcedFallbackPort(server: Server, timeoutMs = 10_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const match = server.output().match(/benutze stattdessen (\d+)/);
		if (match) return Number(match[1]);
		if (server.proc.exitCode !== null)
			throw new Error(`server exited (${server.proc.exitCode}):\n${server.output()}`);
		await sleep(100);
	}
	throw new Error(`server announced no fallback port within ${timeoutMs}ms:\n${server.output()}`);
}

async function waitUntilExited(server: Server, timeoutMs = 10_000): Promise<number | null> {
	if (server.proc.exitCode !== null) return server.proc.exitCode;
	await Promise.race([
		new Promise<void>((resolve) => server.proc.once('exit', () => resolve())),
		sleep(timeoutMs).then(() => {
			throw new Error(`process kept running instead of exiting:\n${server.output()}`);
		})
	]);
	return server.proc.exitCode;
}

/** Only ever kills the PID this test itself started. */
async function stop(server: Server): Promise<void> {
	if (server.proc.exitCode !== null) return;
	server.proc.kill();
	await waitUntilExited(server).catch(() => {});
}

function throwawayHome(): string {
	return mkdtempSync(join(tmpdir(), 'kabai-studio-cli-'));
}

test('start without any config: data lands under the OS-default path, the URL is printed', async () => {
	const home = throwawayHome();
	const xdgData = join(home, 'xdg-data');
	const port = await findFreePort();
	const server = startServer([], {
		HOME: home,
		XDG_DATA_HOME: xdgData,
		STUDIO_DATA_DIR: undefined,
		PORT: String(port),
		ORIGIN: undefined
	});
	try {
		await waitUntilListening(server, port);
		expect(server.output()).toContain(`http://127.0.0.1:${port}`);
		expect(existsSync(join(xdgData, 'kabai-studio', 'studio.db'))).toBe(true);
	} finally {
		await stop(server);
		rmSync(home, { recursive: true, force: true });
	}
});

test('a busy port falls back to the next free one and names both in the output', async () => {
	const home = throwawayHome();
	const busyPort = await findFreePort();
	const blocker = createServer();
	await new Promise<void>((resolve) => blocker.listen(busyPort, '127.0.0.1', resolve));
	const server = startServer([], {
		HOME: home,
		STUDIO_DATA_DIR: join(home, 'data'),
		PORT: String(busyPort),
		ORIGIN: undefined
	});
	try {
		const fallbackPort = await announcedFallbackPort(server);
		expect(fallbackPort).toBeGreaterThan(busyPort);
		await waitUntilListening(server, fallbackPort);
		expect(server.output()).toContain(`Port ${busyPort} ist belegt`);
		expect(server.output()).toContain(`http://127.0.0.1:${fallbackPort}`);
	} finally {
		await stop(server);
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
		rmSync(home, { recursive: true, force: true });
	}
});

test('an unknown subcommand exits non-zero with a one-line, plain-text way out', async () => {
	const server = startServer(['bogus-command'], {});
	try {
		const code = await waitUntilExited(server);
		expect(code).not.toBe(0);
		expect(server.output()).toContain('bogus-command');
		expect(server.output().trim().split('\n')).toHaveLength(1);
	} finally {
		await stop(server);
	}
});

test('service install --print prints the unit without touching the filesystem or a real service manager', async () => {
	const home = throwawayHome();
	const configHome = join(home, 'xdg-config');
	const server = startServer(['service', 'install', '--print'], {
		HOME: home,
		XDG_CONFIG_HOME: configHome
	});
	try {
		const code = await waitUntilExited(server);
		expect(code).toBe(0);
		expect(server.output()).toContain('ExecStart=');
		expect(existsSync(configHome)).toBe(false);
	} finally {
		await stop(server);
		rmSync(home, { recursive: true, force: true });
	}
});

// Read-only (`systemctl --user is-active`/`launchctl list`), never "enable" or "start" — safe to run for
// real. Whether this host even has a user service manager varies (CI containers often don't), so this
// only checks the shared exit-code/one-sentence contract, not which branch fired.
test('service status reports exactly one outcome: running, not running, or unavailable', async () => {
	const home = throwawayHome();
	const server = startServer(['service', 'status'], {
		HOME: home,
		XDG_CONFIG_HOME: join(home, 'xdg-config')
	});
	try {
		const code = await waitUntilExited(server);
		expect([0, 1]).toContain(code);
		const lines = server.output().trim().split('\n');
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/läuft|verfügbar/);
	} finally {
		await stop(server);
		rmSync(home, { recursive: true, force: true });
	}
});

/** What `runner pair` leaves behind, pointing at `origin`. */
function writePairing(home: string, origin: string, { floor = true } = {}): string {
	const configHome = join(home, 'xdg-config');
	const configDir = join(configHome, 'kabai-studio');
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, 'runner-credential.json'),
		JSON.stringify({ studioOrigin: origin, name: 'service-machine', credential: 'c'.repeat(43) }),
		{ mode: 0o600 }
	);
	if (floor)
		writeFileSync(
			join(configDir, 'runner.json'),
			JSON.stringify({ studioOrigin: origin, slots: 1, workspaces: {}, agents: {} })
		);
	return configHome;
}

test('runner service install --print shows a unit that runs runner start, and writes nothing', async () => {
	const home = throwawayHome();
	const configHome = join(home, 'xdg-config');
	const server = startServer(['runner', 'service', 'install', '--print'], {
		HOME: home,
		XDG_CONFIG_HOME: configHome
	});
	try {
		expect(await waitUntilExited(server)).toBe(0);
		expect(server.output()).toMatch(/ExecStart=.* runner start\n/);
		expect(server.output()).toContain('RestartSec=30');
		expect(existsSync(configHome)).toBe(false);
	} finally {
		await stop(server);
		rmSync(home, { recursive: true, force: true });
	}
});

test.describe('runner service install without a complete pairing', () => {
	for (const [label, pairFirst, floor, code] of [
		['credential', false, false, 'not_paired'],
		['runner.json', true, false, 'runner_json_missing']
	] as const) {
		test(`missing ${label} exits 1 with [${code}] and writes no unit`, async () => {
			const home = throwawayHome();
			const configHome = pairFirst
				? writePairing(home, 'http://127.0.0.1:1', { floor })
				: join(home, 'xdg-config');
			const server = startServer(['runner', 'service', 'install'], {
				HOME: home,
				XDG_CONFIG_HOME: configHome
			});
			try {
				expect(await waitUntilExited(server)).toBe(1);
				expect(server.output()).toContain(`[${code}]`);
				expect(server.output().trim().split('\n')).toHaveLength(1);
				expect(existsSync(join(configHome, 'systemd'))).toBe(false);
			} finally {
				await stop(server);
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});

test('the ExecStart line from --print starts a runner that connects to a test server', async () => {
	const home = throwawayHome();
	const received: { authorization?: string; hello?: { type: string } }[] = [];
	const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	wss.on('connection', (socket, request) => {
		const seen: (typeof received)[number] = { authorization: request.headers.authorization };
		received.push(seen);
		socket.on('message', (data) => {
			seen.hello = JSON.parse(data.toString());
			socket.send(JSON.stringify({ type: 'welcome', name: 'service-machine' }));
		});
	});
	await new Promise<void>((resolve) => wss.once('listening', resolve));
	const port = (wss.address() as AddressInfo).port;
	const configHome = writePairing(home, `http://127.0.0.1:${port}`);
	const env = { HOME: home, XDG_CONFIG_HOME: configHome };
	const printed = startServer(['runner', 'service', 'install', '--print'], env);
	let runner: Server | undefined;
	try {
		expect(await waitUntilExited(printed)).toBe(0);
		const unit = printed.output();
		const [execPath, ...args] = unit.match(/^ExecStart=(.*)$/m)![1].split(' ');
		expect(unit).toContain(`Environment=XDG_CONFIG_HOME=${configHome}`);
		let output = '';
		const proc = spawn(execPath, args, {
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		for (const stream of [proc.stdout, proc.stderr])
			stream?.on('data', (chunk: Buffer) => (output += chunk.toString()));
		runner = { proc, output: () => output };
		const deadline = Date.now() + 10_000;
		while (!output.includes('service-machine') && Date.now() < deadline) await sleep(100);
		expect(output).toContain('service-machine'); // the welcome was received
		expect(received[0]?.authorization).toBe(`Bearer ${'c'.repeat(43)}`);
		expect(received[0]?.hello?.type).toBe('hello');
	} finally {
		if (runner) await stop(runner);
		await stop(printed);
		await new Promise<void>((resolve) => wss.close(() => resolve()));
		rmSync(home, { recursive: true, force: true });
	}
});
