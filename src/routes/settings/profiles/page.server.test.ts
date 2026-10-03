import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import { createRun, finishRun, getProfile, listProfiles } from '$lib/server/domain/runs';
import { actions as listActions, load as listLoad } from './+page.server';
import ListPage from './+page.svelte';
import { actions as editorActions, load as editorLoad } from './[id]/+page.server';
import EditorPage from './[id]/+page.svelte';

// A DB and key of their own in a temp directory; db() and secretKey() read them only on the first call.
const dir = mkdtempSync(join(tmpdir(), 'studio-profiles-route-'));
process.env.STUDIO_DATA_DIR = dir;
delete process.env.STUDIO_SECRET_KEY;

const KEY = 'sk-profile-route-test-0001';
const received: (string | undefined)[] = [];
const endpoint = createServer((request, response) => {
	received.push(request.headers.authorization);
	const models = { data: [{ id: 'qwen3.6-35b' }, { id: 'llama3' }] };
	response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(models));
});
let baseUrl = '';
beforeAll(async () => {
	await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
	await new Promise((resolve) => endpoint.close(resolve));
	rmSync(dir, { recursive: true, force: true });
});

type Actions = Record<string, (event: never) => unknown>;
async function post(actions: Actions, action: string, fields: Record<string, string>, id = 'new') {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, value);
	const request = new Request('http://localhost/settings/profiles', { method: 'POST', body });
	return (await actions[action]({ request, params: { id } } as never)) as Record<string, unknown>;
}
const save = (fields: Record<string, string>, id = 'new') =>
	post(editorActions, 'save', fields, id).then(
		(result) => result,
		(thrown) => thrown as Record<string, unknown>
	);
const html = (component: unknown, props: Record<string, unknown>) =>
	render(component as never, { props: { form: null, ...props } as never }).body.replace(
		/<!--[\s\S]*?-->/g,
		''
	);
const editorHtml = async (id: string) =>
	html(EditorPage, { data: await editorLoad({ params: { id } } as never) });

const LOCAL = {
	name: 'Lokal',
	provider: 'openai-compatible',
	base_url: '',
	model: '',
	api_key_ref: '',
	pool: 'local',
	role: 'code',
	thinking: 'on',
	max_tokens: '16000',
	prompt_variant: 'compact',
	temperature: '',
	max_steps: '',
	extra_prompt: ''
};

describe('agent profiles in the settings', () => {
	it('creates, edits and deletes an OpenAI-compatible profile with a model from the loaded list', async () => {
		const loaded = await post(editorActions, 'models', { base_url: baseUrl, api_key_ref: '' });
		expect(loaded).toEqual({ models: ['llama3', 'qwen3.6-35b'] });

		const model = (loaded.models as string[])[1];
		const created = await save({ ...LOCAL, base_url: baseUrl, model });
		expect(created).toMatchObject({ status: 303, location: '/settings/profiles' });
		const [{ id }] = listProfiles(db());
		expect(getProfile(db(), id)).toMatchObject({
			name: 'Lokal',
			executor: 'builtin',
			provider: 'openai-compatible',
			base_url: baseUrl,
			model: 'qwen3.6-35b',
			api_key_ref: null,
			pool: 'local',
			max_tokens: 16000,
			max_steps: null,
			params: { role: 'code', thinking: true, prompt_variant: 'compact' }
		});

		await save(
			{ ...LOCAL, name: 'Lokal schnell', base_url: baseUrl, model, max_steps: '8' },
			`${id}`
		);
		expect(getProfile(db(), id)).toMatchObject({ name: 'Lokal schnell', max_steps: 8 });
		expect(((await listLoad({} as never)) as { profiles: unknown[] }).profiles).toEqual([
			{ id, name: 'Lokal schnell', provider: 'openai-compatible', model, pool: 'local' }
		]);

		const project = board.createProject(db(), { kind: 'user' }, { key: 'STU', name: 'Studio' });
		const ticketId = board.createTicket(db(), { kind: 'user' }, project.id, { title: 'T' }).id;
		const run = createRun(db(), { kind: 'system' }, { ticketId, profileId: id }).id;
		const blocked = await post(listActions, 'delete', { id: `${id}` });
		expect(blocked).toMatchObject({
			status: 409,
			data: { id, message: expect.stringContaining('aktiven Runs genutzt: 1') }
		});
		expect((blocked.data as { message: string }).message).toMatch(/Warte, bis .*, dann erneut/);

		finishRun(db(), { kind: 'user' }, run, { state: 'cancelled' });
		expect(await post(listActions, 'delete', { id: `${id}` })).toEqual({
			deleted: 'Lokal schnell'
		});
		expect(listProfiles(db())).toEqual([]);
	});

	it('asks for confirmation before deleting: the list button only opens a dialog that holds the delete form', () => {
		const profiles = [{ id: 7, name: 'Cloud', provider: 'openai', model: 'm', pool: 'cloud' }];
		const body = html(ListPage, { data: { profiles } });
		expect(body).toMatch(/<button[^>]*type="button"[^>]*>\s*Löschen/);
		expect(body).toMatch(/<dialog[\s\S]*action="\?\/delete"[\s\S]*<\/dialog>/);
		expect(body).toContain('href="/settings/profiles/7"');
		expect(body).toContain('online');
		expect(body).toContain('läuft ab Provider-Unterstützung');
	});

	it('keeps every catalog default overridable: overridden values are stored as entered', async () => {
		const overridden = {
			role: 'tour',
			thinking: 'off',
			max_tokens: '4000',
			prompt_variant: 'full'
		};
		await save({ ...LOCAL, name: 'Override', model: 'ornith-1.5-35b', ...overridden });
		const profile = listProfiles(db()).find((p) => p.name === 'Override')!;
		expect(profile).toMatchObject({
			max_tokens: 4000,
			params: { role: 'tour', thinking: false, prompt_variant: 'full' }
		});
	});

	it('shows one sentence why next to each catalog default, and the risky-value warning with a way out', async () => {
		const ornith = { ...LOCAL, name: 'Ornith', model: 'ornith-1.5-35b', role: 'refine' };
		await save({ ...ornith, max_tokens: '12000' });
		const { id } = listProfiles(db()).find((p) => p.name === 'Ornith')!;
		const body = await editorHtml(`${id}`);
		expect(body).toContain('the strongest refinement quality');
		expect(body).toContain('without thinking enabled');
		expect(body).toContain('consumes it all');
		expect(body).toMatch(/kompakt/);
		expect(body).toMatch(
			/Das Denken verbraucht das Budget, es kommt keine Antwort\.[^<]*Ausweg: max_tokens/
		);
		expect(body).toMatch(/<input[^>]*name="model"[^>]*list="/); // free input stays possible
	});

	it('offers OpenAI and Anthropic with the cloud pool and a notice instead of a silent failure', async () => {
		await save({
			...LOCAL,
			name: 'Claude',
			provider: 'anthropic',
			base_url: baseUrl,
			pool: '',
			model: 'm'
		});
		const profile = listProfiles(db()).find((p) => p.name === 'Claude')!;
		expect(profile).toMatchObject({ provider: 'anthropic', pool: 'cloud', base_url: null });
		const body = await editorHtml(`${profile.id}`);
		expect(body).toContain('läuft ab Provider-Unterstützung');
		expect(body).not.toContain('name="base_url"');
		expect(body).not.toContain('Modelle laden');
		expect(body).toMatch(/<option value="anthropic" selected/);
	});

	it('warns about the prompt budget for an extra prompt over 300 tokens', async () => {
		await save({ ...LOCAL, name: 'Lang', model: 'llama3', extra_prompt: 'x'.repeat(1300) });
		const { id } = listProfiles(db()).find((p) => p.name === 'Lang')!;
		expect(await editorHtml(`${id}`)).toMatch(/etwa 325 Tokens[^<]*Prompt-Budget[^<]*Ausweg/);
	});

	it('names an invalid field next to it instead of failing with a database error', async () => {
		expect(await save({ ...LOCAL, name: 'Kaputt', model: 'm', max_tokens: '-5' })).toMatchObject({
			status: 400,
			data: { field: 'max_tokens', message: expect.stringMatching(/max_tokens.*Ausweg/) }
		});
		expect(await save({ ...LOCAL, name: 'Lokal schnell', model: '' })).toMatchObject({
			status: 400,
			data: { field: 'model' }
		});
	});
});

describe('the API key', () => {
	it('is stored through the secret field, the profile holds only secret:<name>, and the key never shows in HTML, load data or logs', async () => {
		const logged: unknown[] = [];
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation((...args) => void logged.push(...args))
		);
		const responses = [
			await post(editorActions, 'setSecret', { field: '', name: 'llm-key', value: KEY }),
			await post(editorActions, 'setSecret', { field: '', name: 'llm-key', value: KEY }),
			await post(editorActions, 'models', { base_url: baseUrl, api_key_ref: 'secret:llm-key' }),
			await post(editorActions, 'models', { base_url: baseUrl, api_key_ref: KEY }),
			await save({ ...LOCAL, name: 'Mit Key', model: 'llama3', api_key_ref: KEY }),
			await save({ ...LOCAL, name: 'Mit Key', model: 'llama3', api_key_ref: 'secret:llm-key' })
		];
		spies.forEach((spy) => spy.mockRestore());

		expect(received.at(-1)).toBe(`Bearer ${KEY}`); // the key was used on the server
		expect(responses[0]).toEqual({ savedSecret: 'llm-key' });
		expect(responses[1]).toMatchObject({
			status: 400,
			data: { secretError: { code: 'secret_exists' } }
		});
		expect(responses[4]).toMatchObject({ status: 400, data: { field: 'api_key_ref' } });
		const profile = listProfiles(db()).find((p) => p.name === 'Mit Key')!;
		expect(profile.api_key_ref).toBe('secret:llm-key');

		const loads = [
			await listLoad({} as never),
			await editorLoad({ params: { id: `${profile.id}` } } as never),
			await editorLoad({ params: { id: 'new' } } as never)
		];
		const rendered = [
			html(ListPage, { data: loads[0] }),
			html(EditorPage, { data: loads[1] }),
			html(EditorPage, { data: loads[2], form: responses[1].data })
		];
		const everything = JSON.stringify({ responses, loads, logged }) + rendered.join('');
		expect(everything).not.toContain(KEY.slice(0, 12));
		expect(rendered[1]).toContain('secret:llm-key');
	});
});
