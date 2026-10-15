// `kabai-studio runner pair <url> <code> [--name <name>]`: exchanges a one-time code from studio for this machine's
// runner credential, stores it readable only by the user, and makes sure a valid local floor (runner.json) exists.
// Node builtins and relative .ts imports only: server.ts loads this file directly, without Vite.
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { translate, type Locale, type MessageKey } from '../i18n/index.ts';
import { isLoopbackHost } from './auth.ts';
import { defaultConfigDir } from './data-dir.ts';
import { DomainError, formatError } from './domain/error.ts';
import { checkFloor, defaultFloor, floorSummary, type Floor } from './runner-floor.ts';

export type PairArgs = { url: string; code: string; name?: string };
export type PairContext = {
	env: Record<string, string | undefined>;
	platform: string;
	hostname: string;
	locale: Locale;
	fetch: typeof fetch;
};
export type PairResult = { exitCode: number; message: string };

export const FLOOR_FILE = 'runner.json';
export const CREDENTIAL_FILE = 'runner-credential.json';
const PAIR_TIMEOUT_MS = 15_000;

/** Runs the pairing; every refusal comes back as one `[code] message hint` line with exit code 1. */
export async function pairRunnerCommand(args: PairArgs, ctx: PairContext): Promise<PairResult> {
	const say: Say = (key, params) => translate(ctx.locale, key, params);
	try {
		return { exitCode: 0, message: await pair(args, ctx, say) };
	} catch (err) {
		if (!(err instanceof DomainError)) throw err;
		return { exitCode: 1, message: formatError(err) };
	}
}

async function pair(args: PairArgs, ctx: PairContext, say: Say): Promise<string> {
	const origin = studioOrigin(args.url, say);
	const dir = defaultConfigDir(ctx.platform, ctx.env);
	const floorFile = join(dir, FLOOR_FILE);
	const credentialFile = join(dir, CREDENTIAL_FILE);
	// Both before the code is used up: a broken floor or an unwritable folder must not cost a pairing.
	const existingFloor = readFloor(floorFile, origin, say);
	prepareDir(dir, say);

	const paired = await exchangeCode(origin, args.code, args.name ?? ctx.hostname, ctx, say);
	const credential = { studioOrigin: origin, ...paired };
	writePrivateFile(credentialFile, `${JSON.stringify(credential, null, '\t')}\n`, say);
	const floor = existingFloor ?? createDefaultFloor(floorFile, origin, say);
	return successMessage(
		{ origin, name: paired.name, credentialFile, floorFile, floor, floorCreated: !existingFloor },
		say
	);
}

type Say = (key: MessageKey, params?: Record<string, string | number>) => string;

/** The studio origin from the pasted address; the code and later the credential never travel unencrypted. */
function studioOrigin(input: string, say: Say): string {
	const url = URL.parse(input);
	if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:'))
		throw new DomainError(
			'invalid_url',
			say('cli.runner.invalidUrl', { url: input }),
			say('cli.runner.invalidUrl.hint')
		);
	if (url.protocol === 'http:' && !isLoopbackHost(url.hostname))
		throw new DomainError(
			'insecure_url',
			say('cli.runner.insecureUrl', { host: url.host }),
			say('cli.runner.insecureUrl.hint')
		);
	return url.origin;
}

/** The checked floor, or undefined when there is none yet. */
export function readFloor(file: string, origin: string, say: Say): Floor | undefined {
	if (!existsSync(file)) return undefined;
	const invalid = (key: MessageKey, params: Record<string, string>) =>
		new DomainError(
			'runner_json_invalid',
			say(key, { file, ...params }),
			say('cli.runner.floor.hint')
		);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, 'utf8'));
	} catch (err) {
		throw invalid('cli.runner.floor.notJson', { reason: (err as Error).message });
	}
	const check = checkFloor(raw, isDirectory);
	if (!check.ok)
		throw invalid(`cli.runner.floor.${check.problem}`, { field: check.field || FLOOR_FILE });
	if (check.floor.studioOrigin !== origin)
		throw invalid('cli.runner.floor.originMismatch', {
			field: 'studioOrigin',
			actual: check.floor.studioOrigin,
			expected: origin
		});
	return check.floor;
}

const isDirectory = (path: string) =>
	statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

async function exchangeCode(
	origin: string,
	code: string,
	name: string,
	ctx: PairContext,
	say: Say
): Promise<{ name: string; credential: string }> {
	let response: Response;
	try {
		response = await ctx.fetch(`${origin}/runner/pair`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'accept-language': ctx.locale },
			body: JSON.stringify({ code, name }),
			redirect: 'error', // a redirect could lead the credential off to plain http
			signal: AbortSignal.timeout(PAIR_TIMEOUT_MS)
		});
	} catch (err) {
		const reason = String(
			(err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message
		);
		throw new DomainError(
			'studio_unreachable',
			say('cli.runner.unreachable', { origin, reason }),
			say('cli.runner.unreachable.hint')
		);
	}
	const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
	if (response.ok && typeof body?.credential === 'string' && typeof body.name === 'string')
		return { name: body.name, credential: body.credential };
	if (typeof body?.code === 'string' && typeof body.message === 'string')
		throw new DomainError(body.code, body.message, String(body.hint ?? ''));
	throw new DomainError(
		'unexpected_answer',
		say('cli.runner.unexpectedAnswer', { origin, status: response.status }),
		say('cli.runner.unexpectedAnswer.hint')
	);
}

/**
 * Writes `content` readable only by the owner. Through a fresh temp file and a rename, because writeFileSync's `mode`
 * applies only when it creates the file: an existing file would keep its old, possibly wider permissions.
 */
function writePrivateFile(file: string, content: string, say: Say): void {
	const temp = `${file}.tmp`;
	try {
		rmSync(temp, { force: true });
		writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
		renameSync(temp, file);
	} catch (err) {
		throw new DomainError(
			'credential_write_failed',
			say('cli.runner.writeFailed', {
				file,
				reason: String((err as NodeJS.ErrnoException).code ?? err)
			}),
			say('cli.runner.writeFailed.hint')
		);
	}
}

function prepareDir(dir: string, say: Say): void {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		accessSync(dir, constants.W_OK);
	} catch (err) {
		throw new DomainError(
			'credential_write_failed',
			say('cli.runner.writeFailed', {
				file: dir,
				reason: String((err as NodeJS.ErrnoException).code ?? err)
			}),
			say('cli.runner.writeFailed.hint')
		);
	}
}

function createDefaultFloor(file: string, origin: string, say: Say): Floor {
	const floor = defaultFloor(origin);
	try {
		writeFileSync(file, `${JSON.stringify(floor, null, '\t')}\n`, { flag: 'wx' });
	} catch (err) {
		throw new DomainError(
			'credential_write_failed',
			say('cli.runner.writeFailed', {
				file,
				reason: String((err as NodeJS.ErrnoException).code ?? err)
			}),
			say('cli.runner.writeFailed.hint')
		);
	}
	return floor;
}

type Outcome = {
	origin: string;
	name: string;
	credentialFile: string;
	floorFile: string;
	floor: Floor;
	floorCreated: boolean;
};

function successMessage(
	{ origin, name, credentialFile, floorFile, floor, floorCreated }: Outcome,
	say: Say
): string {
	const summary = floorSummary(floor);
	const list = (keys: string[]) => (keys.length ? keys.join(', ') : '–');
	return [
		say('cli.runner.paired', { name, origin }),
		say('cli.runner.credentialSaved', { file: credentialFile }),
		say(floorCreated ? 'cli.runner.floorCreated' : 'cli.runner.floorChecked', { file: floorFile }),
		say('cli.runner.studioSees', {
			workspaces: list(summary.workspaces),
			agents: list(summary.agents),
			slots: summary.slots
		}),
		say('cli.runner.next')
	].join('\n');
}
