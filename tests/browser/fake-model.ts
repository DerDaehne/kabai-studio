import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One answer of the model: closing text, or a call of a studio tool. */
export type ScriptedReply = { text: string } | { call: { name: string; args: object } };

export type FakeModel = {
	/** The base URL for an agent profile, including `/v1`. */
	baseUrl: string;
	/** Queues replies; each chat completion request takes the next one. */
	reply(...replies: ScriptedReply[]): void;
	close(): Promise<void>;
};

/** A local OpenAI-compatible model server that streams scripted replies instead of asking a real provider. */
export async function startFakeModel(): Promise<FakeModel> {
	const replies: ScriptedReply[] = [];
	const server = createServer((request, response) => answer(request, response, replies.shift()));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		reply: (...next) => void replies.push(...next),
		close: () => {
			server.closeAllConnections(); // the studio's HTTP client keeps its connection alive
			return new Promise((resolve) => server.close(() => resolve()));
		}
	};
}

function answer(request: IncomingMessage, response: ServerResponse, reply?: ScriptedReply) {
	request.resume();
	if (!request.url?.endsWith('/chat/completions') || !reply) {
		const message = `The fake model has no scripted reply for ${request.method} ${request.url}.`;
		response.writeHead(500, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ error: { message } }));
		return;
	}
	response.writeHead(200, { 'Content-Type': 'text/event-stream' });
	for (const chunk of streamOf(reply)) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end('data: [DONE]\n\n');
}

/** The chunks of a streamed chat completion: the reply, its finish reason, then the usage. */
function streamOf(reply: ScriptedReply) {
	const delta = 'text' in reply ? { content: reply.text } : { tool_calls: [toolCall(reply.call)] };
	const finishReason = 'text' in reply ? 'stop' : 'tool_calls';
	return [
		chunk([{ index: 0, delta, finish_reason: null }]),
		chunk([{ index: 0, delta: {}, finish_reason: finishReason }]),
		{ ...chunk([]), usage: { prompt_tokens: 100, completion_tokens: 10 } }
	];
}

const toolCall = ({ name, args }: { name: string; args: object }) => ({
	index: 0,
	id: 'call-1',
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
