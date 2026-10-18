import { isRedirect, type Cookies } from '@sveltejs/kit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, createOwner, createSession } from '$lib/server/auth';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import { requestHuman } from '$lib/server/domain/questions';
import * as runs from '$lib/server/domain/runs';
import { handle } from '../../hooks.server';
import { actions, load } from './+page.server';

const dir = mkdtempSync(join(tmpdir(), 'studio-hold-route-'));
process.env.STUDIO_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let tests = 0;
beforeEach(() => {
	db().exec('DELETE FROM projects; DELETE FROM agent_profiles; DELETE FROM users');
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 12) + tests++ * 10 * 60_000)); // the limiter is shared by the module; ten minutes apart no test counts the beats of another
});
afterEach(() => vi.useRealTimers());

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };

/** A paused run whose question the human has answered, so a follow-up run waits behind the undo window. */
function answeredQuestion() {
	const projectId = board.createProject(db(), user, { key: 'H', name: 'Hold' }).id;
	const column = db()
		.prepare("SELECT id FROM columns WHERE project_id = ? AND step = 'implement'")
		.get(projectId)!.id as number;
	const profileId = runs.createProfile(db(), user, {
		name: 'P',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const ticketId = board.createTicket(db(), user, projectId, { title: 'T', column_id: column }).id;
	const runId = runs.createRun(db(), user, { ticketId, profileId }).id;
	runs.startRun(db(), system, runId);
	const id = requestHuman(db(), { kind: 'agent', runId }, ticketId, {
		question: 'A?',
		options: [{ label: 'A' }]
	}).id;
	runs.finishRun(db(), system, runId, { state: 'paused' });
	return { id, runId };
}

const notBefore = (pausedRun: number) =>
	db().prepare('SELECT not_before FROM runs WHERE resumed_from_run_id = ?').get(pausedRun)!
		.not_before as string;

function cookiesWith(values: Record<string, string>) {
	return { get: (name: string) => values[name], set() {}, delete() {}, serialize: () => '' };
}

/** Sends the beat through the production hook, so session and origin checks apply as they do for a browser. */
async function beat(questionId: number, session?: string, headers: Record<string, string> = {}) {
	const body = new FormData();
	body.set('question', String(questionId));
	const url = new URL('http://localhost:3000/takt?/hold');
	const request = new Request(url, { method: 'POST', body, headers });
	const event = {
		url,
		isDataRequest: false,
		cookies: cookiesWith(session ? { [SESSION_COOKIE]: session } : {}) as unknown as Cookies,
		locals: {},
		request,
		getClientAddress: () => '10.0.0.1'
	};
	let result: unknown;
	try {
		const response = await handle({
			event: event as never,
			resolve: async () => {
				result = await actions.hold(event as never);
				return new Response('ok');
			}
		});
		return { response, result };
	} catch (err) {
		if (isRedirect(err)) return { redirect: err.location, result };
		throw err;
	}
}

function signedIn() {
	const owner = createOwner(db(), 'owner', 'scrypt$test')!;
	return createSession(db(), owner.id);
}

describe('the hold beat in Takt', () => {
	it('extends the window for the signed-in human and answers with what the toast needs', async () => {
		const q = answeredQuestion();
		const answeredAt = Date.now();
		await post(q.id);
		vi.setSystemTime(Date.now() + 9000);

		const { result } = await beat(q.id, signedIn());

		expect(result).toEqual({ held: true, closesInMs: 10_000, capped: false });
		expect(notBefore(q.runId)).toBe(new Date(answeredAt + 19_000).toISOString());
	});

	it('offers the beat interval together with the window length', async () => {
		const data = (await load({ depends: () => {} } as never)) as {
			undoWindowMs: number;
			holdBeatMs: number;
		};
		expect(data.holdBeatMs).toBeLessThan(data.undoWindowMs);
	});

	it('changes nothing without a session: pages redirect to login, nothing reaches the action', async () => {
		createOwner(db(), 'owner', 'scrypt$test');
		const q = answeredQuestion();
		await post(q.id);
		const before = notBefore(q.runId);
		vi.setSystemTime(Date.now() + 9000);

		for (const session of [undefined, 'invented-token']) {
			const outcome = await beat(q.id, session);
			expect(outcome).toEqual({ redirect: '/login', result: undefined });
		}
		expect(notBefore(q.runId)).toBe(before);
	});

	it('changes nothing for a foreign origin: the hook answers 403 before the action runs', async () => {
		const q = answeredQuestion();
		await post(q.id);
		const before = notBefore(q.runId);
		vi.setSystemTime(Date.now() + 9000);

		const { response, result } = await beat(q.id, signedIn(), { origin: 'http://evil.example' });

		expect(response?.status).toBe(403);
		expect(result).toBeUndefined();
		expect(notBefore(q.runId)).toBe(before);
	});

	it('limits a user to 30 beats a minute with a way out and leaves the window as it was', async () => {
		const q = answeredQuestion();
		await post(q.id);
		const session = signedIn();
		for (let n = 0; n < 30; n++)
			expect((await beat(q.id, session)).result, `beat ${n + 1}`).toMatchObject({ held: true });
		const accepted = notBefore(q.runId);
		vi.setSystemTime(Date.now() + 5000);

		const { result } = await beat(q.id, session);

		const refusal = result as { status: number; data: { message: string } };
		expect(refusal.status).toBe(409);
		expect(refusal.data.message).toContain('Zu viele');
		expect(refusal.data.message).toContain('Lass das Rückgängig-Fenster auslaufen');
		expect(notBefore(q.runId)).toBe(accepted);

		vi.setSystemTime(Date.now() + 60_000);
		expect((await beat(q.id, session)).result).toMatchObject({ held: true });
	});

	it('refuses an unanswered question with the domain message and way out', async () => {
		const q = answeredQuestion();
		await actions.retract({ request: formRequest(q.id), locals: {} } as never);
		const { result } = await beat(q.id, signedIn());
		expect((result as { data: { message: string } }).data.message).toContain(
			'noch nicht beantwortet'
		);
	});
});

function formRequest(question: number) {
	const body = new FormData();
	body.set('question', String(question));
	body.set('option', '1');
	return new Request('http://localhost/takt', { method: 'POST', body });
}

async function post(question: number) {
	await actions.answer({ request: formRequest(question), locals: {} } as never);
}
