import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from '../db';
import * as board from '../domain/board';
import type { Actor } from '../domain/core';
import * as runs from '../domain/runs';
import { subscribe, type StudioEvent } from '../events';
import { mcpEndpoint } from '../mcp';
import { startRunner, type Executor, type ExecutorResult, type RunContext } from '../runner';
import { setSecret } from '../secrets';
import { builtinExecutor, type BuiltinOptions } from './builtin';
import { requestSettings } from './provider';

const user: Actor = { kind: 'user' };

/** What the fake model sends in one response: deltas and tool calls in order, or a pause the test controls. */
type Chunk = { reasoning: string } | { text: string } | { call: { id: string; name: string; args: object } } | { pause: () => unknown } | 'hang';
type Reply = { chunks: Chunk[]; finish?: 'stop' | 'tool_calls' | 'length'; usage?: [input: number, output: number] } | { status: number; error: string };
type ProviderRequest = { body: Record<string, unknown>; headers: Headers; signal: AbortSignal };

const encoder = new TextEncoder();
const sse = (data: object) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
const delta = (delta: object, finishReason: string | null = null) =>
	sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finishReason }] });

function deltaOf(chunk: Exclude<Chunk, 'hang' | { pause: () => unknown }>) {
	if ('reasoning' in chunk) return delta({ reasoning_content: chunk.reasoning });
	if ('text' in chunk) return delta({ content: chunk.text });
	const { id, name, args } = chunk.call;
	return delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
}

/** An OpenAI-compatible chat completion stream as llama.cpp sends it, ending with the usage chunk. */
async function* stream(reply: Extract<Reply, { chunks: Chunk[] }>, signal: AbortSignal) {
	for (const chunk of reply.chunks) {
		if (chunk === 'hang') await new Promise((_, fail) => signal.addEventListener('abort', () => fail(signal.reason)));
		else if ('pause' in chunk) await chunk.pause();
		else yield deltaOf(chunk);
	}
	const calls = reply.chunks.some((chunk) => typeof chunk === 'object' && 'call' in chunk);
	yield delta({}, reply.finish ?? (calls ? 'tool_calls' : 'stop'));
	const [input, output] = reply.usage ?? [100, 10];
	yield sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage: { prompt_tokens: input, completion_tokens: output } });
	yield encoder.encode('data: [DONE]\n\n');
}

function readable(chunks: AsyncGenerator<Uint8Array>) {
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { value, done } = await chunks.next();
			if (done) controller.close();
			else controller.enqueue(value);
		}
	});
}

/** A model server that answers each request with the next recorded reply; a request beyond the script fails the test. */
function fakeProvider(...replies: Reply[]) {
	const requests: ProviderRequest[] = [];
	const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
		const signal = init!.signal!;
		requests.push({ body: JSON.parse(init!.body as string), headers: new Headers(init!.headers), signal });
		const reply = replies.shift();
		if (!reply) throw new Error(`unexpected provider request ${requests.length}`);
		if ('status' in reply) return Response.json({ error: { message: reply.error } }, { status: reply.status });
		return new Response(readable(stream(reply, signal)), { headers: { 'content-type': 'text/event-stream' } });
	};
	return { fetch: fetch as typeof globalThis.fetch, requests };
}

const call = (id: string, name: string, args: object = {}): Chunk => ({ call: { id, name, args } });

const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

function setup(profile: Partial<runs.Profile> = {}) {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const ticketId = board.createTicket(db, user, projectId, { title: 'Refine the export', description: 'Export tickets as CSV.' }).id;
	const columns = Object.fromEntries(db.prepare('SELECT name, id FROM columns WHERE project_id = ?').all(projectId).map((c) => [c.name, c.id])) as Record<string, number>;
	const profileId = runs.createProfile(db, user, {
		name: 'Local',
		executor: 'builtin',
		provider: 'openai-compatible',
		base_url: 'http://model.test/v1',
		model: 'ornith-1.5-35b',
		...profile
	}).id;
	const busEvents: StudioEvent[] = [];
	cleanups.push(subscribe((event) => busEvents.push(event)));
	const queue = () => runs.createRun(db, user, { ticketId, profileId }).id;
	const run = (id: number) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id)!;
	const events = (id: number) =>
		db
			.prepare('SELECT seq, type, idempotency_key AS key, payload FROM run_events WHERE run_id = ? ORDER BY seq')
			.all(id)
			.map((e) => ({ ...(e as { seq: number; type: string; key: string | null }), payload: JSON.parse(e.payload as string) }));
	const comments = () => db.prepare('SELECT author_kind, run_id, body FROM comments ORDER BY id').all();
	return { db, ticketId, columns, profileId, busEvents, queue, run, events, comments };
}

/** Starts a runner with the builtin executor; `executed` collects each run's context and result. */
function startBuiltin(db: ReturnType<typeof setup>['db'], options: BuiltinOptions, coldStart?: Parameters<typeof startRunner>[3]) {
	const builtin = builtinExecutor(db, options);
	const executed: { run: RunContext; result: ExecutorResult }[] = [];
	const executor: Executor = {
		async execute(run, io) {
			const result = await builtin.execute(run, io);
			executed.push({ run, result });
			return result;
		}
	};
	const runner = startRunner(db, { builtin: executor }, undefined, coldStart);
	cleanups.push(runner.stop);
	return { runner, executed };
}

const ended = (state: () => unknown) => vi.waitFor(() => expect(state()).not.toMatch(/^(queued|running)$/), { timeout: 3000 });

describe('builtin executor', () => {
	it('records the prompt, then reasoning, message, tool call, tool result and step log of every step, and sums the usage in the run', async () => {
		const { db, queue, run, events, comments } = setup();
		const provider = fakeProvider(
			{ chunks: [{ reasoning: 'The ticket needs a comment.\n' }, { text: 'I will comment.' }, call('call-1', 'add_comment', { text: 'first' })], usage: [1000, 50] },
			{ chunks: [call('call-2', 'add_comment', { text: 'second' })], usage: [1200, 20] },
			{ chunks: [{ text: 'Done.' }], usage: [1300, 5] }
		);
		startBuiltin(db, { fetch: provider.fetch });
		const runId = queue();
		await ended(() => run(runId).state);

		expect(run(runId)).toMatchObject({ state: 'succeeded', tokens_in: 3500, tokens_out: 75, cost: 0 });
		const recorded = events(runId).map(({ type, key, payload }) => ({ type, key, kind: payload.kind, step: payload.step }));
		expect(recorded).toEqual([
			{ type: 'log', key: null, kind: 'prompt', step: undefined },
			{ type: 'reasoning', key: 'step:1:reasoning', kind: undefined, step: 1 },
			{ type: 'message', key: 'step:1:message', kind: undefined, step: 1 },
			{ type: 'tool_call', key: 'call-1', kind: undefined, step: 1 },
			{ type: 'tool_result', key: 'call-1:result', kind: undefined, step: 1 },
			{ type: 'log', key: 'step:1', kind: 'step', step: 1 },
			{ type: 'tool_call', key: 'call-2', kind: undefined, step: 2 },
			{ type: 'tool_result', key: 'call-2:result', kind: undefined, step: 2 },
			{ type: 'log', key: 'step:2', kind: 'step', step: 2 },
			{ type: 'message', key: 'step:3:message', kind: undefined, step: 3 },
			{ type: 'log', key: 'step:3', kind: 'step', step: 3 },
			{ type: 'message', key: 'handoff', kind: undefined, step: undefined }
		]);
		const [prompt, reasoning, , toolCall, toolResult, stepLog] = events(runId).map((e) => e.payload);
		expect(prompt).toEqual({ kind: 'prompt', estimate: expect.any(Number), toolTokens: expect.any(Number) });
		expect(prompt.toolTokens).toBeGreaterThan(1000);
		expect(reasoning).toEqual({ step: 1, text: 'The ticket needs a comment.\n', charsTotal: 28 });
		expect(toolCall).toEqual({ step: 1, tool: 'add_comment', args: { text: 'first' } });
		expect(toolResult).toEqual({ step: 1, tool: 'add_comment', result: '{"comment_id":1}', isError: false });
		expect(stepLog).toEqual({ kind: 'step', step: 1, finishReason: 'tool-calls', ms: expect.any(Number) });
		expect(events(runId).at(-1)!.payload).toEqual({ text: 'Done.' });
		expect(comments()).toMatchObject([{ body: 'first' }, { body: 'second' }]);
		expect(provider.requests[0].body).toMatchObject({ max_tokens: 32000, temperature: 0.6, chat_template_kwargs: { enable_thinking: true } });
		expect(provider.requests[0].body.messages).toMatchObject([{ role: 'system' }, { role: 'user', content: expect.stringContaining('Refine the export') }]);
	});

	it('calls studio tools in-process with the run token, which no longer works once the run has ended', async () => {
		const { db, queue, run, comments } = setup();
		vi.stubGlobal('fetch', () => Promise.reject(new Error('no network: studio tools must not go over HTTP')));
		const provider = fakeProvider({ chunks: [call('call-1', 'add_comment', { text: 'from the agent' })] }, { chunks: [{ text: 'Done.' }] });
		const { executed } = startBuiltin(db, { fetch: provider.fetch });
		const runId = queue();
		await ended(() => run(runId).state);

		expect(run(runId).state).toBe('succeeded');
		expect(comments()).toEqual([{ author_kind: 'agent', run_id: runId, body: 'from the agent' }]);
		const token = executed[0].run.token;
		const request = new Request('http://127.0.0.1:3000/mcp', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
		});
		expect((await mcpEndpoint(db)(request)).status).toBe(401);
	});

	it('reports thinking at most once a second with the last complete line, and the first delta ends the cold start watch', async () => {
		const { db, queue, run, events, busEvents } = setup();
		vi.useFakeTimers({ toFake: ['Date'] });
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		// the executor first takes in the deltas sent so far, then the clock moves on
		const oneSecondLater = { pause: () => sleep(20).then(() => vi.setSystemTime(Date.now() + 1100)) };
		const slowModel = { pause: () => sleep(150) };
		const provider = fakeProvider({
			chunks: [{ reasoning: 'First thought\nsecond' }, { reasoning: ' half\n' }, oneSecondLater, { reasoning: 'third line\nfourth' }, slowModel, { text: 'Done.' }]
		});
		startBuiltin(db, { fetch: provider.fetch }, { hintAfterMs: 50, failAfterMs: 100 });
		const runId = queue();
		await ended(() => run(runId).state);

		expect(run(runId).state).toBe('succeeded');
		expect(events(runId).filter((e) => e.payload.phase === 'model_loading')).toEqual([]);
		const phases = busEvents.filter((e) => e.type === 'run.phase');
		expect(phases.map((p) => [p.name, p.lastLine])).toEqual([
			['thinking', 'First thought'],
			['thinking', 'third line']
		]);
	});

	it('stops the provider request on cancel, records nothing more and frees the pool slot', async () => {
		const { db, queue, run, events, busEvents } = setup();
		const provider = fakeProvider({ chunks: [{ reasoning: 'Let me think\n' }, 'hang'] }, { chunks: [{ text: 'Done.' }] });
		const { runner } = startBuiltin(db, { fetch: provider.fetch });
		const cancelled = queue();
		const waiting = queue();
		await vi.waitFor(() => expect(busEvents.some((e) => e.type === 'run.phase' && e.runId === cancelled)).toBe(true));
		const recordedBeforeCancel = events(cancelled);

		runner.cancel(cancelled);
		await ended(() => run(waiting).state);

		expect(provider.requests[0].signal.aborted).toBe(true);
		expect(run(cancelled).state).toBe('cancelled');
		expect(events(cancelled)).toEqual(recordedBeforeCancel);
		expect(run(waiting).state).toBe('succeeded');
	});

	it('fails with step_limit and a way out when max_steps runs out without moving the ticket', async () => {
		const { db, queue, run, comments } = setup({ max_steps: 2 });
		const provider = fakeProvider({ chunks: [call('call-1', 'add_comment', { text: 'one' })] }, { chunks: [call('call-2', 'add_comment', { text: 'two' })] });
		startBuiltin(db, { fetch: provider.fetch });
		const runId = queue();
		await ended(() => run(runId).state);

		expect(provider.requests).toHaveLength(2);
		expect(run(runId)).toMatchObject({ state: 'failed', error: expect.stringMatching(/^\[step_limit\] .*2 Schritt/) });
		expect(comments().at(-1)!.body).toMatch(/Ausweg: .*max_steps.*kleiner/);
	});

	it('succeeds when max_steps runs out after the run has moved its ticket', async () => {
		const { db, queue, run, columns } = setup({ max_steps: 2 });
		const provider = fakeProvider(
			{ chunks: [call('call-1', 'move_ticket', { column_id: columns['In Arbeit'] })] },
			{ chunks: [call('call-2', 'add_comment', { text: 'moved' })] }
		);
		startBuiltin(db, { fetch: provider.fetch });
		const runId = queue();
		await ended(() => run(runId).state);

		expect(run(runId).state).toBe('succeeded');
	});

	it('pauses without a follow-up run once the agent has asked the human', async () => {
		const { db, queue, run, ticketId } = setup();
		const provider = fakeProvider({ chunks: [call('call-1', 'request_human', { question: 'Which columns go into the export?' })] });
		startBuiltin(db, { fetch: provider.fetch });
		const runId = queue();
		await ended(() => run(runId).state);

		expect(run(runId).state).toBe('paused');
		expect(provider.requests).toHaveLength(1);
		expect(board.ticket(db, ticketId).column_name).toBe('Human Intervention');
		expect(db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(1);
	});

	it('fails with provider_error and a way out when the model server rejects the request', async () => {
		const { db, queue, run, comments } = setup();
		const provider = fakeProvider({ status: 400, error: 'the request exceeds the available context size' });
		startBuiltin(db, { fetch: provider.fetch });
		const runId = queue();
		await ended(() => run(runId).state);

		expect(run(runId)).toMatchObject({ state: 'failed', error: expect.stringMatching(/^\[provider_error\] .*exceeds the available context size/) });
		expect(comments().at(-1)!.body).toMatch(/Ausweg: .*base_url/);
	});

	it('fails with provider_inactive when the model goes silent after it has started to answer', async () => {
		const { db, queue, run } = setup();
		const provider = fakeProvider({ chunks: [{ text: 'Let me' }, 'hang'] });
		startBuiltin(db, { fetch: provider.fetch, inactivityMs: 50 });
		const runId = queue();
		await ended(() => run(runId).state);

		expect(run(runId)).toMatchObject({ state: 'failed', error: expect.stringMatching(/^\[provider_inactive\] /) });
		expect(provider.requests[0].signal.aborted).toBe(true);
	});

	it('ends a parked run after its step, paused with a resume that points at the handoff', async () => {
		const { db, queue, run, events } = setup();
		let park = () => {};
		const provider = fakeProvider({ chunks: [{ text: 'Commenting now.' }, { pause: () => park() }, call('call-1', 'add_comment', { text: 'last words' })] });
		const { runner, executed } = startBuiltin(db, { fetch: provider.fetch });
		const runId = queue();
		park = () => runner.park(runId, 'quota', '2099-01-01T00:00:00Z');
		await ended(() => run(runId).state);

		expect(run(runId).state).toBe('paused');
		expect(provider.requests).toHaveLength(1);
		const handoff = events(runId).find((e) => e.key === 'handoff')!;
		expect(handoff.payload).toEqual({ text: 'Commenting now.' });
		expect(executed[0].result).toEqual({ state: 'paused', resume: { reason: 'quota', notBefore: '2099-01-01T00:00:00Z', handoffSeq: handoff.seq } });
		expect(db.prepare('SELECT state, resume_reason FROM runs WHERE resumed_from_run_id = ?').get(runId)).toEqual({ state: 'queued', resume_reason: 'quota' });
	});

	it('keeps a secret out of every event, phase, error and comment, even where the reasoning is cut', async () => {
		const secret = 'sk-test-provider-key-0815';
		vi.stubEnv('STUDIO_SECRET_KEY', randomBytes(32).toString('base64')); // so that the test writes no key file
		const { db, queue, run, events, busEvents, comments, ticketId } = setup({ api_key_ref: 'secret:provider-key' });
		setSecret(db, 'provider-key', secret);
		board.updateTicket(db, user, ticketId, { description: `The key is ${secret}.` });
		// the reasoning is cut to its last 20,000 characters right inside the secret
		const longReasoning = `I saw ${secret}\n${'x'.repeat(19_990)}`;
		const provider = fakeProvider(
			{ chunks: [{ reasoning: `The key is ${secret}\n` }, { reasoning: longReasoning }, { text: `Using ${secret}.` }, call('call-1', 'get_ticket')] },
			{ status: 401, error: `Incorrect API key provided: ${secret}` }
		);
		startBuiltin(db, { fetch: provider.fetch });
		const runId = queue();
		await ended(() => run(runId).state);

		expect(provider.requests[0].headers.get('authorization')).toBe(`Bearer ${secret}`);
		expect(run(runId)).toMatchObject({ state: 'failed', error: expect.stringContaining('[provider_error]') });
		const everything = JSON.stringify([events(runId), busEvents, run(runId), comments()]);
		expect(everything).toContain('[secret:provider-key]');
		expect(everything).not.toContain(secret);
		expect(everything).not.toContain(secret.slice(-8));
	});
});

describe('request settings', () => {
	it('takes sampling, thinking and the output limit from the profile first, then from the catalog for the role', () => {
		const qwen = { model: 'qwen3.6-35b', max_tokens: null };
		expect(requestSettings({ ...qwen, params: { role: 'refine', top_p: 0.5 } })).toEqual({
			maxOutputTokens: 8000,
			providerOptions: { studio: { temperature: 0.7, top_p: 0.5, top_k: 20, min_p: 0, presence_penalty: 1.5, chat_template_kwargs: { enable_thinking: false } } }
		});
		expect(requestSettings({ ...qwen, max_tokens: 4000, params: { role: 'refine', thinking: true } })).toMatchObject({
			maxOutputTokens: 4000,
			providerOptions: { studio: { temperature: 0.6, chat_template_kwargs: { enable_thinking: true } } }
		});
		expect(requestSettings({ model: 'unknown-model', max_tokens: null, params: {} })).toEqual({ maxOutputTokens: undefined, providerOptions: { studio: {} } });
	});
});
