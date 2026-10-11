import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import * as runs from './domain/runs';
import { QUEUED_RUNS, startView, TODAY_USAGE, TRACKED_RUNS } from './start-view';

const user: Actor = { kind: 'user' };

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const ticket = () => board.createTicket(db, user, projectId, { title: 'T' }).id;
	const profile = runs.createProfile(db, user, {
		name: 'qwen',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm',
		pool: 'local'
	}).id;
	const queued = () => runs.createRun(db, user, { ticketId: ticket(), profileId: profile }).id;
	const running = () => {
		const id = queued();
		runs.startRun(db, user, id);
		return id;
	};
	return { db, queued, running };
}

const planLines = (db: ReturnType<typeof openDb>, sql: string) =>
	(
		db
			.prepare(`EXPLAIN QUERY PLAN ${sql}`)
			.all(...(sql.includes('?1') ? ['2026-10-11 00:00:00'] : [])) as { detail: string }[]
	).map((row) => row.detail);

describe('startView', () => {
	it('lists queued runs in claim order, each with the reason it waits', () => {
		const s = setup();
		s.running(); // fills the local pool, so the queued runs wait for it
		const first = s.queued();
		const urgent = s.queued();
		runs.prioritizeRun(s.db, user, urgent);

		const { queued } = startView(s.db);
		expect(queued.map((run) => run.id)).toEqual([urgent, first]);
		expect(queued[0]).toMatchObject({ profile: 'qwen', project: { code: 'STU' }, notBefore: null });
		expect(queued[1].waitText).toMatch(/Pool „local“ ist voll/);
	});

	it('gives a failed run its code and the way out of its failure comment', () => {
		const s = setup();
		const failed = s.running();
		runs.finishRun(s.db, user, failed, {
			state: 'failed',
			error: '[provider_unreachable] No answer'
		});
		s.db
			.prepare(
				"INSERT INTO comments (ticket_id, author_kind, author, body, run_id) SELECT ticket_id, 'system', 'studio', ?, id FROM runs WHERE id = ?"
			)
			.run('Run failed: No answer\nAusweg: Start the model server.', failed);

		const [run] = startView(s.db).finished;
		expect(run.failure).toEqual({
			code: 'provider_unreachable',
			wayOut: 'Start the model server.'
		});
		expect(run.cost).toBe(0);
		expect(run.finishedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
	});

	it('sums today’s tokens and cost over runs that finished or started today, not older ones', () => {
		const s = setup();
		const today = s.running();
		const yesterday = s.running();
		runs.finishRun(s.db, user, yesterday, { state: 'succeeded' });
		s.db
			.prepare('UPDATE runs SET tokens_in = 100, tokens_out = 20, cost = 0.5 WHERE id = ?')
			.run(today);
		s.db
			.prepare(
				"UPDATE runs SET tokens_in = 7, cost = 1, finished_at = '2000-01-01 10:00:00' WHERE id = ?"
			)
			.run(yesterday);

		expect(startView(s.db).today).toEqual({ tokens: 120, cost: 0.5 });
	});

	it('tracks every running run with the tail of its events and a step series', () => {
		const s = setup();
		const id = s.running();
		runs.appendEvent(s.db, user, id, {
			type: 'log',
			payload: { kind: 'step', tokensIn: 1, tokensOut: 2 }
		});

		const [track] = startView(s.db).tracks;
		expect(track.id).toBe(id);
		expect(track.events.map((event) => event.type)).toEqual(['log']);
		expect(track.series.reduce((sum, point) => sum + point.steps, 0)).toBe(1);
	});
});

describe('query plans of the start view: no full scan over runs', () => {
	it.each([
		['queued runs', QUEUED_RUNS],
		['tracked runs', TRACKED_RUNS],
		['today’s usage', TODAY_USAGE]
	])('%s search runs by index', (_name, sql) => {
		const db = openDb(':memory:');
		migrate(db);
		const lines = planLines(db, sql);
		expect(lines.filter((line) => /^SCAN (r|runs)\b/.test(line))).toEqual([]);
		expect(
			lines.some((line) => /SEARCH (r|runs) USING (COVERING )?INDEX runs_by_/.test(line))
		).toBe(true);
	});
});
