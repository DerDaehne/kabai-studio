/** What the fake model sends in one response: deltas and tool calls in order, or a pause the test controls. */
export type Chunk =
	| { reasoning: string }
	| { text: string }
	| { call: { id: string; name: string; args: object } }
	| { pause: () => unknown }
	| 'hang';
export type Reply =
	| {
			chunks: Chunk[];
			finish?: 'stop' | 'tool_calls' | 'length';
			usage?: [input: number, output: number, reasoning?: number];
	  }
	| { status: number; error: string };
export type ProviderRequest = {
	body: Record<string, unknown>;
	headers: Headers;
	signal: AbortSignal;
};

const encoder = new TextEncoder();
const sse = (data: object) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
const delta = (delta: object, finishReason: string | null = null) =>
	sse({
		id: 'chatcmpl-1',
		object: 'chat.completion.chunk',
		created: 0,
		model: 'm',
		choices: [{ index: 0, delta, finish_reason: finishReason }]
	});

function deltaOf(chunk: Exclude<Chunk, 'hang' | { pause: () => unknown }>) {
	if ('reasoning' in chunk) return delta({ reasoning_content: chunk.reasoning });
	if ('text' in chunk) return delta({ content: chunk.text });
	const { id, name, args } = chunk.call;
	return delta({
		tool_calls: [
			{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
		]
	});
}

/** An OpenAI-compatible chat completion stream as llama.cpp sends it, ending with the usage chunk. */
async function* stream(reply: Extract<Reply, { chunks: Chunk[] }>, signal: AbortSignal) {
	for (const chunk of reply.chunks) {
		if (chunk === 'hang')
			await new Promise((_, fail) => signal.addEventListener('abort', () => fail(signal.reason)));
		else if ('pause' in chunk) await chunk.pause();
		else yield deltaOf(chunk);
	}
	const calls = reply.chunks.some((chunk) => typeof chunk === 'object' && 'call' in chunk);
	yield delta({}, reply.finish ?? (calls ? 'tool_calls' : 'stop'));
	const [input, output, reasoning] = reply.usage ?? [100, 10];
	const details =
		reasoning === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoning } };
	yield sse({
		id: 'chatcmpl-1',
		object: 'chat.completion.chunk',
		created: 0,
		model: 'm',
		choices: [],
		usage: { prompt_tokens: input, completion_tokens: output, ...details }
	});
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
export function fakeProvider(...replies: Reply[]) {
	const requests: ProviderRequest[] = [];
	const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
		const signal = init!.signal!;
		requests.push({
			body: JSON.parse(init!.body as string),
			headers: new Headers(init!.headers),
			signal
		});
		const reply = replies.shift();
		if (!reply) throw new Error(`unexpected provider request ${requests.length}`);
		if ('status' in reply)
			return Response.json({ error: { message: reply.error } }, { status: reply.status });
		return new Response(readable(stream(reply, signal)), {
			headers: { 'content-type': 'text/event-stream' }
		});
	};
	return { fetch: fetch as typeof globalThis.fetch, requests };
}

export const call = (id: string, name: string, args: object = {}): Chunk => ({
	call: { id, name, args }
});
