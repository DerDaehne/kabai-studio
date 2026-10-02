import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';

type Endpoint = (request: Request) => Promise<Response>;
export type StudioTools = { tools: ToolSet; toolTokens: number; close: () => Promise<void> };

// Never resolved: the requests go straight to the endpoint function, not over the network.
const IN_PROCESS_URL = 'http://studio.invalid/mcp';
const CHARS_PER_TOKEN = 4;

/**
 * The studio MCP tools of one run, called in-process with the run token, so the agent acts with the run's identity.
 * `toolTokens` estimates what the tool definitions add to every request (characters / 4).
 */
export async function studioTools(endpoint: Endpoint, token: string, signal: AbortSignal): Promise<StudioTools> {
	const client: MCPClient = await createMCPClient({
		transport: {
			type: 'http',
			url: IN_PROCESS_URL,
			headers: { authorization: `Bearer ${token}` },
			fetch: (input, init) => endpoint(new Request(input, init))
		},
		initializationOptions: { signal }
	});
	try {
		const definitions = await client.listTools({ options: { signal } });
		const toolTokens = Math.ceil(JSON.stringify(definitions.tools).length / CHARS_PER_TOKEN);
		return { tools: client.toolsFromDefinitions(definitions), toolTokens, close: () => client.close() };
	} catch (err) {
		await client.close();
		throw err;
	}
}
