// Each tab is its own copy of the client modules, fed by the real event route: domain → bus → /api/events → store.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createOwner, createSession } from '$lib/server/auth';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import { haltRuns, releaseHalt } from '$lib/server/domain/halt';
import type { Actor } from '$lib/server/domain/core';
import * as questions from '$lib/server/domain/questions';
import * as runs from '$lib/server/domain/runs';
import { liveState } from '$lib/server/live';
import { GET as events } from '../../routes/api/events/+server';

const tmp = mkdtempSync(join(tmpdir(), 'studio-live-'));
process.env.STUDIO_DATA_DIR = tmp; // db() reads the directory on its first call
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };
const session = createSession(db(), createOwner(db(), 'owner', 'scrypt$unused')!.id);
const projectId = board.createProject(db(), user, { key: 'STU', name: 'Studio' }).id;
const profileId = runs.createProfile(db(), user, {
	name: 'qwen',
	executor: 'builtin',
	provider: 'openai-compatible',
	model: 'm'
}).id;
const decoder = new TextDecoder();

/** An `EventSource` that reads the real event route with the owner's session, as the browser would. */
class RouteEventSource {
	static instances: RouteEventSource[] = [];
	url: string;
	onopen: (() => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

	constructor(url: string) {
		this.url = url;
		RouteEventSource.instances.push(this);
		void this.read();
	}

	private async read() {
		const request = { url: new URL(this.url, 'http://localhost'), cookies: { get: () => session } };
		const response = (await events(request as never)) as Response;
		this.reader = response.body!.getReader();
		this.onopen?.();
		for (let chunk = await this.reader.read(); !chunk.done; chunk = await this.reader.read()) {
			const text = decoder.decode(chunk.value);
			if (text.startsWith('data: ')) this.onmessage?.({ data: text.slice(6, -2) } as MessageEvent);
		}
	}

	close() {
		void this.reader?.cancel();
	}

	/** The network drops: the stream ends and the browser reports an error. */
	drop() {
		this.close();
		this.onerror?.();
	}
}

vi.stubGlobal('EventSource', RouteEventSource);
vi.stubGlobal('window', new EventTarget());
const tabs: { close(): void }[] = [];
afterEach(() => tabs.splice(0).forEach((connection) => connection.close()));

/** Loads the page in a new tab: fresh client modules, the layout load, then the tab's one connection. */
async function openTab() {
	vi.resetModules();
	const store = await import('./live.svelte');
	const { shell } = await import('./shell.svelte');
	const reload = vi.fn(() => store.showLive(liveState(db())));
	reload();
	const connection = store.connectLive(reload);
	tabs.push(connection);
	return { ...store, shell, reload };
}

function startRun() {
	const ticketId = board.createTicket(db(), user, projectId, { title: 'T' }).id;
	const runId = runs.createRun(db(), system, { ticketId, profileId }).id;
	runs.startRun(db(), system, runId);
	return { ticketId, runId };
}

const chip = (runId: number, state: 'running' | 'waiting') => ({
	id: runId,
	name: 'qwen',
	location: 'lokal',
	project: { id: projectId, code: 'STU', name: 'Studio', palette: 1 },
	state
});

it('shows an agent chip when a run starts and drops it when the run ends, in every open tab without a page reload', async () => {
	const open = [await openTab(), await openTab()];
	const ticketId = board.createTicket(db(), user, projectId, { title: 'T' }).id;
	const runId = runs.createRun(db(), system, { ticketId, profileId }).id;
	for (const tab of open) {
		await vi.waitFor(() => expect(tab.live.runs.map((run) => run.state)).toEqual(['queued']));
		expect(tab.shell.agents).toEqual([]); // a queued run has no agent at work yet
	}

	runs.startRun(db(), system, runId);
	for (const tab of open)
		await vi.waitFor(() => expect(tab.shell.agents).toEqual([chip(runId, 'running')]));

	runs.finishRun(db(), system, runId, { state: 'succeeded' });
	for (const tab of open) await vi.waitFor(() => expect(tab.shell.agents).toEqual([]));
});

it('on request_human the chip holds, the Takt counter rises by one and the wave runs once; the answer lowers the counter', async () => {
	const tab = await openTab();
	const { ticketId, runId } = startRun();
	await vi.waitFor(() => expect(tab.shell.agents).toEqual([chip(runId, 'running')]));
	const signals = tab.shell.signals;

	const asked = questions.requestHuman(db(), { kind: 'agent', runId }, ticketId, {
		question: 'A oder B?'
	});
	await vi.waitFor(() => expect(tab.live.openQuestions).toBe(1));
	expect(tab.shell.agents).toEqual([chip(runId, 'waiting')]);
	expect(tab.shell.signals).toBe(signals + 1); // once, although the comment and the move arrive with it
	expect(tab.openQuestionsLabel(1)).toBe('1 offene Frage');
	expect(tab.openQuestionsLabel(2)).toBe('2 offene Fragen');

	const reloads = tab.reload.mock.calls.length;
	runs.finishRun(db(), system, runId, { state: 'paused' });
	await vi.waitFor(() => expect(tab.reload).toHaveBeenCalledTimes(reloads + 1));
	expect(tab.shell.agents).toEqual([chip(runId, 'waiting')]); // still holds: the question is open

	questions.answerQuestion(db(), user, asked.id, { text: 'A' });
	await vi.waitFor(() => expect(tab.live.openQuestions).toBe(0));
	expect(tab.shell.agents).toEqual([]);
	expect(tab.shell.signals).toBe(signals + 1); // an answer is no new signal
});

it('reloads after a reconnect, so no chip of a run that ended during the outage stays behind', async () => {
	const tab = await openTab();
	const { runId } = startRun();
	await vi.waitFor(() => expect(tab.shell.agents).toEqual([chip(runId, 'running')]));

	RouteEventSource.instances.at(-1)!.drop();
	runs.finishRun(db(), system, runId, { state: 'succeeded' }); // nobody listens: this event is lost
	expect(tab.shell.agents).toEqual([chip(runId, 'running')]);

	await vi.waitFor(() => expect(tab.shell.agents).toEqual([]), { timeout: 3000 }); // reconnect after 1 s
});

it('serves every view from the one connection of its tab: views subscribe with onLiveEvent', async () => {
	const connectionsBefore = RouteEventSource.instances.length;
	const tab = await openTab();
	const stellwerk = vi.fn();
	const spur = vi.fn();
	tab.onLiveEvent(stellwerk);
	const leaveSpur = tab.onLiveEvent(spur);

	const { runId } = startRun();
	runs.appendEvent(db(), { kind: 'agent', runId }, runId, { type: 'message', payload: 'hallo' });
	const runEvent = expect.objectContaining({ type: 'run.event', runId });
	await vi.waitFor(() => expect(stellwerk).toHaveBeenCalledWith(runEvent));
	expect(spur).toHaveBeenCalledWith(runEvent);

	leaveSpur();
	runs.finishRun(db(), system, runId, { state: 'succeeded' });
	const runEnd = expect.objectContaining({ type: 'run.state_changed', to: 'succeeded' });
	await vi.waitFor(() => expect(stellwerk).toHaveBeenCalledWith(runEnd));
	expect(spur).not.toHaveBeenCalledWith(runEnd);
	expect(RouteEventSource.instances.slice(connectionsBefore).map((es) => es.url)).toEqual([
		'/api/events'
	]);
});

it('shows the halt with the number of waiting runs in every open tab and drops it on release, without a page reload', async () => {
	const open = [await openTab(), await openTab()];
	const { ticketId } = startRun();
	runs.createRun(db(), system, { ticketId, profileId });
	for (const tab of open)
		await vi.waitFor(() => expect(tab.live).toMatchObject({ halted: false, activeRuns: 1 }));

	haltRuns(db(), user);
	const queued = db().prepare("SELECT count(*) AS n FROM runs WHERE state = 'queued'").get()!.n;
	expect(queued).toBeGreaterThan(0);
	for (const tab of open) {
		await vi.waitFor(() => expect(tab.live).toMatchObject({ halted: true, activeRuns: 0 }));
		expect(tab.haltLabel(tab.live.runs)).toBe(`Angehalten · ${queued} wartend`);
		expect(tab.shell.agents).toEqual([]); // the cancelled run's chip is gone
	}

	releaseHalt(db(), user);
	for (const tab of open) await vi.waitFor(() => expect(tab.live.halted).toBe(false));
});

it('names the runs a halt cancels in its confirmation, and how the waiting ones go on', async () => {
	const { haltQuestion } = await import('./live.svelte');
	expect(haltQuestion(0)).toBe(
		'Gerade läuft kein Run. Wartende Runs bleiben in der Queue, bis du fortsetzt (:fortsetzen).'
	);
	expect(haltQuestion(1)).toBe(
		'1 Run läuft und wird sofort abgebrochen. Wartende Runs bleiben in der Queue, bis du fortsetzt (:fortsetzen).'
	);
	expect(haltQuestion(3)).toBe(
		'3 Runs laufen und werden sofort abgebrochen. Wartende Runs bleiben in der Queue, bis du fortsetzt (:fortsetzen).'
	);
});
