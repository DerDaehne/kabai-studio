import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One answer of the model: closing text, a call of a studio tool, or `hang` — no answer at all, so the run keeps
 * working until the studio aborts the request.
 */
export type ScriptedReply = { text: string } | { call: { name: string; args: object } } | 'hang';

export type FakeModel = {
	/** The base URL for an agent profile, including `/v1`. */
	baseUrl: string;
	/** Queues replies; each chat completion request takes the next one. */
	reply(...replies: ScriptedReply[]): void;
	/** The bodies of the chat completion requests so far, in order. */
	requests: Record<string, unknown>[];
	close(): Promise<void>;
};

/** A local OpenAI-compatible model server that streams scripted replies instead of asking a real provider. */
export async function startFakeModel(): Promise<FakeModel> {
	const replies: ScriptedReply[] = [];
	const requests: Record<string, unknown>[] = [];
	const server = createServer(async (request, response) => {
		const reply = replies.shift(); // taken on arrival, so concurrent requests get the replies in the order they came
		const body = await bodyOf(request);
		if (request.url?.endsWith('/chat/completions')) requests.push(JSON.parse(body));
		answer(request, response, reply);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		reply: (...next) => void replies.push(...next),
		requests,
		close: () => {
			server.closeAllConnections(); // the studio's HTTP client keeps its connection alive
			return new Promise((resolve) => server.close(() => resolve()));
		}
	};
}

async function bodyOf(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

function answer(request: IncomingMessage, response: ServerResponse, reply?: ScriptedReply) {
	if (!request.url?.endsWith('/chat/completions') || !reply) {
		const message = `The fake model has no scripted reply for ${request.method} ${request.url}.`;
		response.writeHead(500, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ error: { message } }));
		return;
	}
	response.writeHead(200, { 'Content-Type': 'text/event-stream' });
	if (reply === 'hang') return void response.flushHeaders();
	for (const chunk of streamOf(reply)) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end('data: [DONE]\n\n');
}

/** The chunks of a streamed chat completion: the reply, its finish reason, then the usage. */
function streamOf(reply: Exclude<ScriptedReply, 'hang'>) {
	const delta = 'text' in reply ? { content: reply.text } : { tool_calls: [toolCall(reply.call)] };
	const finishReason = 'text' in reply ? 'stop' : 'tool_calls';
	return [
		chunk([{ index: 0, delta, finish_reason: null }]),
		chunk([{ index: 0, delta: {}, finish_reason: finishReason }]),
		{ ...chunk([]), usage: { prompt_tokens: 100, completion_tokens: 10 } }
	];
}

// A fresh id per call: studio records run events by tool-call id, so two calls in one run (even from different
// scripted replies) must never collide the way a fixed id would.
const toolCall = ({ name, args }: { name: string; args: object }) => ({
	index: 0,
	id: randomUUID(),
	type: 'function',
	function: { name, arguments: JSON.stringify(args) }
});

const chunk = (choices: object[]) => ({
	id: 'chatcmpl-fake',
	object: 'chat.completion.chunk',
	created: 0,
	model: 'fake',
	choices
});
