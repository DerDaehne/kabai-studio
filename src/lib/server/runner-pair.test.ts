import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkFloor } from './runner-floor';
import { CREDENTIAL_FILE, FLOOR_FILE, pairRunnerCommand, type PairContext } from './runner-pair';

const CREDENTIAL = 'c'.repeat(43);
const STUDIO = 'https://studio.example';

let home: string;
let configDir: string;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let ctx: PairContext;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'studio-runner-pair-cli-'));
	configDir = join(home, 'config', 'kabai-studio');
	fetchMock = vi.fn<typeof fetch>(async () =>
		Response.json({ id: 1, name: 'workstation', credential: CREDENTIAL }, { status: 201 })
	);
	ctx = {
		env: { HOME: home, XDG_CONFIG_HOME: join(home, 'config') },
		platform: 'linux',
		hostname: 'workstation',
		locale: 'en',
		fetch: fetchMock
	};
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const pair = (url = STUDIO, name?: string) =>
	pairRunnerCommand({ url, code: 'ABCD2345', name }, ctx);
const credentialFile = () => join(configDir, CREDENTIAL_FILE);
const floorFile = () => join(configDir, FLOOR_FILE);
const writeFloor = (floor: unknown) => {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(floorFile(), JSON.stringify(floor));
};

describe('runner pair', () => {
	it('refuses plain http:// to any host but loopback, before sending the code anywhere', async () => {
		for (const url of ['http://studio.example', 'http://192.0.2.5:3000', 'http://127.0.0.2:3000']) {
			const result = await pair(url);
			expect(result.exitCode).toBe(1);
			expect(result.message).toMatch(/^\[insecure_url\] .*http:\/\/.*https:\/\//);
		}
		expect(fetchMock).not.toHaveBeenCalled();
		expect(existsSync(configDir)).toBe(false);
	});

	it('pairs over https:// and over plain http:// to loopback, without an Origin and without following redirects', async () => {
		for (const url of [
			STUDIO,
			'http://127.0.0.1:3000',
			'http://localhost:3000',
			'http://[::1]:3000/settings'
		]) {
			rmSync(configDir, { recursive: true, force: true }); // each studio gets a runner.json of its own
			expect((await pair(url)).exitCode).toBe(0);
		}

		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			`${STUDIO}/runner/pair`,
			'http://127.0.0.1:3000/runner/pair',
			'http://localhost:3000/runner/pair',
			'http://[::1]:3000/runner/pair'
		]);
		const [, init] = fetchMock.mock.calls[0];
		expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
		expect(Object.keys(init?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
			'origin'
		);
		expect(JSON.parse(String(init?.body))).toEqual({ code: 'ABCD2345', name: 'workstation' });
	});

	it('sends the name given with --name instead of the host name', async () => {
		await pair(STUDIO, 'laptop');

		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).name).toBe('laptop');
	});

	it('saves origin, name and credential in a file only the user can read, also over an existing wider one', async () => {
		mkdirSync(configDir, { recursive: true });
		writeFileSync(credentialFile(), 'old');
		chmodSync(credentialFile(), 0o644);

		const result = await pair();

		expect(result.exitCode).toBe(0);
		expect(statSync(credentialFile()).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(credentialFile(), 'utf8'))).toEqual({
			studioOrigin: STUDIO,
			name: 'workstation',
			credential: CREDENTIAL
		});
		expect(result.message).not.toContain(CREDENTIAL);
	});

	it('creates a folder only the user can enter when it is missing', async () => {
		await pair();

		expect(statSync(configDir).mode & 0o777).toBe(0o700);
	});

	it('reports a failing runner.json write as a coded error instead of a stack trace', async () => {
		fetchMock.mockImplementationOnce(async () => {
			mkdirSync(floorFile(), { recursive: true });
			return Response.json({ id: 1, name: 'workstation', credential: CREDENTIAL }, { status: 201 });
		});

		const result = await pair();

		expect(result.message).toMatch(/^\[credential_write_failed\]/);
	});

	it('creates a missing runner.json with safe defaults and names what studio will learn', async () => {
		const result = await pair();

		const floor = JSON.parse(readFileSync(floorFile(), 'utf8'));
		expect(checkFloor(floor, () => false)).toEqual({
			ok: true,
			floor: {
				studioOrigin: STUDIO,
				slots: 1,
				envAllow: ['PATH', 'HOME', 'LANG', 'USER'],
				workspaces: {},
				agents: {},
				stdioMcp: {}
			}
		});
		expect(result.message.split('\n')).toEqual([
			`Paired this machine as “workstation” with ${STUDIO}.`,
			`Credential saved in ${credentialFile()}, readable only by you.`,
			`Created ${floorFile()} with safe defaults: no workspaces, no agents, 1 slot.`,
			'Studio learns only names and numbers — workspaces: – · agents: – · slots: 1',
			'Next: start the runner with “kabai-studio runner start”.'
		]);
	});

	it('keeps a valid runner.json as it is and shows studio only its keys', async () => {
		const workspace = mkdtempSync(join(home, 'repo-'));
		const floor = {
			studioOrigin: STUDIO,
			slots: 2,
			workspaces: { app: { path: workspace } },
			agents: { claude: { command: '/opt/claude-acp' } }
		};
		writeFloor(floor);

		const result = await pair();

		expect(JSON.parse(readFileSync(floorFile(), 'utf8'))).toEqual(floor);
		expect(result.message).toContain('workspaces: app · agents: claude · slots: 2');
		expect(result.message).not.toContain(workspace);
		expect(result.message).not.toContain('/opt/claude-acp');
	});

	it('stops at an invalid runner.json with the field and the way out, before using up the code', async () => {
		writeFloor({ studioOrigin: STUDIO, workspaces: { app: { path: 'repos/app' } } });

		const result = await pair();

		expect(result.exitCode).toBe(1);
		expect(result.message).toBe(
			`[runner_json_invalid] ${floorFile()}: “workspaces.app.path” must be an absolute path. ` +
				'Fix the field, or delete the file to get safe defaults, then run the command again.'
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(existsSync(credentialFile())).toBe(false);
	});

	it('stops at a runner.json that is no JSON or belongs to another studio', async () => {
		mkdirSync(configDir, { recursive: true });
		writeFileSync(floorFile(), '{ slots: 1');
		expect((await pair()).message).toMatch(/^\[runner_json_invalid\] .* is not valid JSON/);

		writeFloor({ studioOrigin: 'https://other.example' });
		expect((await pair()).message).toContain(
			`“studioOrigin” is https://other.example, but this pairing is with ${STUDIO}.`
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('passes studio’s refusal on with its code and hint and saves nothing', async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{
					code: 'pairing_code_invalid',
					message: 'The pairing code is expired.',
					hint: 'Create a new code.'
				},
				{ status: 400 }
			)
		);

		const result = await pair();

		expect(result).toEqual({
			exitCode: 1,
			message: '[pairing_code_invalid] The pairing code is expired. Create a new code.'
		});
		expect(existsSync(credentialFile())).toBe(false);
		expect(existsSync(floorFile())).toBe(false);
	});

	it('names an unreachable studio and an answer that is no pairing, each with a way out', async () => {
		fetchMock.mockRejectedValueOnce(
			Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
		);
		expect((await pair()).message).toBe(
			`[studio_unreachable] Studio at ${STUDIO} is not reachable (ECONNREFUSED). ` +
				'Check the address and that studio is running, then run the command again.'
		);

		fetchMock.mockResolvedValueOnce(new Response('<html>login</html>', { status: 200 }));
		const odd = await pair();
		expect(odd.exitCode).toBe(1);
		expect(odd.message).toMatch(/^\[unexpected_answer\] .*HTTP 200.* without a login page/);
	});

	it('refuses an address that is not http(s)', async () => {
		const result = await pair('studio.example');

		expect(result.exitCode).toBe(1);
		expect(result.message).toMatch(
			/^\[invalid_url\] “studio\.example” is not a studio address\. Copy/
		);
	});

	it('answers in the language of the terminal and asks studio for it too', async () => {
		ctx.locale = 'de';

		const result = await pair('http://studio.example');
		await pair();

		expect(result.message).toContain('nicht unverschlüsselt');
		expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ 'accept-language': 'de' });
	});
});
