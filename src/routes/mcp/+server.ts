import { db } from '$lib/server/db';
import { mcpEndpoint } from '$lib/server/mcp';
import type { RequestHandler } from './$types';

let serve: ((request: Request) => Promise<Response>) | undefined;

// Built on the first request: opening the database at import time would also run during `vite build`.
export const fallback: RequestHandler = ({ request }) => (serve ??= mcpEndpoint(db()))(request);
