import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDb } from './db';
import { listModels, MODEL_LIST_TIMEOUT_MS } from './model-list';
import { setSecret } from './secrets';

process.env.STUDIO_SECRET_KEY = randomBytes(32).toString('base64');
const KEY = 'sk-model-list-test-0001';
const db = openDb(':memory:');
migrate(db);
setSecret(db, 'llm-key', KEY);
setSecret(db, 'other-key', 'sk-other-key-0002');

const received: (string | undefined)[] = [];
function fakeEndpoint(request: IncomingMessage, response: ServerResponse) {
	received.push(request.headers.authorization);
	const json = (status: number, body: unknown) =>
		response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
	if (request.url === '/ok/v1/models') {
		if (request.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: 'no key' });
		return json(200, { object: 'list', data: [{ id: 'qwen3.6-35b' }, { id: 'gpt-oss-20b' }] });
	}
	if (request.url === '/open/v1/models') return json(200, { data: [{ id: 'llama3' }] });
	if (request.url === '/broken/v1/models') return json(500, { error: 'boom' });
	if (request.url === '/html/v1/models') return response.end('<html>not a model list</html>');
	if (request.url === '/slow/v1/models') return; // never answers
	json(404, {});
}

const server = createServer(fakeEndpoint);
let base = '';
let unreachable = '';
beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const closed = createServer();
	await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
	unreachable = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/v1`;
	await new Promise((resolve) => closed.close(resolve));
});
afterAll(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

const expectOneLineWithWayOut = (result: Awaited<ReturnType<typeof listModels>>) => {
	expect(result).not.toHaveProperty('models');
	const { modelError } = result as { modelError: string };
	expect(modelError).not.toContain('\n');
	expect(modelError).toMatch(/Ausweg: \S/);
	expect(modelError).not.toContain(KEY);
	return modelError;
};

describe('loading the model list of an OpenAI-compatible endpoint', () => {
	it('lists the models with the key from the secrets store, whether or not the address ends in /v1', async () => {
		const withV1 = await listModels(db, { baseUrl: `${base}/ok/v1/`, apiKeyRef: 'secret:llm-key' });
		const withoutV1 = await listModels(db, { baseUrl: `${base}/ok`, apiKeyRef: 'secret:llm-key' });
		expect(withV1).toEqual({ models: ['gpt-oss-20b', 'qwen3.6-35b'] });
		expect(withoutV1).toEqual(withV1);
		expect(received.at(-1)).toBe(`Bearer ${KEY}`);
	});

	it('sends no authorization header without a key reference', async () => {
		expect(await listModels(db, { baseUrl: `${base}/open/v1`, apiKeyRef: null })).toEqual({
			models: ['llama3']
		});
		expect(received.at(-1)).toBeUndefined();
	});

	it('names a missing or rejected key (401) and an unresolvable reference in one line with a way out', async () => {
		const withoutKey = await listModels(db, { baseUrl: `${base}/ok/v1`, apiKeyRef: null });
		const withoutKeyError = expectOneLineWithWayOut(withoutKey);
		expect(withoutKeyError).toContain('verlangt einen API-Key (HTTP 401)');
		expect(withoutKeyError).toContain('Key als Secret speichern und als secret:<name> eintragen.');
		const wrongKey = await listModels(db, {
			baseUrl: `${base}/ok/v1`,
			apiKeyRef: 'secret:other-key'
		});
		expect(expectOneLineWithWayOut(wrongKey)).toContain('lehnt den API-Key ab (HTTP 401)');
		const unset = await listModels(db, {
			baseUrl: `${base}/ok/v1`,
			apiKeyRef: '${MODEL_LIST_TEST_KEY}'
		});
		expect(expectOneLineWithWayOut(unset)).toContain('MODEL_LIST_TEST_KEY ist nicht gesetzt');
	});

	it('names an unreachable endpoint in one line with a way out', async () => {
		const result = await listModels(db, { baseUrl: unreachable, apiKeyRef: null });
		const error = expectOneLineWithWayOut(result);
		expect(error).toContain('nicht erreichbar');
		expect(error).toContain('Modell-Server starten oder Adresse und Port prüfen');
	});

	it('gives up after the time limit with one line and a way out', async () => {
		const started = Date.now();
		const result = await listModels(
			db,
			{ baseUrl: `${base}/slow/v1`, apiKeyRef: null },
			{ timeoutMs: 200 }
		);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(expectOneLineWithWayOut(result)).toContain('0,2 s');
		expect(MODEL_LIST_TIMEOUT_MS).toBe(5000);
	});

	it('explains server errors, answers that are no model list and invalid addresses', async () => {
		const broken = await listModels(db, { baseUrl: `${base}/broken/v1`, apiKeyRef: null });
		expect(expectOneLineWithWayOut(broken)).toContain('HTTP 500');
		const html = await listModels(db, { baseUrl: `${base}/html/v1`, apiKeyRef: null });
		expect(expectOneLineWithWayOut(html)).toContain('keine Modellliste');
		const invalid = await listModels(db, { baseUrl: 'localhost:8080', apiKeyRef: null });
		expect(expectOneLineWithWayOut(invalid)).toContain('http://127.0.0.1:8080/v1');
	});

	it('refuses a key pasted in place of a reference without sending or repeating it', async () => {
		const before = received.length;
		const result = await listModels(db, { baseUrl: `${base}/ok/v1`, apiKeyRef: KEY });
		expect(expectOneLineWithWayOut(result)).toContain('kein Verweis');
		expect(received.length).toBe(before);
	});
});
