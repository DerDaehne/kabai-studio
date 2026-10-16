// `kabai-studio runner start`: keeps this machine connected to studio. It reads the credential and the local floor that
// `runner pair` left behind and holds one WebSocket to /runner open, reconnecting with backoff. It opens no database and
// no listening port. Node builtins, ws and relative .ts imports only: server.ts loads this file directly, without Vite.
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { translate, type Locale, type MessageKey } from '../i18n/index.ts';
import { isLoopbackHost } from './auth.ts';
import { defaultConfigDir } from './data-dir.ts';
import { DomainError, formatError } from './domain/error.ts';
import { CREDENTIAL_FILE, FLOOR_FILE, readFloor, type PairResult } from './runner-pair.ts';
import { floorSummary } from './runner-floor.ts';
import { CLOSE, DEAD_AFTER_MS, PROTOCOL_VERSION, RUNNER_PATH } from './runner-protocol.ts';

const MAX_REFUSAL_BODY = 4096;
export const MIN_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;

export type StartContext = {
	env: Record<string, string | undefined>;
	platform: string;
	locale: Locale;
	version: string;
	log: (line: string) => void;
	/** Aborting stops the runner for good (Ctrl+C, service stop). */
	signal?: AbortSignal;
	random?: () => number;
	createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
};

type Say = (key: MessageKey, params?: Record<string, string | number>) => string;
type Credential = { studioOrigin: string; name: string; credential: string };

/** Runs until the credential is refused, the protocol differs, or the signal aborts; every end is `{exitCode, message}`. */
export async function runnerStartCommand(ctx: StartContext): Promise<PairResult> {
	const say: Say = (key, params) => translate(ctx.locale, key, params);
	try {
		const setup = prepare(ctx, say);
		return await keepConnected(setup, ctx, say);
	} catch (err) {
		if (!(err instanceof DomainError)) throw err;
		return { exitCode: 1, message: formatError(err) };
	}
}

function prepare(ctx: Pick<StartContext, 'env' | 'platform'>, say: Say) {
	const dir = defaultConfigDir(ctx.platform, ctx.env);
	const credential = readCredential(join(dir, CREDENTIAL_FILE), say);
	const url = channelUrl(credential.studioOrigin, say);
	const floorFile = join(dir, FLOOR_FILE);
	if (!isReadable(floorFile))
		throw new DomainError(
			'runner_json_missing',
			say('cli.runner.start.floorMissing', { file: floorFile }),
			say('cli.runner.start.notPaired.hint', { origin: credential.studioOrigin })
		);
	const floor = readFloor(floorFile, credential.studioOrigin, say);
	if (!floor) throw new Error('unreachable: floor file checked above');
	return { credential, url, summary: floorSummary(floor) };
}

const isReadable = (file: string) => {
	try {
		readFileSync(file);
		return true;
	} catch {
		return false;
	}
};

function readCredential(file: string, say: Say): Credential {
	let parsed: Partial<Credential> | null;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch (err) {
		const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
		throw new DomainError(
			missing ? 'not_paired' : 'credential_file_invalid',
			say(missing ? 'cli.runner.start.notPaired' : 'cli.runner.start.credentialInvalid', { file }),
			say('cli.runner.start.notPaired.hint', { origin: '<url>' })
		);
	}
	if (
		typeof parsed?.studioOrigin !== 'string' ||
		typeof parsed.name !== 'string' ||
		typeof parsed.credential !== 'string'
	)
		throw new DomainError(
			'credential_file_invalid',
			say('cli.runner.start.credentialInvalid', { file }),
			say('cli.runner.start.notPaired.hint', { origin: '<url>' })
		);
	return parsed as Credential;
}

/** wss:// for https, ws:// only for a studio on this machine: the credential never goes out unencrypted. */
export function channelUrl(studioOrigin: string, say: Say): string {
	const origin = URL.parse(studioOrigin);
	if (origin?.protocol === 'https:') return `wss://${origin.host}${RUNNER_PATH}`;
	if (origin?.protocol === 'http:' && isLoopbackHost(origin.hostname))
		return `ws://${origin.host}${RUNNER_PATH}`;
	throw new DomainError(
		'insecure_url',
		say('cli.runner.start.insecureUrl', { host: origin?.host ?? studioOrigin }),
		say('cli.runner.start.insecureUrl.hint')
	);
}

const fatal = (code: string, message: string, hint: string) => new DomainError(code, message, hint);

type Setup = ReturnType<typeof prepare>;

const keepConnected = (setup: Setup, ctx: StartContext, say: Say): Promise<PairResult> =>
	new Promise((resolve) => new Connection(setup, ctx, say, resolve).connect());

class Connection {
	private readonly setup: Setup;
	private readonly ctx: StartContext;
	private readonly say: Say;
	private readonly resolve: (result: PairResult) => void;
	private readonly rePair: string;
	private attempt = 0;
	private socket: WebSocket | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private deadTimer: ReturnType<typeof setTimeout> | undefined;
	private finished = false;

	constructor(setup: Setup, ctx: StartContext, say: Say, resolve: (result: PairResult) => void) {
		this.setup = setup;
		this.ctx = ctx;
		this.say = say;
		this.resolve = resolve;
		this.rePair = say('cli.runner.start.rePair.hint', { origin: setup.credential.studioOrigin });
		ctx.signal?.addEventListener('abort', () =>
			this.finish({ exitCode: 0, message: say('cli.runner.start.stopped') })
		);
	}

	connect() {
		if (this.finished) return;
		const { credential, url } = this.setup;
		const headers = { authorization: `Bearer ${credential.credential}` };
		const create =
			this.ctx.createSocket ??
			((target, h) => new WebSocket(target, { headers: h, maxPayload: 64 * 1024 }));
		const socket = create(url, headers);
		this.socket = socket;
		this.rearmDeadline();
		let welcomed = false;
		socket.on('open', () => socket.send(JSON.stringify(this.hello())));
		socket.on('ping', () => this.rearmDeadline());
		socket.on('message', (data) => {
			this.rearmDeadline();
			if (!welcomed && isWelcome(data.toString())) {
				welcomed = true;
				this.attempt = 0;
				this.ctx.log(
					this.say('cli.runner.start.connected', {
						origin: credential.studioOrigin,
						name: credential.name
					})
				);
				return;
			}
			this.ctx.log(this.say('cli.runner.start.frameNotSupported'));
			socket.close(1008, 'frame_not_supported');
		});
		socket.on('unexpected-response', (_request, response) => this.refused(socket, response));
		socket.on('error', () => {});
		socket.on('close', (code, reason) => this.closed(socket, code, reason.toString()));
	}

	private hello() {
		const { summary } = this.setup;
		return {
			type: 'hello',
			protocol: PROTOCOL_VERSION,
			version: this.ctx.version,
			slots: summary.slots,
			workspaces: summary.workspaces,
			agents: summary.agents
		};
	}

	private refused(socket: WebSocket, response: IncomingMessage) {
		let body = '';
		let settled = false;
		const settle = () => {
			if (settled || this.socket !== socket) return;
			settled = true;
			const error = this.refusal(response.statusCode ?? 0, bodyCode(body));
			if (error) return this.fail(error);
			this.socket = null;
			socket.terminate();
			this.scheduleRetry(`HTTP ${response.statusCode}`);
		};
		response.on('data', (chunk: Buffer) => {
			body += chunk.toString();
			if (body.length < MAX_REFUSAL_BODY) return;
			response.destroy();
			settle();
		});
		for (const event of ['end', 'close', 'error']) response.on(event, settle);
	}

	/** Fatal for 401 and 403; anything else (a proxy's 502, a deploy in progress) is worth another try. */
	private refusal(status: number, code: string): DomainError | null {
		if (status === 401)
			return fatal('credential_rejected', this.say('cli.runner.start.rejected'), this.rePair);
		if (status !== 403) return null;
		const known = code === 'browser_origin_forbidden' || code === 'insecure_transport';
		const key = known ? code : 'other';
		const params = { origin: this.setup.credential.studioOrigin };
		return fatal(
			known ? code : 'forbidden',
			this.say(`cli.runner.start.refused.${key}`, params),
			this.say(`cli.runner.start.refused.${key}.hint`)
		);
	}

	private closed(socket: WebSocket, code: number, reason: string) {
		clearTimeout(this.deadTimer);
		if (this.socket !== socket || this.finished) return;
		this.socket = null;
		if (code === CLOSE.revoked)
			return this.fail(
				fatal('credential_revoked', this.say('cli.runner.start.revoked'), this.rePair)
			);
		if (code === CLOSE.replaced)
			return this.fail(
				fatal(
					'replaced',
					this.say('cli.runner.start.replaced'),
					this.say('cli.runner.start.replaced.hint')
				)
			);
		if (code === CLOSE.badProtocol)
			return this.fail(
				fatal(
					'protocol_mismatch',
					this.say('cli.runner.start.protocol'),
					this.say('cli.runner.start.protocol.hint')
				)
			);
		this.scheduleRetry(printable(reason) || String(code));
	}

	private scheduleRetry(reason: string) {
		if (this.finished) return;
		this.attempt++;
		const ceiling = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (this.attempt - 1));
		const random = this.ctx.random ?? Math.random;
		const wait = Math.round(ceiling / 2 + (random() * ceiling) / 2);
		this.ctx.log(
			this.say('cli.runner.start.lost', { reason, seconds: Math.max(1, Math.round(wait / 1000)) })
		);
		this.retryTimer = setTimeout(() => this.connect(), wait);
	}

	private rearmDeadline() {
		clearTimeout(this.deadTimer);
		this.deadTimer = setTimeout(() => this.socket?.terminate(), DEAD_AFTER_MS);
	}

	private fail(error: DomainError) {
		this.finish({ exitCode: 1, message: formatError(error) });
	}

	private finish(result: PairResult) {
		if (this.finished) return;
		this.finished = true;
		clearTimeout(this.retryTimer);
		clearTimeout(this.deadTimer);
		this.socket?.terminate();
		this.resolve(result);
	}
}

/** The server's close reason goes to a terminal: no escape sequences, no control characters. */
const printable = (text: string) =>
	text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
		.replace(/\p{Cc}/gu, '')
		.slice(0, 100);

const isWelcome = (text: string) => {
	try {
		return JSON.parse(text)?.type === 'welcome';
	} catch {
		return false;
	}
};

/** The machine-readable code of a refusal's JSON body; a proxy's own error page has none. */
const bodyCode = (body: string) => {
	try {
		return String(JSON.parse(body).code ?? '');
	} catch {
		return '';
	}
};

/** The checks `runner start` makes before it connects, for callers that must not write anything unless they would pass. */
export function checkPairing(
	ctx: Pick<StartContext, 'env' | 'platform' | 'locale'>
): PairResult | undefined {
	try {
		prepare(ctx, (key, params) => translate(ctx.locale, key, params));
		return undefined;
	} catch (err) {
		if (!(err instanceof DomainError)) throw err;
		return { exitCode: 1, message: formatError(err) };
	}
}
