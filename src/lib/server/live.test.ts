import type { SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import { haltRuns, pauseRun, pauseRuns, releaseHalt, resumeRun } from './domain/halt';
import * as questions from './domain/questions';
import * as runs from './domain/runs';
import { ACTIVE_RUNS, FINISHED_RUNS, liveState, projectRef, recentFinishedRuns } from './live';

/** A DB migrated up to (excluding) the given migration, so a query plan test can show the state before an index lands. */
function dbBeforeMigration(name: string) {
	const bundled = import.meta.glob<string>('/migrations/*.sql', {
		query: '?raw',
		import: 'default',
		eager: true
	});
	const db = openDb(':memory:');
	migrate(
		db,
		Object.fromEntries(Object.entries(bundled).filter(([path]) => path < `/migrations/${name}`))
	);
	return db;
}

const planLines = (db: ReturnType<typeof openDb>, sql: string, params: SQLInputValue[] = []) =>
	(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(
		(r) => r.detail
	);

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

describe('recentFinishedRuns', () => {
	it('lists succeeded, failed and cancelled runs across projects, newest first, but not a paused one', () => {
		const s = setup();
		const stu = s.project('STU', 'Studio');
		const web = s.project('WEB', 'Webseite');
		const local = s.profile('qwen', 'local');
		const succeeded = s.running(s.ticket(stu), local);
		runs.finishRun(s.db, user, succeeded, { state: 'succeeded' });
		const failedTicket = s.ticket(web);
		const failed = s.running(failedTicket, local);
		runs.finishRun(s.db, user, failed, { state: 'failed', error: 'Timeout talking to the model' });
		const cancelled = s.running(s.ticket(stu), local);
		runs.finishRun(s.db, user, cancelled, { state: 'cancelled' });
		const paused = s.running(s.ticket(stu), local);
		runs.finishRun(s.db, user, paused, { state: 'paused' });

		const list = recentFinishedRuns(s.db);
		expect(list.map((r) => r.id)).toEqual([cancelled, failed, succeeded]);
		expect(list.map((r) => r.state)).toEqual(['cancelled', 'failed', 'succeeded']);
		const failedNumber = (
			s.db.prepare('SELECT number FROM tickets WHERE id = ?').get(failedTicket) as {
				number: number;
			}
		).number;
		expect(list[1]).toMatchObject({
			project: { code: 'WEB', name: 'Webseite' },
			ticket: `WEB-${failedNumber}`,
			number: failedNumber
		});
	});

	it('shows a one-line summary only for a failed run, taking just the first line of the error', () => {
		const s = setup();
		const stu = s.project('STU', 'Studio');
		const local = s.profile('qwen', 'local');
		const succeeded = s.running(s.ticket(stu), local);
		runs.finishRun(s.db, user, succeeded, { state: 'succeeded' });
		const failed = s.running(s.ticket(stu), local);
		runs.finishRun(s.db, user, failed, {
			state: 'failed',
			error: 'Connection reset\nretrying was no use'
		});

		const list = recentFinishedRuns(s.db);
		expect(list.find((r) => r.id === failed)?.summary).toBe('Connection reset');
		expect(list.find((r) => r.id === succeeded)?.summary).toBeNull();
	});

	it('caps the list at the 5 newest and drops a finished run from an archived project', () => {
		const s = setup();
		const stu = s.project('STU', 'Studio');
		const local = s.profile('qwen', 'local');
		const finish = () => {
			const id = s.running(s.ticket(stu), local);
			runs.finishRun(s.db, user, id, { state: 'succeeded' });
			return id;
		};
		const oldest = finish();
		const newest = Array.from({ length: 5 }, finish);
		const archived = s.project('OLD', 'Alt');
		const archivedRun = s.running(s.ticket(archived), local);
		runs.finishRun(s.db, user, archivedRun, { state: 'succeeded' });
		s.db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(archived);

		const list = recentFinishedRuns(s.db);
		expect(list.map((r) => r.id)).toEqual([...newest].reverse());
		expect(list.some((r) => r.id === oldest)).toBe(false); // pushed out: only the 5 newest survive the cap
		expect(list.some((r) => r.id === archivedRun)).toBe(false);
	});

	it('orders by the time a run finished, so an older run that finished last comes first', () => {
		const s = setup();
		const stu = s.project('STU', 'Studio');
		const local = s.profile('qwen', 'local');
		const finishedAt = (id: number, at: string) =>
			s.db.prepare('UPDATE runs SET finished_at = ? WHERE id = ?').run(at, id);
		const startedFirst = s.running(s.ticket(stu), local);
		const startedSecond = s.running(s.ticket(stu), local);
		runs.finishRun(s.db, user, startedSecond, { state: 'succeeded' });
		runs.finishRun(s.db, user, startedFirst, { state: 'failed', error: 'late failure' });
		finishedAt(startedSecond, '2026-10-07 10:00:01');
		finishedAt(startedFirst, '2026-10-07 10:05:00');

		expect(recentFinishedRuns(s.db).map((r) => r.id)).toEqual([startedFirst, startedSecond]);
	});
});

describe('query plans: liveState and recentFinishedRuns must not scan questions/runs fully', () => {
	it('scans questions and runs fully before migration 015', () => {
		const db = dbBeforeMigration('015');
		const lines = planLines(db, ACTIVE_RUNS);
		expect(lines).toContain('SCAN r');
		expect(lines).toContain('SCAN q');
		expect(lines).toContain('SCAN c');
	});

	it('searches by index instead of scanning questions or runs after migration 015', () => {
		const db = openDb(':memory:');
		migrate(db);
		const lines = planLines(db, ACTIVE_RUNS);
		expect(lines).not.toContain('SCAN r');
		expect(lines).not.toContain('SCAN q');
		expect(lines).not.toContain('SCAN c');
		expect(lines).toContain('SEARCH r USING INDEX runs_by_state (state=?)');
		expect(lines).toContain('SEARCH q USING INDEX questions_by_run (run_id=?)');
		expect(lines).toContain(
			'SEARCH c USING COVERING INDEX runs_by_resumed_from (resumed_from_run_id=?)'
		);
	});

	it('cannot plan recentFinishedRuns before migration 015: the pinned index does not exist yet', () => {
		const db = dbBeforeMigration('015');
		expect(() => planLines(db, FINISHED_RUNS)).toThrow(/no such index/);
	});

	it('scans the finished_at index after migration 015 and needs no sort step', () => {
		const db = openDb(':memory:');
		migrate(db);
		const lines = planLines(db, FINISHED_RUNS);
		expect(lines).toContain('SCAN r USING INDEX runs_by_finished_at');
		expect(lines).not.toContain('USE TEMP B-TREE FOR ORDER BY');
	});
});
