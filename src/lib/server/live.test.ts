import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import { haltRuns, pauseRun, pauseRuns, releaseHalt, resumeRun } from './domain/halt';
import * as questions from './domain/questions';
import * as runs from './domain/runs';
import { liveState, projectRef } from './live';

const user: Actor = { kind: 'user' };

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	const project = (key: string, name: string) => board.createProject(db, user, { key, name }).id;
	const ticket = (projectId: number) => board.createTicket(db, user, projectId, { title: 'T' }).id;
	const profile = (name: string, pool: string) =>
		runs.createProfile(db, user, {
			name,
			executor: 'builtin',
			provider: 'openai-compatible',
			model: 'm',
			pool
		}).id;
	const queued = (ticketId: number, profileId: number) =>
		runs.createRun(db, user, { ticketId, profileId }).id;
	const running = (ticketId: number, profileId: number) => {
		const id = queued(ticketId, profileId);
		runs.startRun(db, user, id);
		return id;
	};
	return { db, project, ticket, profile, queued, running };
}

describe('projectRef', () => {
	it('derives the palette slot 1–5 from the project id, repeating from the sixth project on', () => {
		const slots = [1, 2, 3, 4, 5, 6, 7, 10, 11].map(
			(id) => projectRef({ id, key: 'P', name: 'P' }).palette
		);
		expect(slots).toEqual([1, 2, 3, 4, 5, 1, 2, 5, 1]);
	});

	it('carries the project key as code, so the letters tell projects apart where colours repeat', () => {
		expect(projectRef({ id: 6, key: 'WEB', name: 'Webseite' })).toEqual({
			id: 6,
			code: 'WEB',
			name: 'Webseite',
			palette: 1
		});
	});
});

describe('liveState', () => {
	it('names every project and the project of every run by its code', () => {
		const s = setup();
		s.project('STU', 'Studio');
		const web = s.project('WEB', 'Webseite');
		const runId = s.running(s.ticket(web), s.profile('Claude', 'cloud'));

		const state = liveState(s.db);
		expect(state.projects.map((p) => p.code)).toEqual(['STU', 'WEB']);
		expect(state.runs).toEqual([
			{
				id: runId,
				profile: 'Claude',
				location: 'online',
				project: { id: web, code: 'WEB', name: 'Webseite', palette: 2 },
				ticket: 'WEB-1',
				state: 'running'
			}
		]);
	});

	it('shows queued, working and holding runs, and drops ended runs and archived projects', () => {
		const s = setup();
		const stu = s.project('STU', 'Studio');
		const local = s.profile('qwen', 'local');
		const queued = s.queued(s.ticket(stu), local);
		const approving = s.running(s.ticket(stu), local);
		runs.setRunState(s.db, user, approving, 'waiting_approval');
		const asking = s.running(s.ticket(stu), local);
		const askingTicket = s.db.prepare('SELECT ticket_id FROM runs WHERE id = ?').get(asking)!
			.ticket_id as number;
		questions.requestHuman(s.db, { kind: 'agent', runId: asking }, askingTicket, {
			question: 'A oder B?'
		});
		runs.finishRun(s.db, user, asking, { state: 'paused' });
		const done = s.running(s.ticket(stu), local);
		runs.finishRun(s.db, user, done, { state: 'succeeded' });
		const archived = s.project('OLD', 'Alt');
		s.running(s.ticket(archived), local);
		s.db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(archived);

		const state = liveState(s.db);
		expect(state.runs.map((r) => [r.id, r.state, r.location])).toEqual([
			[queued, 'queued', 'lokal'],
			[approving, 'waiting', 'lokal'],
			[asking, 'waiting', 'lokal']
		]);
		expect(state.projects.map((p) => p.code)).toEqual(['STU']);
		expect(state.openQuestions).toBe(1);
	});

	it('counts the runs the kill switch would cancel, in archived projects too, and tells whether a stop is set', () => {
		const s = setup();
		const local = s.profile('qwen', 'local');
		const stu = s.project('STU', 'Studio');
		const approving = s.running(s.ticket(stu), local);
		runs.setRunState(s.db, user, approving, 'waiting_approval');
		s.queued(s.ticket(stu), local);
		const archived = s.project('OLD', 'Alt');
		s.running(s.ticket(archived), local);
		s.db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(archived);
		expect(liveState(s.db)).toMatchObject({ halt: null, activeRuns: 2 });

		haltRuns(s.db, user);
		expect(liveState(s.db)).toMatchObject({ halt: 'stop', activeRuns: 0 });
	});

	it('shows a run the human paused until it is resumed, without an agent at work, and tells whether a pause is set', () => {
		const s = setup();
		const local = s.profile('qwen', 'local');
		const stu = s.project('STU', 'Studio');
		const [halted, resumed] = [s.running(s.ticket(stu), local), s.running(s.ticket(stu), local)];
		pauseRun(s.db, user, halted);
		pauseRun(s.db, user, resumed);
		const continuation = resumeRun(s.db, user, resumed).id;

		expect(liveState(s.db).runs.map((r) => [r.id, r.state])).toEqual([
			[halted, 'paused'],
			[continuation, 'queued']
		]);
		expect(liveState(s.db).halt).toBeNull();

		pauseRuns(s.db, user);
		expect(liveState(s.db).halt).toBe('pause');
		releaseHalt(s.db, user);
		expect(liveState(s.db).halt).toBeNull();
	});
});
