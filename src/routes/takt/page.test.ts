import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'svelte/server';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import {
	ANSWER_UNDO_WINDOW_MS,
	requestHuman,
	type QuestionOption
} from '$lib/server/domain/questions';
import * as runs from '$lib/server/domain/runs';
import { LIVE_DEPENDENCY } from '$lib/shell/live.svelte';
import { shell } from '$lib/shell/shell.svelte';
import { actions, load } from './+page.server';
import Page from './+page.svelte';
import type { QueuedQuestion } from './queue';

const dir = mkdtempSync(join(tmpdir(), 'studio-takt-route-'));
process.env.STUDIO_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => (shell.focus = null));

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };
let projects = 0;
const usedNames = new Set<string>();

/** Project names are unique, so a name an earlier test already used gets the project key appended. */
function project(name: string) {
	projects += 1;
	const key = `P${projects}`;
	const uniqueName = usedNames.has(name) ? `${name} ${key}` : name;
	usedNames.add(name);
	const id = board.createProject(db(), user, { key, name: uniqueName }).id;
	const column = db()
		.prepare("SELECT id FROM columns WHERE project_id = ? AND name = 'In Arbeit'")
		.get(id)!.id as number;
	const profileId = runs.createProfile(db(), user, {
		name: `Profil ${key}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	return { id, key, column, profileId };
}

/** An agent asks in a run that then pauses, like the runner does after request_human. */
function asks(
	p: ReturnType<typeof project>,
	question: string,
	options: QuestionOption[] = [{ label: 'Ja' }]
) {
	const ticketId = board.createTicket(db(), user, p.id, {
		title: question,
		column_id: p.column
	}).id;
	const runId = runs.createRun(db(), user, { ticketId, profileId: p.profileId }).id;
	runs.startRun(db(), system, runId);
	const id = requestHuman(db(), { kind: 'agent', runId }, ticketId, { question, options }).id;
	runs.finishRun(db(), system, runId, { state: 'paused' });
	return { id, ticketId, runId };
}

async function loaded() {
	const dependencies: string[] = [];
	const data = (await load({ depends: (d: string) => dependencies.push(d) } as never)) as {
		questions: QueuedQuestion[];
		undoWindowMs: number;
	};
	return { data, dependencies };
}

async function post(action: 'answer' | 'retract', fields: Record<string, string | number>) {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, String(value));
	const request = new Request('http://localhost/takt', { method: 'POST', body });
	return (await actions[action]({ request } as never)) as Record<string, unknown>;
}

const html = (data: Awaited<ReturnType<typeof loaded>>['data']) =>
	render(Page as never, { props: { data } as never }).body.replace(/<!--[\s\S]*?-->/g, '');
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const followUp = (pausedRun: number) =>
	db()
		.prepare('SELECT state FROM runs WHERE resumed_from_run_id = ? ORDER BY id DESC')
		.get(pausedRun)?.state;
const storedAnswer = (id: number) =>
	db().prepare('SELECT answer FROM questions WHERE id = ?').get(id)!.answer;
const clearQueue = () =>
	db().exec(
		`UPDATE questions SET answer = '{"text":"x"}', answered_at = CURRENT_TIMESTAMP WHERE answer IS NULL`
	);

describe('the Takt queue', () => {
	it('shows the open questions of all projects, oldest first, with ticket, project, asking profile and options', async () => {
		clearQueue();
		const studio = project('Studio');
		const web = project('Webseite');
		const first = asks(web, 'Welche Farbe?', [
			{ label: 'Blau', effect: 'ruhig' },
			{ label: 'Rot' }
		]);
		const second = asks(studio, 'Welcher Port?');

		const { data, dependencies } = await loaded();
		expect(data.questions.map((q) => q.id)).toEqual([first.id, second.id]);
		expect(data.questions[0]).toMatchObject({
			ticket: { ref: `${web.key}-1`, number: 1, title: 'Welche Farbe?' },
			project: { id: web.id, code: web.key, name: 'Webseite' },
			profile: `Profil ${web.key}`,
			question: 'Welche Farbe?',
			options: [{ label: 'Blau', effect: 'ruhig' }, { label: 'Rot' }]
		});
		expect(new Date(data.questions[0].askedAt).toISOString()).toBe(data.questions[0].askedAt);
		expect(data.undoWindowMs).toBe(ANSWER_UNDO_WINDOW_MS);
		expect(dependencies).toContain(LIVE_DEPENDENCY);
	});

	it('picks up a question asked later on the next load, at the end of the queue', async () => {
		clearQueue();
		const p = project('Studio');
		const first = asks(p, 'Zuerst?');
		expect((await loaded()).data.questions.map((q) => q.id)).toEqual([first.id]);

		const later = asks(p, 'Danach?');
		expect((await loaded()).data.questions.map((q) => q.id)).toEqual([first.id, later.id]);
	});

	it('leaves out answered questions and projects in the archive', async () => {
		clearQueue();
		const p = project('Studio');
		const answered = asks(p, 'Erledigt?');
		await post('answer', { question: answered.id, option: 1 });
		const archived = project('Alt');
		asks(archived, 'Archiviert?');
		db().prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(archived.id);

		expect((await loaded()).data.questions).toEqual([]);
	});
});

describe('answering in Takt', () => {
	it('answers with the chosen option, and the paused run continues after the undo window', async () => {
		const p = project('Studio');
		const q = asks(p, 'A oder B?', [{ label: 'A' }, { label: 'B' }]);

		expect(await post('answer', { question: q.id, option: 2 })).toEqual({ resumesRun: true });
		expect(JSON.parse(storedAnswer(q.id) as string)).toEqual({ option: 2 });
		expect(followUp(q.runId)).toBe('queued');
		expect(board.ticket(db(), q.ticketId).column_id).toBe(p.column);
	});

	it('answers with free text as it was typed', async () => {
		const q = asks(project('Studio'), 'Wie heißt der Branch?');
		await post('answer', { question: q.id, text: 'ticket/1-takt' });
		expect(JSON.parse(storedAnswer(q.id) as string)).toEqual({ text: 'ticket/1-takt' });
	});

	it('says when an answer continues no run, so the notice does not promise one', async () => {
		const p = project('Studio');
		const ticketId = board.createTicket(db(), user, p.id, { title: 'T' }).id;
		const id = requestHuman(db(), user, ticketId, { question: 'Ohne Run?' }).id;
		expect(await post('answer', { question: id, text: 'ja' })).toEqual({ resumesRun: false });
	});

	it('reports a rejected answer with the way out of the domain', async () => {
		const q = asks(project('Studio'), 'Nur eine Option?');
		const result = await post('answer', { question: q.id, option: 3 });
		expect(result.status).toBe(409);
		expect((result.data as { message: string }).message).toContain('Wähle eine Option von 1 bis 1');
	});
});

describe('taking an answer back in Takt', () => {
	it('restores the open question while the follow-up run still waits', async () => {
		const q = asks(project('Studio'), 'Zurück?');
		await post('answer', { question: q.id, option: 1 });

		expect(await post('retract', { question: q.id })).toEqual({});
		expect(storedAnswer(q.id)).toBeNull();
		expect(followUp(q.runId)).toBe('cancelled');
		expect((await loaded()).data.questions.map((open) => open.id)).toContain(q.id);
	});

	it('refuses once the follow-up run has started, with the message and way out of the domain', async () => {
		const q = asks(project('Studio'), 'Zu spät?');
		await post('answer', { question: q.id, option: 1 });
		const started = db().prepare('SELECT id FROM runs WHERE resumed_from_run_id = ?').get(q.runId)!
			.id as number;
		runs.startRun(db(), system, started);

		const result = await post('retract', { question: q.id });
		expect(result.status).toBe(409);
		const { message } = result.data as { message: string };
		expect(message).toContain(`Run ${started} arbeitet schon mit der Antwort`);
		expect(message).toContain('Korrektur schreibst du als Kommentar');
	});
});

describe('the Takt page', () => {
	it('shows the oldest question as the card in focus, with its options and keys', async () => {
		clearQueue();
		const p = project('Studio');
		asks(p, 'Welche Farbe?', [{ label: 'Blau', effect: 'ruhig' }, { label: 'Rot' }]);
		asks(p, 'Welcher Port?');

		const markup = html((await loaded()).data);
		const card = text(markup.slice(markup.indexOf('<article'), markup.indexOf('</article>')));
		expect(card).toContain(`${p.key}-1`);
		expect(card).toContain('Studio');
		expect(card).toContain(`Profil ${p.key}`);
		expect(card).toContain('Welche Farbe?');
		expect(card).toContain('1 Blau ruhig');
		expect(card).toContain('2 Rot');
		expect(card).not.toContain('Welcher Port?');
		expect(markup).toContain('data-strength="strong"');
	});

	it('under a project focus shows only that project and names the hidden questions in one line', async () => {
		clearQueue();
		const studio = project('Studio');
		const web = project('Webseite');
		asks(web, 'Ausgeblendet?');
		asks(studio, 'Sichtbar?');
		const { data } = await loaded();
		shell.focus = data.questions[1].project;

		const markup = text(html(data));
		expect(markup).toContain('Sichtbar?');
		expect(markup).not.toContain('Ausgeblendet?');
		expect(markup).toContain('1 weitere in 1 anderen Projekt');
	});

	it('with an empty queue says that nothing waits and leads to the Stellwerk', async () => {
		clearQueue();
		const markup = html((await loaded()).data);
		expect(text(markup)).toContain('Nichts wartet auf dich');
		expect(markup).toMatch(/<a [^>]*href="\/"[^>]*>[^<]*Zum Stellwerk/);
	});
});
