import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from '../db';
import * as board from '../domain/board';
import type { Actor } from '../domain/core';
import * as runs from '../domain/runs';
import { subscribe, type StudioEvent } from '../events';
import { startRunner } from '../runner';
import { setSecret } from '../secrets';
import { eventStream } from '../sse';
import { builtinExecutor } from './builtin';

const user: Actor = { kind: 'user' };
const KEY = 'sk-cloud-provider-key-4711';

type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
type Turn =
	| {
			thinking?: string;
			text?: string;
			call?: { id: string; name: string; args: object };
			usage?: Usage;
	  }
	| { status: number; body: object };
type Received = { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };

const frame = (data: object) =>
	`event: ${'type' in data ? data.type : 'message'}\ndata: ${JSON.stringify(data)}\n\n`;

/** A message as the Anthropic Messages API streams it: thinking, text and tool use as content blocks. */
function anthropicFrames(turn: Exclude<Turn, { status: number }>): string[] {
	const { input, output, cacheRead = 0, cacheWrite = 0 } = turn.usage ?? { input: 100, output: 10 };
	const usage = {
		input_tokens: input - cacheRead - cacheWrite,
		cache_read_input_tokens: cacheRead,
		cache_creation_input_tokens: cacheWrite,
		output_tokens: 1
	};
	const block = (index: number, start: object, deltas: object[]) => [
		frame({ type: 'content_block_start', index, content_block: start }),
		...deltas.map((delta) => frame({ type: 'content_block_delta', index, delta })),
		frame({ type: 'content_block_stop', index })
	];
	const blocks: [start: object, deltas: object[]][] = [];
	if (turn.thinking)
		blocks.push([
			{ type: 'thinking', thinking: '' },
			[
				{ type: 'thinking_delta', thinking: turn.thinking },
				{ type: 'signature_delta', signature: 'sig' }
			]
		]);
	if (turn.text)
		blocks.push([{ type: 'text', text: '' }, [{ type: 'text_delta', text: turn.text }]]);
	if (turn.call)
		blocks.push([
			{ type: 'tool_use', id: turn.call.id, name: turn.call.name, input: {} },
			[{ type: 'input_json_delta', partial_json: JSON.stringify(turn.call.args) }]
		]);
	return [
		frame({
			type: 'message_start',
			message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], usage }
		}),
		...blocks.flatMap(([start, deltas], index) => block(index, start, deltas)),
		frame({
			type: 'message_delta',
			delta: { stop_reason: turn.call ? 'tool_use' : 'end_turn', stop_sequence: null },
			usage: { output_tokens: output }
		}),
		frame({ type: 'message_stop' })
	];
}

/** A response as the OpenAI Responses API streams it: reasoning summary, message and function call as output items. */
function openaiFrames(turn: Exclude<Turn, { status: number }>): string[] {
	const { input, output, cacheRead = 0, cacheWrite } = turn.usage ?? { input: 100, output: 10 };
	const items: string[] = [];
	if (turn.thinking)
		items.push(
			frame({
				type: 'response.output_item.added',
				output_index: 0,
				item: { type: 'reasoning', id: 'rs_1' }
			}),
			frame({ type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 0 }),
			frame({
				type: 'response.reasoning_summary_text.delta',
				item_id: 'rs_1',
				summary_index: 0,
				delta: turn.thinking
			}),
			frame({ type: 'response.reasoning_summary_part.done', item_id: 'rs_1', summary_index: 0 }),
			frame({
				type: 'response.output_item.done',
				output_index: 0,
				item: { type: 'reasoning', id: 'rs_1' }
			})
		);
	if (turn.text)
		items.push(
			frame({
				type: 'response.output_item.added',
				output_index: 1,
				item: { type: 'message', id: 'msg_1' }
			}),
			frame({
				type: 'response.output_text.delta',
				item_id: 'msg_1',
				output_index: 1,
				delta: turn.text
			}),
			frame({
				type: 'response.output_item.done',
				output_index: 1,
				item: { type: 'message', id: 'msg_1' }
			})
		);
	if (turn.call) {
		const { id, name, args } = turn.call;
		const fc = { type: 'function_call', id: 'fc_1', call_id: id, name };
		items.push(
			frame({
				type: 'response.output_item.added',
				output_index: 2,
				item: { ...fc, arguments: '' }
			}),
			frame({
				type: 'response.function_call_arguments.delta',
				item_id: 'fc_1',
				output_index: 2,
				delta: JSON.stringify(args)
			}),
			frame({
				type: 'response.output_item.done',
				output_index: 2,
				item: { ...fc, arguments: JSON.stringify(args), status: 'completed' }
			})
		);
	}
	const usage = {
		input_tokens: input,
		input_tokens_details: {
			cached_tokens: cacheRead,
			...(cacheWrite && { cache_write_tokens: cacheWrite })
		},
		output_tokens: output,
		output_tokens_details: { reasoning_tokens: 0 }
	};
	return [
		frame({ type: 'response.created', response: { id: 'resp_1', created_at: 0, model: 'm' } }),
		...items,
		frame({ type: 'response.completed', response: { incomplete_details: null, usage } })
	];
}

function answer(response: ServerResponse, path: string, turn: Turn | undefined) {
	if (!turn) return response.writeHead(500).end('{"error":{"message":"no turn left"}}');
	if ('status' in turn)
		return response
			.writeHead(turn.status, { 'content-type': 'application/json' })
			.end(JSON.stringify(turn.body));
	const frames = path.endsWith('/messages') ? anthropicFrames(turn) : openaiFrames(turn);
	response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frames.join(''));
}

/** A local server speaking the Anthropic Messages and OpenAI Responses wire formats; each request takes the next turn. */
async function startCloud(...turns: Turn[]) {
	const received: Received[] = [];
	const server = createServer((request, response) => {
		let body = '';
		request.on('data', (chunk) => (body += chunk));
		request.on('end', () => {
			received.push({ path: request.url!, headers: request.headers, body: JSON.parse(body) });
			answer(response, request.url!, turns.shift());
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	cleanups.push(() => {
		server.closeAllConnections();
		server.close();
	});
	// the real HTTP client, with the providers' public hosts pointed at the local server
	const fetch: typeof globalThis.fetch = (input, init) =>
		globalThis.fetch(
			String(input).replace(/^https:\/\/api\.(anthropic|openai)\.com/, origin),
			init
		);
	return { fetch, received };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	vi.unstubAllEnvs();
});

function setup(profile: Partial<runs.Profile>) {
	vi.stubEnv('STUDIO_SECRET_KEY', randomBytes(32).toString('base64')); // so that the test writes no key file
	const db = openDb(':memory:');
	migrate(db);
	setSecret(db, 'cloud-key', KEY);
	const projectId = board.createProject(db, user, { key: 'CLD', name: 'Cloud' }).id;
	const ticketId = board.createTicket(db, user, projectId, { title: 'Refine the export' }).id;
	const profileId = runs.createProfile(db, user, {
		name: 'Cloud',
		executor: 'builtin',
		provider: 'anthropic',
		model: 'claude-sonnet-5',
		api_key_ref: 'secret:cloud-key',
		pool: 'cloud',
		...profile
	}).id;
	const busEvents: StudioEvent[] = [];
	cleanups.push(subscribe((event) => busEvents.push(event)));
	const run = (id: number) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id)!;
	const events = (id: number) =>
		db
			.prepare('SELECT type, payload FROM run_events WHERE run_id = ? ORDER BY seq')
			.all(id)
			.map((e) => ({ type: e.type as string, payload: JSON.parse(e.payload as string) }));
	const comments = () => db.prepare('SELECT body FROM comments ORDER BY id').all();
	const start = (fetch: typeof globalThis.fetch) => {
		const runner = startRunner(db, { builtin: builtinExecutor(db, { fetch }) });
		cleanups.push(runner.stop);
		return runs.createRun(db, user, { ticketId, profileId }).id;
	};
	return { db, projectId, run, events, comments, busEvents, start };
}

const ended = (state: () => unknown) =>
	vi.waitFor(() => expect(state()).not.toMatch(/^(queued|running)$/), { timeout: 5000 });

const stepLogs = (events: { type: string; payload: Record<string, unknown> }[]) =>
	events.filter((e) => e.type === 'log' && e.payload.kind === 'step').map((e) => e.payload);

/** The messages a browser showing the project receives over SSE. */
function browser(projectId: number) {
	const reader = eventStream((event) => event.projectId === projectId).getReader();
	cleanups.push(() => void reader.cancel());
	const decoder = new TextDecoder();
	const frames: string[] = [];
	void (async () => {
		for (let read = await reader.read(); !read.done; read = await reader.read())
			frames.push(decoder.decode(read.value));
	})();
	return frames;
}

describe.each([
	{ provider: 'anthropic', model: 'claude-sonnet-5', path: '/v1/messages' },
	{ provider: 'openai', model: 'gpt-6-sol', path: '/v1/responses' }
])('builtin executor with $provider', ({ provider, model, path }) => {
	it('works a run with a tool call and prices each step from the catalog, cache reads and writes at their own rates', async () => {
		const { run, events, comments, start } = setup({ provider, model });
		const cloud = await startCloud(
			{
				thinking: 'A comment is enough.',
				text: 'I will comment.',
				call: { id: 'call-1', name: 'add_comment', args: { text: 'from the cloud' } },
				usage: { input: 1000, output: 50 }
			},
			{ text: 'Done.', usage: { input: 1300, output: 20, cacheRead: 1000, cacheWrite: 100 } }
		);
		const runId = start(cloud.fetch);
		await ended(() => run(runId).state);

		expect(cloud.received.map((r) => r.path)).toEqual([path, path]);
		expect(comments()).toEqual([{ body: 'from the cloud' }]);
		// input 2, cache read 0.2, cache write 2.5, output 10 USD per million tokens
		const first = (1000 * 2 + 50 * 10) / 1e6;
		const second = (200 * 2 + 1000 * 0.2 + 100 * 2.5 + 20 * 10) / 1e6;
		const [step1, step2] = stepLogs(events(runId));
		expect(step1).toMatchObject({ tokensIn: 1000, tokensOut: 50 });
		expect(step1.cost).toBeCloseTo(first, 12);
		expect(step2).toMatchObject({
			tokensIn: 1300,
			tokensOut: 20,
			cachedInputTokens: 1000,
			cacheWriteTokens: 100
		});
		expect(step2.cost).toBeCloseTo(second, 12);
		expect(step2).not.toHaveProperty('priced');
		expect(run(runId)).toMatchObject({ state: 'succeeded', tokens_in: 2300, tokens_out: 70 });
		expect(run(runId).cost).toBeCloseTo(first + second, 12);
		expect(events(runId).find((e) => e.type === 'reasoning')!.payload.text).toBe(
			'A comment is enough.'
		);
	});

	it('counts a model without a catalog price as 0 and says so in the step', async () => {
		const { run, events, start } = setup({ provider, model: `${model}-preview-x` });
		const cloud = await startCloud({ text: 'Done.', usage: { input: 1000, output: 50 } });
		const runId = start(cloud.fetch);
		await ended(() => run(runId).state);

		expect(stepLogs(events(runId))).toMatchObject([{ cost: 0, priced: false }]);
		expect(run(runId)).toMatchObject({ state: 'succeeded', tokens_in: 1000, cost: 0 });
	});

	it('fails with provider_auth before any request when the profile has no key, and never takes one from the environment', async () => {
		vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-the-environment');
		vi.stubEnv('OPENAI_API_KEY', 'sk-from-the-environment');
		const { run, comments, start } = setup({ provider, model, api_key_ref: null });
		const cloud = await startCloud({ text: 'Done.' });
		const runId = start(cloud.fetch);
		await ended(() => run(runId).state);

		expect(cloud.received).toEqual([]);
		expect(run(runId)).toMatchObject({
			state: 'failed',
			error: expect.stringContaining('[provider_auth]')
		});
		expect(comments().at(-1)!.body).toContain(
			'Ausweg: Key als Secret speichern und als secret:<name> eintragen.'
		);
	});

	it('sends the key from the secrets store only to the official endpoint and keeps it out of every event, SSE frame, error and comment', async () => {
		vi.stubEnv('ANTHROPIC_BASE_URL', 'http://elsewhere.invalid/v1');
		vi.stubEnv('OPENAI_BASE_URL', 'http://elsewhere.invalid/v1');
		const { projectId, run, events, comments, busEvents, start } = setup({ provider, model });
		const frames = browser(projectId);
		const cloud = await startCloud(
			{
				thinking: `The header says ${KEY}.`,
				text: `Using ${KEY}.`,
				call: { id: 'call-1', name: 'add_comment', args: { text: `key ${KEY}` } }
			},
			{
				status: 401,
				body: { error: { type: 'authentication_error', message: `invalid key ${KEY}` } }
			}
		);
		const runId = start(cloud.fetch);
		await ended(() => run(runId).state);

		const sent = cloud.received[0].headers;
		expect(sent['x-api-key'] ?? sent.authorization).toMatch(new RegExp(`(Bearer )?${KEY}$`));
		expect(run(runId)).toMatchObject({
			state: 'failed',
			error: expect.stringContaining('[provider_auth]')
		});
		await vi.waitFor(() => expect(frames.join('')).toContain('"to":"failed"'));
		const everything = JSON.stringify([events(runId), busEvents, run(runId), comments(), frames]);
		expect(everything).toContain('[secret:cloud-key]');
		expect(everything).not.toContain(KEY);
		expect(everything).not.toContain(KEY.slice(-8));
	});
});

describe('thinking and sampling in the cloud request', () => {
	const firstRequest = async (profile: Partial<runs.Profile>) => {
		const { run, start } = setup(profile);
		const cloud = await startCloud({ text: 'Done.' });
		const runId = start(cloud.fetch);
		await ended(() => run(runId).state);
		expect(run(runId).state).toBe('succeeded');
		return cloud.received[0].body;
	};

	it.each([
		['catalog default', {}, { type: 'adaptive', display: 'summarized' }, 'high'],
		['on', { thinking: true }, { type: 'adaptive', display: 'summarized' }, 'high'],
		['off', { thinking: false }, { type: 'disabled' }, undefined]
	])(
		'maps thinking %s to Anthropic thinking and effort from the catalog, without sampling',
		async (_, params, thinking, effort) => {
			const body = await firstRequest({ params: { ...params, temperature: 0.6, top_p: 0.9 } });
			expect(body.thinking).toEqual(thinking);
			expect((body.output_config as { effort?: string } | undefined)?.effort).toBe(effort);
			expect(body.max_tokens).toBe(32000);
			expect(body).not.toHaveProperty('temperature');
			expect(body).not.toHaveProperty('top_p');
			expect(body).not.toHaveProperty('chat_template_kwargs');
		}
	);

	it('keeps thinking on at the lowest effort for a model that should not switch it off', async () => {
		const body = await firstRequest({ model: 'claude-opus-5', params: { thinking: false } });
		expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
		expect(body.output_config).toEqual({ effort: 'low' });
	});

	it.each([
		['catalog default', {}, { effort: 'medium', summary: 'auto' }],
		['on', { thinking: true }, { effort: 'medium', summary: 'auto' }],
		['off', { thinking: false }, { effort: 'none' }]
	])(
		'maps thinking %s to OpenAI reasoning effort from the catalog, unstored and without sampling',
		async (_, params, reasoning) => {
			const body = await firstRequest({
				provider: 'openai',
				model: 'gpt-6-sol',
				params: { ...params, temperature: 0.6 }
			});
			expect(body.reasoning).toEqual(reasoning);
			expect(body.store).toBe(false);
			expect(body.max_output_tokens).toBe(32000);
			expect(body).not.toHaveProperty('temperature');
		}
	);

	it('sends no thinking options for a cloud model the catalog does not know', async () => {
		const anthropic = await firstRequest({
			model: 'claude-unknown-9',
			params: { temperature: 0.6 }
		});
		expect(anthropic).not.toHaveProperty('thinking');
		expect(anthropic).not.toHaveProperty('output_config');
		expect(anthropic).not.toHaveProperty('temperature');
		const openai = await firstRequest({ provider: 'openai', model: 'gpt-unknown-9' });
		expect(openai).not.toHaveProperty('reasoning');
	});
});
