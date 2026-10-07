// End-to-end coverage for ../../server.ts: it needs the real built server, because the bug it
// fixes lives in adapter-node's own CSRF check (SvelteKit's respond.js), not in anything a direct
// handler() call (src/hooks.server.test.ts) exercises. The pure decision table is unit-tested in
// src/server-entry.test.ts; this file proves the decision actually takes effect at startup.
import { expect, test } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { findFreePort } from './free-port.ts';

const ROOT = new URL('../..', import.meta.url);
const PW = 'origin-default-test-pw';

type Server = { proc: ChildProcess; output: () => string };

function startServer(port: number, env: Record<string, string | undefined>): Server {
	let output = '';
	const proc = spawn(process.execPath, ['server.ts'], {
		cwd: ROOT,
		env: { ...process.env, PORT: String(port), ...env },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	for (const stream of [proc.stdout, proc.stderr])
		stream?.on('data', (chunk: Buffer) => (output += chunk.toString()));
	return { proc, output: () => output };
}

/** Polls /login until it answers, so the caller never races the server's own startup. */
async function waitUntilListening(
	server: Server,
	host: string,
	port: number,
	timeoutMs = 10_000
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (server.proc.exitCode !== null)
			throw new Error(
				`server exited (${server.proc.exitCode}) before it started listening:\n${server.output()}`
			);
		try {
			if ((await fetch(`http://${host}:${port}/login`)).ok) return;
		} catch {
			// not listening yet
		}
		await sleep(100);
	}
	throw new Error(
		`server did not answer on ${host}:${port} within ${timeoutMs}ms:\n${server.output()}`
	);
}

async function waitUntilExited(server: Server, timeoutMs = 10_000): Promise<number | null> {
	if (server.proc.exitCode !== null) return server.proc.exitCode;
	await Promise.race([
		new Promise<void>((resolve) => server.proc.once('exit', () => resolve())),
		sleep(timeoutMs).then(() => {
			throw new Error(`server kept running instead of exiting:\n${server.output()}`);
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

function dataDir(): string {
	return mkdtempSync(join(tmpdir(), 'kabai-studio-origin-'));
}

/**
 * A plain (non-JS) HTML form submission: Accept: text/html so SvelteKit answers with a real 303
 * instead of action JSON. `host` is the literal hostname the browser's address bar would show
 * (not necessarily what it resolves to) — the Origin header must match it, not an IP.
 */
async function submitSetup(host: string, port: number, token: string) {
	return fetch(`http://${host}:${port}/setup`, {
		method: 'POST',
		redirect: 'manual',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'text/html',
			origin: `http://${host}:${port}`
		},
		body: new URLSearchParams({ token, name: 'owner', password: PW, confirm: PW })
	});
}

/** Starts a server for one of the recognised loopback HOST values and runs the full setup flow against it. */
async function expectSetupSucceeds(host: string, port: number): Promise<void> {
	const dir = dataDir();
	const server = startServer(port, { HOST: host, STUDIO_DATA_DIR: dir, ORIGIN: undefined });
	try {
		await waitUntilListening(server, host, port);
		const token = server.output().match(/Setup-Token: (\S+)/)?.[1];
		expect(token, server.output()).toBeTruthy();

		const res = await submitSetup(host, port, token!);
		expect(res.status, await res.text()).toBe(303);
		expect(res.headers.get('location')).toBe('/');
		expect(res.headers.get('set-cookie')).toContain('studio_session=');
	} finally {
		await stop(server);
		rmSync(dir, { recursive: true, force: true });
	}
}

test('loopback HOST=127.0.0.1 without ORIGIN: setup succeeds, no CSRF 403', async () =>
	expectSetupSucceeds('127.0.0.1', await findFreePort()));

// Some systems resolve HOST=localhost to ::1 rather than 127.0.0.1, so defaulting ORIGIN to a
// fixed 127.0.0.1 would bind one address and advertise another there — the setup link then
// refuses the connection, and opening http://localhost:<PORT> directly runs back into the CSRF
// 403. The default must keep the literal hostname instead of resolving it.
test('loopback HOST=localhost without ORIGIN: setup succeeds at the advertised host, no CSRF 403', async () =>
	expectSetupSucceeds('localhost', await findFreePort()));

test('non-loopback HOST without ORIGIN: plain-text error naming ORIGIN, exits non-zero, never listens', async () => {
	const dir = dataDir();
	const port = await findFreePort();
	const server = startServer(port, { HOST: '0.0.0.0', STUDIO_DATA_DIR: dir, ORIGIN: undefined });
	try {
		const code = await waitUntilExited(server);
		expect(code).toBe(1);
		expect(server.output()).toContain('ORIGIN');
		expect(server.output()).toContain('HOST=0.0.0.0');
		await expect(fetch(`http://127.0.0.1:${port}/login`)).rejects.toThrow();
	} finally {
		await stop(server);
		rmSync(dir, { recursive: true, force: true });
	}
});

test('explicit ORIGIN is never overwritten, even behind a non-loopback HOST (container/proxy setup)', async () => {
	const dir = dataDir();
	const port = await findFreePort();
	const origin = `http://studio.example:${port}`;
	const server = startServer(port, { HOST: '0.0.0.0', STUDIO_DATA_DIR: dir, ORIGIN: origin });
	try {
		await waitUntilListening(server, '127.0.0.1', port);
		expect(server.output()).toContain(`Einrichtung: ${origin}/setup?token=`);
	} finally {
		await stop(server);
		rmSync(dir, { recursive: true, force: true });
	}
});
