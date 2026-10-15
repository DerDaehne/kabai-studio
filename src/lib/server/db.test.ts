import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDataDir } from './data-dir';
import { latestMigration, migrate, openDb } from './db';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import * as questions from './domain/questions';
import * as runs from './domain/runs';
import { liveState, recentFinishedRuns } from './live';

const tmp = mkdtempSync(join(tmpdir(), 'studio-db-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const names = (db: ReturnType<typeof openDb>) =>
	db
		.prepare('SELECT name FROM schema_migrations ORDER BY name')
		.all()
		.map((r) => r.name);

const SHIPPED = import.meta.glob<string>('/migrations/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true
});
/** The shipped migrations whose path sorts before `prefix`, e.g. `/migrations/016` for the schema up to 015. */
const shippedBefore = (prefix: string) =>
	Object.fromEntries(Object.entries(SHIPPED).filter(([path]) => path < prefix));

/** The template createProject built before Refine, Ready and Abnahme existed. */
const COLUMNS_BEFORE_REFINE = [
	'Backlog',
	'In Arbeit',
	'Review',
	'Done',
	'Human Intervention',
	'Human Answered'
];
/** The template createProject built from then on, until 016. */
const COLUMNS_SINCE_REFINE = [
	'Backlog',
	'Refine',
	'Ready',
	'In Arbeit',
	'Review',
	'Abnahme',
	'Done',
	'Human Intervention',
	'Human Answered'
];
const LEGACY_KIND: Record<string, string> = {
	Done: 'done',
	'Human Intervention': 'human_intervention',
	'Human Answered': 'human_answered'
};

/**
 * A project as the old createProject left it in a database before 016: columns with kind, review flag and role prompt,
 * the linear transitions and the edge from human intervention to human answered. Returns the column ids by name.
 */
function legacyProject(
	db: ReturnType<typeof openDb>,
	project: { id: number; key: string; firstColumnId: number },
	names: string[]
): Record<string, number> {
	db.prepare('INSERT INTO projects (id, key, name) VALUES (?, ?, ?)').run(
		project.id,
		project.key,
		`Projekt ${project.key}`
	);
	const ids = Object.fromEntries(names.map((name, i) => [name, project.firstColumnId + i]));
	const column = db.prepare(
		'INSERT INTO columns (id, project_id, name, position, kind, review, role_prompt) VALUES (?, ?, ?, ?, ?, ?, ?)'
	);
	names.forEach((name, i) =>
		column.run(
			ids[name],
			project.id,
			name,
			i,
			LEGACY_KIND[name] ?? 'normal',
			name === 'Review' ? 1 : 0,
			`Role of ${name}`
		)
	);
	const edge = db.prepare(
		'INSERT INTO transitions (project_id, from_column_id, to_column_id, requires_human) VALUES (?, ?, ?, ?)'
	);
	const flow = names.filter((name) => !name.startsWith('Human'));
	for (let i = 0; i + 1 < flow.length; i++) {
		edge.run(project.id, ids[flow[i]], ids[flow[i + 1]], flow[i + 1] === 'Done' ? 1 : 0);
		edge.run(project.id, ids[flow[i + 1]], ids[flow[i]], 0);
	}
	edge.run(project.id, ids['Human Intervention'], ids['Human Answered'], 1);
	return ids;
}

describe('defaultDataDir', () => {
	it('uses XDG_DATA_HOME on Linux when set', () => {
		expect(defaultDataDir('linux', { XDG_DATA_HOME: '/custom/xdg', HOME: '/home/x' })).toBe(
			'/custom/xdg/kabai-studio'
		);
	});

	it('falls back to ~/.local/share on Linux without XDG_DATA_HOME', () => {
		expect(defaultDataDir('linux', { HOME: '/home/x' })).toBe('/home/x/.local/share/kabai-studio');
	});

	it('uses ~/Library/Application Support on macOS, ignoring XDG_DATA_HOME', () => {
		expect(defaultDataDir('darwin', { XDG_DATA_HOME: '/custom/xdg', HOME: '/Users/x' })).toBe(
			'/Users/x/Library/Application Support/kabai-studio'
		);
	});
});

describe('openDb', () => {
	it('sets WAL, foreign_keys and busy_timeout', () => {
		const db = openDb(join(tmp, 'pragmas.db'));
		expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
		expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
		expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
	});

	it('waits for a second, already open connection instead of failing with "database is locked" at once', async () => {
		const file = join(tmp, 'zweiter-prozess.db');
		// Simulates a second, already running process on the fresh file: holds a read transaction
		// (shared lock), which journal_mode=WAL needs, for 300 ms.
		const childScript = `
			const { DatabaseSync } = require('node:sqlite');
			const db = new DatabaseSync(${JSON.stringify(file)});
			db.exec('BEGIN');
			db.exec('SELECT 1 FROM sqlite_master');
			process.stdout.write('LOCKED\\n');
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
			db.exec('COMMIT');
		`;
		const child = spawn(process.execPath, ['-e', childScript], {
			stdio: ['ignore', 'pipe', 'inherit']
		});
		await new Promise<void>((resolve) => {
			child.stdout.on('data', (chunk: Buffer) => {
				if (chunk.toString().includes('LOCKED')) resolve();
			});
		});

		const t0 = Date.now();
		const db = openDb(file); // must not fail at once — has to wait for the release
		expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // really waited rather than got lucky
		expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });

		await new Promise((resolve) => child.on('exit', resolve));
	});
});

describe('migrate', () => {
	it('is idempotent: a second run applies nothing', () => {
		const file = join(tmp, 'idem.db');
		const first = migrate(openDb(file));
		expect(first.slice(0, 2)).toEqual(['001_core_schema.sql', '002_workflow_state.sql']);
		expect(first).toContain('006_runs.sql');
		const db = openDb(file); // like a restart
		expect(migrate(db)).toEqual([]);
		expect(names(db)).toEqual(first);
	});

	it('skips what another process applied in the meantime (checked inside the transaction)', () => {
		const db = openDb(':memory:');
		// 001 simulates the competitor: it records 002 as applied after the pending list is already fixed
		const ran = migrate(db, {
			'/m/001_a.sql':
				"CREATE TABLE a (id INTEGER); INSERT INTO schema_migrations (name) VALUES ('002_b.sql')",
			'/m/002_b.sql': 'CREATE TABLE b (id INTEGER)'
		});
		expect(ran).toEqual(['001_a.sql']);
		expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'b'").get()).toBeUndefined();
	});

	it('holds the write lock from BEGIN on, so a second process cannot write in between', () => {
		const file = join(tmp, 'konkurrenz.db');
		const base = { '/m/001_side.sql': 'CREATE TABLE side (x INTEGER)' };
		migrate(openDb(file), base);
		const other = openDb(file);
		other.exec('PRAGMA busy_timeout = 0');
		const [a, rival] = [openDb(file), { wrote: false }];
		// Right before A runs the migration (after BEGIN and the re-check), a second process tries to write.
		// With a plain BEGIN that would succeed, and A would then fail with "database is locked" (stale snapshot).
		const spy = new Proxy(a, {
			get(target, prop) {
				if (prop === 'exec')
					return (sql: string) => {
						if (sql.startsWith('CREATE TABLE x'))
							try {
								other.exec('INSERT INTO side VALUES (1)');
								rival.wrote = true;
							} catch {
								/* locked, as expected */
							}
						return target.exec(sql);
					};
				const value = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		expect(migrate(spy, { ...base, '/m/002_x.sql': 'CREATE TABLE x (id INTEGER)' })).toEqual([
			'002_x.sql'
		]);
		expect(rival.wrote).toBe(false);
	});

	it('applies in name order regardless of the input order', () => {
		const db = openDb(':memory:');
		const ran = migrate(db, {
			'/m/002_b.sql': 'CREATE TABLE b (a_id INTEGER REFERENCES a (id))',
			'/m/001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY)'
		});
		expect(ran).toEqual(['001_a.sql', '002_b.sql']);
	});

	it('rolls a failed migration back completely', () => {
		const db = openDb(':memory:');
		const ok = { '/m/001_ok.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY)' };
		const bad = {
			'/m/002_bad.sql': 'CREATE TABLE b (id INTEGER); INSERT INTO a VALUES (1); SELEKT kaputt;'
		};

		expect(() => migrate(db, { ...ok, ...bad })).toThrow('Migration 002_bad.sql fehlgeschlagen');
		expect(names(db)).toEqual(['001_ok.sql']);
		expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'b'").get()).toBeUndefined();
		expect(db.prepare('SELECT count(*) AS n FROM a').get()).toEqual({ n: 0 });
		expect(db.isTransaction).toBe(false);

		// once fixed, it runs on the next start
		expect(migrate(db, { ...ok, '/m/002_bad.sql': 'CREATE TABLE b (id INTEGER)' })).toEqual([
			'002_bad.sql'
		]);
	});

	it('aborts before any transaction when schema_migrations has a migration this code does not know (DB newer than code, e.g. after a downgrade) — known, still-pending migrations are not applied either', () => {
		const db = openDb(':memory:');
		migrate(db, { '/m/001_a.sql': 'CREATE TABLE a (id INTEGER)' });
		db.exec("INSERT INTO schema_migrations (name) VALUES ('003_future.sql')");
		const withPending = {
			'/m/001_a.sql': 'CREATE TABLE a (id INTEGER)',
			'/m/002_b.sql': 'CREATE TABLE b (id INTEGER)'
		};

		expect(() => migrate(db, withPending)).toThrowError(
			expect.objectContaining({
				code: 'db_newer_than_code',
				message: expect.stringContaining('003_future.sql'),
				hint: expect.stringMatching(
					/neuere Studio-Version installieren|ältere Sicherung wiederherstellen/
				)
			})
		);
		expect(names(db)).toEqual(['001_a.sql', '003_future.sql']);
		expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'b'").get()).toBeUndefined();
	});

	it('does not run the pre-upgrade backup when the database is newer than the code', () => {
		const db = openDb(':memory:');
		migrate(db, { '/m/001_a.sql': 'CREATE TABLE a (id INTEGER)' });
		db.exec("INSERT INTO schema_migrations (name) VALUES ('003_future.sql')");
		const beforeUpgrade = vi.fn();

		expect(() =>
			migrate(
				db,
				{
					'/m/001_a.sql': 'CREATE TABLE a (id INTEGER)',
					'/m/002_b.sql': 'CREATE TABLE b (id INTEGER)'
				},
				beforeUpgrade
			)
		).toThrowError(expect.objectContaining({ code: 'db_newer_than_code' }));
		expect(beforeUpgrade).not.toHaveBeenCalled();
	});

	it('006 adds comments.run_id (with FK) also to a DB that has comments', () => {
		const bundled = import.meta.glob<string>('/migrations/*.sql', {
			query: '?raw',
			import: 'default',
			eager: true
		});
		const db = openDb(':memory:');
		migrate(
			db,
			Object.fromEntries(Object.entries(bundled).filter(([path]) => path < '/migrations/006'))
		); // schema before 006; later migrations build on it
		db.exec(`
			INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
			INSERT INTO columns (id, project_id, name) VALUES (10, 1, 'Ready');
			INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 10, 'Alt');
			INSERT INTO comments (ticket_id, author_kind, author, body) VALUES (100, 'user', 'user', 'vorher');
		`);
		expect(migrate(db)[0]).toBe('006_runs.sql');
		expect(db.prepare('SELECT body, run_id FROM comments').all()).toEqual([
			{ body: 'vorher', run_id: null }
		]);
		expect(() =>
			db.exec(
				"INSERT INTO comments (ticket_id, author_kind, author, body, run_id) VALUES (100, 'agent', 'x', 'x', 7)"
			)
		).toThrow(/FOREIGN KEY/);
	});

	it('005 sets docs_required on epics that existed before the migration, because the domain rule only knows the flag', () => {
		const bundled = import.meta.glob<string>('/migrations/*.sql', {
			query: '?raw',
			import: 'default',
			eager: true
		});
		const db = openDb(':memory:');
		migrate(
			db,
			Object.fromEntries(
				Object.entries(bundled).filter(([path]) => !path.endsWith('/005_notes.sql'))
			)
		);
		db.exec(`
			INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
			INSERT INTO columns (id, project_id, step, name) VALUES (10, 1, 'plan', 'Planen');
			INSERT INTO tickets (id, project_id, number, column_id, title, type, docs_required) VALUES
				(100, 1, 1, 10, 'Altes Epic', 'epic', 0),
				(101, 1, 2, 10, 'Altes Ticket', 'ticket', 0);
		`);
		expect(migrate(db)).toEqual(['005_notes.sql']);
		expect(db.prepare('SELECT id, docs_required FROM tickets ORDER BY id').all()).toEqual([
			{ id: 100, docs_required: 1 }, // existing epic updated
			{ id: 101, docs_required: 0 } // ordinary ticket untouched
		]);
	});

	it('009 marks existing Review columns and gives existing runs the normal priority', () => {
		const bundled = import.meta.glob<string>('/migrations/*.sql', {
			query: '?raw',
			import: 'default',
			eager: true
		});
		const db = openDb(':memory:');
		migrate(
			db,
			Object.fromEntries(Object.entries(bundled).filter(([path]) => path < '/migrations/009'))
		);
		db.exec(`
			INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
			INSERT INTO columns (id, project_id, name) VALUES (10, 1, 'In Arbeit'), (11, 1, 'Review');
			INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 11, 'Old');
			INSERT INTO agent_profiles (id, name, executor, provider, model) VALUES (1, 'p', 'builtin', 'openai-compatible', 'm');
			INSERT INTO runs (id, ticket_id, column_id, agent_profile_id, trigger) VALUES (7, 100, 11, 1, 'on_enter');
		`);
		const upTo010 = Object.fromEntries(
			Object.entries(bundled).filter(([path]) => path < '/migrations/010')
		);
		expect(migrate(db, upTo010)).toEqual(['009_run_priority.sql']);
		expect(db.prepare('SELECT name, review FROM columns ORDER BY id').all()).toEqual([
			{ name: 'In Arbeit', review: 0 },
			{ name: 'Review', review: 1 }
		]);
		expect(db.prepare('SELECT priority FROM runs').all()).toEqual([{ priority: 'normal' }]);
		expect(migrate(db, upTo010)).toEqual([]);
		expect(() => db.exec("UPDATE runs SET priority = 'urgent'")).toThrow(/CHECK/);
	});

	it('011 keeps existing run events with their keys, accepts intervention, still refuses unknown event types and adds the resume columns', () => {
		const bundled = import.meta.glob<string>('/migrations/*.sql', {
			query: '?raw',
			import: 'default',
			eager: true
		});
		const db = openDb(':memory:');
		migrate(
			db,
			Object.fromEntries(Object.entries(bundled).filter(([path]) => path < '/migrations/011'))
		);
		db.exec(`
			INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
			INSERT INTO columns (id, project_id, name) VALUES (10, 1, 'In Arbeit');
			INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 10, 'Old');
			INSERT INTO agent_profiles (id, name, executor, provider, model) VALUES (1, 'p', 'builtin', 'openai-compatible', 'm');
			INSERT INTO runs (id, ticket_id, column_id, agent_profile_id, trigger) VALUES (7, 100, 10, 1, 'manual');
			INSERT INTO run_events (run_id, seq, type, payload, idempotency_key, created_at) VALUES
				(7, 1, 'log', '{"msg":"request sent"}', NULL, '2026-10-01 10:00:00'),
				(7, 2, 'tool_call', '{"tool":"move_ticket"}', 'call-1', '2026-10-01 10:00:01');
		`);
		const before = db.prepare('SELECT * FROM run_events ORDER BY seq').all();

		expect(migrate(db)[0]).toBe('011_executor_contract_v2.sql');

		expect(db.prepare('SELECT * FROM run_events ORDER BY seq').all()).toEqual(before);
		db.exec(
			`INSERT INTO run_events (run_id, seq, type, payload) VALUES (7, 3, 'intervention', '{"kind":"stagnation","attempt":1,"max":2}')`
		);
		expect(() =>
			db.exec("INSERT INTO run_events (run_id, seq, type) VALUES (7, 4, 'nudge')")
		).toThrow(/CHECK/);
		expect(() =>
			db.exec(
				"INSERT INTO run_events (run_id, seq, type, idempotency_key) VALUES (7, 4, 'log', 'call-1')"
			)
		).toThrow(/UNIQUE/);
		expect(() =>
			db.exec("INSERT INTO run_events (run_id, seq, type) VALUES (7, 1, 'log')")
		).toThrow(/UNIQUE/);
		expect(() =>
			db.exec("INSERT INTO run_events (run_id, seq, type) VALUES (8, 1, 'log')")
		).toThrow(/FOREIGN KEY/);

		expect(db.prepare('SELECT resume_reason, not_before FROM runs').all()).toEqual([
			{ resume_reason: null, not_before: null }
		]);
		expect(() => db.exec("UPDATE runs SET resume_reason = 'boredom'")).toThrow(/CHECK/);
		// claimRun compares the canonical ISO form as text, so any other spelling of a time is refused
		for (const notCanonical of ['2026-10-02 15:00:00', '2026-10-02T15:00:00Z', 'soon'])
			expect(() => db.prepare('UPDATE runs SET not_before = ?').run(notCanonical)).toThrow(/CHECK/);
		db.exec("UPDATE runs SET resume_reason = 'quota', not_before = '2026-10-02T15:00:00.000Z'");

		db.exec('DELETE FROM runs WHERE id = 7');
		expect(db.prepare('SELECT count(*) AS n FROM run_events').get()).toEqual({ n: 0 });
		expect(migrate(db)).toEqual([]);
	});

	describe('013 on a database with runs in every state and every resume reason', () => {
		const bundled = import.meta.glob<string>('/migrations/*.sql', {
			query: '?raw',
			import: 'default',
			eager: true
		});
		const token = (n: number) => String(n).repeat(64);

		/** The state before 013: runs of every state and resume reason, each referenced from every table that can. */
		function dbBefore013() {
			const db = openDb(':memory:');
			migrate(
				db,
				Object.fromEntries(Object.entries(bundled).filter(([path]) => path < '/migrations/013'))
			);
			db.exec(`
				INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
				INSERT INTO columns (id, project_id, name) VALUES (10, 1, 'In Arbeit');
				INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 10, 'Old');
				INSERT INTO agent_profiles (id, name, executor, provider, model) VALUES (1, 'p', 'builtin', 'openai-compatible', 'm');
				INSERT INTO runs (id, ticket_id, column_id, agent_profile_id, trigger, state, token_hash, worktree_path, branch,
						resumed_from_run_id, tokens_in, tokens_out, cost, error, created_at, started_at, finished_at, priority,
						resume_reason, not_before) VALUES
					(1, 100, 10, 1, 'manual', 'paused', NULL, '/w/1', 'ticket/1', NULL, 10, 2, 0.5, NULL,
						'2026-10-01 10:00:00', '2026-10-01 10:00:01', '2026-10-01 10:05:00', 'human', NULL, NULL),
					(2, 100, 10, 1, 'resume', 'paused', NULL, NULL, NULL, 1, 0, 0, 0, NULL,
						'2026-10-01 10:05:00', '2026-10-01 10:06:00', '2026-10-01 10:07:00', 'normal', 'context_budget', NULL),
					(3, 100, 10, 1, 'resume', 'failed', NULL, NULL, NULL, 2, 0, 0, 0, '[step_limit] zu viele Schritte',
						'2026-10-01 10:07:00', '2026-10-01 10:08:00', '2026-10-01 10:09:00', 'review', 'recovery', NULL),
					(4, 100, 10, 1, 'resume', 'queued', NULL, NULL, NULL, 2, 0, 0, 0, NULL,
						'2026-10-01 10:07:00', NULL, NULL, 'blocker', 'quota', '2026-10-02T15:00:00.000Z'),
					(5, 100, 10, NULL, 'on_enter', 'running', '${token(5)}', NULL, NULL, NULL, 0, 0, 0, NULL,
						'2026-10-01 11:00:00', '2026-10-01 11:00:01', NULL, 'normal', NULL, NULL),
					(6, 100, NULL, 1, 'manual', 'waiting_approval', '${token(6)}', NULL, NULL, NULL, 0, 0, 0, NULL,
						'2026-10-01 11:00:00', '2026-10-01 11:00:01', NULL, 'normal', NULL, NULL),
					(7, 100, 10, 1, 'manual', 'succeeded', NULL, NULL, NULL, NULL, 5, 5, 0, NULL,
						'2026-10-01 12:00:00', '2026-10-01 12:00:01', '2026-10-01 12:01:00', 'normal', NULL, NULL),
					(8, 100, 10, 1, 'manual', 'cancelled', NULL, NULL, NULL, NULL, 0, 0, 0, NULL,
						'2026-10-01 12:00:00', NULL, '2026-10-01 12:00:30', 'normal', NULL, NULL);
				INSERT INTO run_events (run_id, seq, type, payload, idempotency_key, created_at) VALUES
					(1, 1, 'message', '{"text":"Stand"}', 'handoff', '2026-10-01 10:04:59'),
					(5, 1, 'intervention', '{"kind":"stagnation","attempt":1,"max":2}', NULL, '2026-10-01 11:00:02');
				INSERT INTO comments (id, ticket_id, author_kind, author, body, run_id) VALUES (1, 100, 'system', 'system (Run 3)', 'fehlgeschlagen', 3);
				INSERT INTO questions (id, ticket_id, run_id, question) VALUES (1, 100, 1, 'Wie weiter?');
				INSERT INTO idempotent_calls (run_id, key, request_hash, result) VALUES (5, 'k1', 'h', '{}');
				INSERT INTO runner_halt (id, halted_at) VALUES (1, '2026-10-01 13:00:00');
			`);
			return db;
		}

		const everyRow = (db: ReturnType<typeof openDb>) => ({
			runs: db.prepare('SELECT * FROM runs ORDER BY id').all(),
			runEvents: db.prepare('SELECT * FROM run_events ORDER BY run_id, seq').all(),
			comments: db.prepare('SELECT * FROM comments ORDER BY id').all(),
			questions: db.prepare('SELECT * FROM questions ORDER BY id').all(),
			idempotentCalls: db.prepare('SELECT * FROM idempotent_calls').all()
		});

		it('keeps every run with all its columns and every row that references a run', () => {
			const db = dbBefore013();
			const before = everyRow(db);

			expect(migrate(db)[0]).toBe('013_halt_kind.sql');

			const after = everyRow(db);
			expect(after.runs).toEqual(
				before.runs.map((run) => ({ ...run, halted: 0, step_result: null }))
			);
			expect({ ...after, runs: before.runs }).toEqual(before);
			expect(before.runs).toHaveLength(8);
			expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE tbl_name = 'runs' AND type = 'index' AND sql IS NOT NULL ORDER BY name"
					)
					.all()
			).toEqual([
				{ name: 'runs_by_finished_at' },
				{ name: 'runs_by_resumed_from' },
				{ name: 'runs_by_state' },
				{ name: 'runs_by_ticket' }
			]); // 013 recreates runs_by_ticket; 015's indexes land in the same migrate() call right after
			expect(migrate(db)).toEqual([]);
		});

		it('turns the halt that was set into a stop and accepts only stop and pause', () => {
			const db = dbBefore013();
			migrate(db);

			expect(db.prepare('SELECT id, halted_at, kind FROM runner_halt').all()).toEqual([
				{ id: 1, halted_at: '2026-10-01 13:00:00', kind: 'stop' }
			]);
			db.exec("UPDATE runner_halt SET kind = 'pause'");
			expect(() => db.exec("UPDATE runner_halt SET kind = 'nap'")).toThrow(/CHECK/);
		});

		it('accepts the resume reason halt and marks only a paused run as halted, with every other rule of runs still enforced', () => {
			const db = dbBefore013();
			migrate(db);

			db.exec("UPDATE runs SET resume_reason = 'halt' WHERE id = 4");
			expect(() => db.exec("UPDATE runs SET resume_reason = 'boredom' WHERE id = 4")).toThrow(
				/CHECK/
			);
			db.exec('UPDATE runs SET halted = 1 WHERE id = 1');
			expect(() => db.exec('UPDATE runs SET halted = 1 WHERE id = 7')).toThrow(/CHECK/);
			expect(() => db.exec('UPDATE runs SET halted = 2 WHERE id = 2')).toThrow(/CHECK/);
			expect(() => db.exec("UPDATE runs SET state = 'failed' WHERE id = 7")).toThrow(/CHECK/);
			expect(() => db.exec("UPDATE runs SET not_before = 'soon' WHERE id = 4")).toThrow(/CHECK/);
			expect(() => db.exec("UPDATE runs SET priority = 'urgent' WHERE id = 4")).toThrow(/CHECK/);
			expect(() => db.exec(`UPDATE runs SET token_hash = '${token(5)}' WHERE id = 6`)).toThrow(
				/UNIQUE/
			);
			expect(() =>
				db.exec("INSERT INTO run_events (run_id, seq, type) VALUES (99, 1, 'log')")
			).toThrow(/FOREIGN KEY/);

			db.exec('DELETE FROM runs WHERE id = 2');
			expect(db.prepare('SELECT resumed_from_run_id FROM runs WHERE id IN (3, 4)').all()).toEqual([
				{ resumed_from_run_id: null },
				{ resumed_from_run_id: null }
			]);
			db.exec('DELETE FROM runs WHERE id = 5');
			expect(db.prepare('SELECT count(*) AS n FROM idempotent_calls').get()).toEqual({ n: 0 });
			db.exec('DELETE FROM runs WHERE id IN (1, 3)');
			expect(db.prepare('SELECT run_id FROM questions').all()).toEqual([{ run_id: null }]);
			expect(db.prepare('SELECT run_id FROM comments').all()).toEqual([{ run_id: null }]);
			expect(db.prepare('SELECT count(*) AS n FROM run_events').get()).toEqual({ n: 0 });
		});
	});

	it('014 gives default role prompts nobody edited the current texts and keeps every edited one', () => {
		const PREVIOUS_DEFAULTS: Record<string, string> = {
			Backlog:
				'Capture new work with enough detail that someone else could size it. Move it along once it is ready for scope and acceptance criteria to be worked out.',
			Refine:
				'Make the scope, the effort and the acceptance criteria explicit before moving a ticket on. Leave a title-only ticket for someone else to flesh out instead of advancing it as is.',
			Ready:
				'Pick up a ticket only once every blocker is finished. If the description no longer matches reality, send it back for refinement with a comment explaining why.',
			'In Arbeit':
				'For a bug, reproduce it with a failing test before you fix it. A probe someone used to demonstrate a finding becomes a permanent regression test. Move the ticket on once every acceptance criterion is met.',
			Review:
				'Check the work against its acceptance criteria, not your own taste. Leave findings as a comment and send it back, or approve it and move it on.',
			Abnahme:
				'Finished work waits here for a human to accept it in a batch. Do not act on a ticket sitting in this column.',
			Done: '',
			'Human Intervention':
				'A question is open and blocks this ticket. Read it in the comments and wait for an answer instead of resuming work.',
			'Human Answered':
				'An open question now has an answer. Read it in the comments, then move the ticket back into work.'
		};
		const EDITED: Record<string, string> = {
			Refine: 'Refine with the team conventions: effort in story points.',
			Review: `${PREVIOUS_DEFAULTS.Review} `
		};
		const db = openDb(':memory:');
		migrate(db, shippedBefore('/migrations/014'));
		const old = legacyProject(db, { id: 1, key: 'OLD', firstColumnId: 1 }, COLUMNS_SINCE_REFINE);
		const setRole = db.prepare('UPDATE columns SET role_prompt = ? WHERE id = ?');
		for (const [name, text] of Object.entries({ ...PREVIOUS_DEFAULTS, ...EDITED }))
			setRole.run(text, old[name]);

		expect(migrate(db, shippedBefore('/migrations/015'))).toEqual(['014_default_role_prompts.sql']);

		const rolePrompts = Object.fromEntries(
			db
				.prepare('SELECT name, role_prompt FROM columns WHERE project_id = 1')
				.all()
				.map((r) => [r.name, r.role_prompt])
		);
		// Ready and In Arbeit carry the texts the migration ships, which the later role texts in the code replace.
		expect(rolePrompts).toMatchObject({
			...EDITED,
			Ready:
				'Do: pick the ticket up; do not refine it. Check that no blocker is still open. Deliver: a pickup comment with your plan in one or two sentences. Stop: move the ticket to In Arbeit right away. Only if the description no longer matches reality, send it back to Refine with a comment saying why.',
			'In Arbeit':
				'Do: carry out the task the ticket describes and write what it asks for as text: an answer, an analysis or code. Do not refine: leave the description and the tasks as they are. Deliver: the result itself in a comment, code in a fenced block, marked "Unverified: not compiled, run or tested."; then tick each task the result fulfils. Ask the human only if the task needs more than text, such as changing files in a repository. Stop: move the ticket to Review once the result is delivered.',
			Done: ''
		});
		for (const name of ['Backlog', 'Abnahme', 'Human Intervention', 'Human Answered']) {
			expect(rolePrompts[name]).not.toBe(PREVIOUS_DEFAULTS[name]);
			expect(rolePrompts[name]).toMatch(/^Do: /);
		}
		expect(migrate(db, shippedBefore('/migrations/015'))).toEqual([]);
	});

	it('015 adds the four indexes liveState, claimRun and recentFinishedRuns need, leaving runs_by_ticket in place', () => {
		const db = openDb(':memory:');
		expect(migrate(db)).toContain('015_live_state_indexes.sql');

		const indexNames = (table: string) =>
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name"
				)
				.all(table)
				.map((r) => r.name);
		expect(indexNames('runs')).toEqual([
			'runs_by_finished_at',
			'runs_by_resumed_from',
			'runs_by_state',
			'runs_by_ticket'
		]);
		expect(indexNames('questions')).toEqual(['questions_by_run', 'questions_by_ticket']);
		expect(migrate(db)).toEqual([]);
	});
});

describe('016 on a database at 015 with both template generations in real use', () => {
	const token = (n: number) => String(n).repeat(64);

	/**
	 * Project OLD has the template from before Refine (columns 1–6), project CUR the later one (11–19) plus two columns
	 * only hand-written SQL could add: one with an unknown name (20) and a second review column (21). Every column holds
	 * a ticket; runs, questions, comments, tasks, a review approval and a tool approval hang off them as in production.
	 */
	function dbBefore016() {
		const db = openDb(':memory:');
		migrate(db, shippedBefore('/migrations/016'));
		legacyProject(db, { id: 1, key: 'OLD', firstColumnId: 1 }, COLUMNS_BEFORE_REFINE);
		legacyProject(db, { id: 2, key: 'CUR', firstColumnId: 11 }, COLUMNS_SINCE_REFINE);
		db.exec(`
			INSERT INTO columns (id, project_id, name, position, review) VALUES (20, 2, 'Parkplatz', 9, 0), (21, 2, 'Prüfung', 10, 1);
			INSERT INTO tickets (id, project_id, number, column_id, title, effort_estimate, effort_unit) VALUES
				(101, 1, 1, 1, 'OLD Backlog', 3, 'h'), (102, 1, 2, 2, 'OLD In Arbeit', NULL, NULL),
				(103, 1, 3, 3, 'OLD Review', NULL, NULL), (104, 1, 4, 4, 'OLD Done', NULL, NULL),
				(105, 1, 5, 5, 'OLD fragt aus der Arbeit', NULL, NULL), (106, 1, 6, 6, 'OLD beantwortet ohne Run', NULL, NULL),
				(107, 1, 7, 5, 'OLD Runs in zwei Schritten', NULL, NULL),
				(111, 2, 1, 11, 'CUR Backlog', NULL, NULL), (112, 2, 2, 12, 'CUR Refine', NULL, NULL),
				(113, 2, 3, 13, 'CUR Ready', NULL, NULL), (114, 2, 4, 14, 'CUR In Arbeit', NULL, NULL),
				(115, 2, 5, 15, 'CUR Review', NULL, NULL), (116, 2, 6, 16, 'CUR Abnahme', NULL, NULL),
				(117, 2, 7, 17, 'CUR Done', NULL, NULL), (118, 2, 8, 18, 'CUR fragt aus der Kritik', NULL, NULL),
				(119, 2, 9, 19, 'CUR beantwortet nach Abnahme', NULL, NULL), (120, 2, 10, 20, 'CUR Parkplatz', NULL, NULL),
				(121, 2, 11, 21, 'CUR zweite Prüfung', NULL, NULL);
			UPDATE projects SET ticket_seq = (SELECT max(number) FROM tickets WHERE project_id = projects.id);
			UPDATE tickets SET review_approved_at = '2026-10-01 09:00:00', review_approved_by = '{"kind":"agent","runId":4}'
				WHERE id IN (103, 116);
			INSERT INTO tasks (ticket_id, title, done_at) VALUES (102, 'Parser', '2026-10-01 08:00:00'), (102, 'Tests', NULL);
			INSERT INTO ticket_relations (from_ticket_id, to_ticket_id, type) VALUES (101, 102, 'blocks'), (111, 112, 'parent_of');
			INSERT INTO agent_profiles (id, name, executor, provider, model) VALUES (1, 'Lokal', 'builtin', 'openai-compatible', 'm');
			INSERT INTO runs (id, ticket_id, column_id, agent_profile_id, trigger, state, token_hash, created_at, started_at, finished_at, error) VALUES
				(1, 105, 2, 1, 'manual', 'paused', NULL, '2026-10-01 10:00:00', '2026-10-01 10:00:01', '2026-10-01 10:05:00', NULL),
				(2, 113, 13, 1, 'manual', 'queued', NULL, '2026-10-01 10:00:00', NULL, NULL, NULL),
				(3, 114, 14, 1, 'on_enter', 'waiting_approval', '${token(3)}', '2026-10-01 10:00:00', '2026-10-01 10:00:01', NULL, NULL),
				(4, 118, 15, 1, 'on_enter', 'succeeded', NULL, '2026-10-01 09:00:00', '2026-10-01 09:00:01', '2026-10-01 09:30:00', NULL),
				(5, 118, 18, 1, 'resume', 'paused', NULL, '2026-10-01 11:00:00', '2026-10-01 11:00:01', '2026-10-01 11:05:00', NULL),
				(6, 119, 16, 1, 'manual', 'succeeded', NULL, '2026-10-01 09:00:00', '2026-10-01 09:00:01', '2026-10-01 09:10:00', NULL),
				(7, 120, 20, 1, 'manual', 'failed', NULL, '2026-10-01 09:00:00', '2026-10-01 09:00:01', '2026-10-01 09:10:00', '[x] kaputt'),
				(9, 107, 3, 1, 'manual', 'succeeded', NULL, '2026-10-01 08:00:00', '2026-10-01 08:00:01', '2026-10-01 08:10:00', NULL),
				(10, 107, 2, 1, 'manual', 'succeeded', NULL, '2026-10-01 09:00:00', '2026-10-01 09:00:01', '2026-10-01 09:10:00', NULL),
				(11, 107, 5, 1, 'manual', 'failed', NULL, '2026-10-01 10:00:00', '2026-10-01 10:00:01', '2026-10-01 10:10:00', '[x] kaputt');
			INSERT INTO run_events (run_id, seq, type, payload) VALUES
				(1, 1, 'message', '{"text":"Stand"}'), (3, 1, 'permission_request', '{"tool":"shell","command":"npm test"}');
			INSERT INTO comments (ticket_id, author_kind, author, body, run_id) VALUES
				(102, 'user', 'user', 'Bitte zuerst den Parser.', NULL),
				(105, 'agent', 'agent (Run 1)', 'A oder B?', 1),
				(118, 'agent', 'agent (Run 5)', 'Wie streng?', 5),
				(120, 'user', 'user', 'Später.', NULL);
			INSERT INTO questions (id, ticket_id, run_id, question, options, answer, answered_at, collected_at) VALUES
				(1, 105, 1, 'A oder B?', '[{"label":"A"},{"label":"B"}]', NULL, NULL, NULL),
				(2, 118, 5, 'Wie streng?', '[]', NULL, NULL, NULL),
				(3, 119, 6, 'Passt das?', '[]', '{"text":"Ja"}', '2026-10-01 09:20:00', '2026-10-01 09:21:00');
		`);
		return db;
	}

	const tables = (db: ReturnType<typeof openDb>) =>
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('columns', 'transitions', 'schema_migrations') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notes_fts%' ORDER BY name"
			)
			.all()
			.map((r) => r.name as string);
	/** Row counts of `only` (default: every table), so tables a later migration adds do not count as a change. */
	const rowCounts = (db: ReturnType<typeof openDb>, only = tables(db)) =>
		Object.fromEntries(
			only.map((table) => [
				table,
				db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n as number
			])
		);
	const stepOfTicket = (db: ReturnType<typeof openDb>) =>
		Object.fromEntries(
			db
				.prepare(
					'SELECT t.id, c.step FROM tickets t JOIN columns c ON c.id = t.column_id ORDER BY t.id'
				)
				.all()
				.map((r) => [r.id, r.step])
		);

	it('loses no row: every table keeps its count, the comments gain one system comment per dropped column', () => {
		const db = dbBefore016();
		const before = rowCounts(db);
		const ticketsPerProject = () =>
			db.prepare('SELECT project_id, count(*) AS n FROM tickets GROUP BY project_id').all();
		const perProjectBefore = ticketsPerProject();

		expect(migrate(db)[0]).toBe('016_variants.sql');

		expect(before).toMatchObject({
			tickets: 18,
			runs: 10,
			comments: 4,
			questions: 3,
			tasks: 2,
			projects: 2
		});
		expect(rowCounts(db, Object.keys(before))).toEqual({
			...before,
			comments: before.comments + 2
		});
		expect(ticketsPerProject()).toEqual(perProjectBefore);
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		expect(migrate(db)).toEqual([]);
	});

	it('turns every project into the software variant, keeping the ids of known columns and adding missing steps', () => {
		const db = dbBefore016();
		migrate(db);

		const columnsOf = (projectId: number) =>
			db
				.prepare('SELECT id, step, phase, name FROM columns WHERE project_id = ? ORDER BY position')
				.all(projectId)
				.map((c) => `${c.step}:${c.phase}:${c.name}`);
		const positionsOf = (projectId: number) =>
			db
				.prepare('SELECT position, step FROM columns WHERE project_id = ? ORDER BY position')
				.all(projectId)
				.map((c) => [c.position, c.step]);
		const software = [
			'backlog:open:Backlog',
			'refine:work:Präzisieren',
			'plan:work:Planen',
			'implement:work:Umsetzen',
			'critique:work:Kritik',
			'acceptance:acceptance:Abnahme',
			'done:done:Fertig'
		];
		expect(columnsOf(1)).toEqual(software);
		expect(positionsOf(1)).toEqual(positionsOf(2));
		expect(positionsOf(1)).toEqual(
			software.map((_, position) => [position, software[position].split(':')[0]])
		);
		expect(columnsOf(2)).toEqual(software);
		expect(db.prepare('SELECT id, step FROM columns WHERE id < 21 ORDER BY id').all()).toEqual(
			[
				[1, 'backlog'],
				[2, 'implement'],
				[3, 'critique'],
				[4, 'done'],
				[11, 'backlog'],
				[12, 'refine'],
				[13, 'plan'],
				[14, 'implement'],
				[15, 'critique'],
				[16, 'acceptance'],
				[17, 'done']
			].map(([id, step]) => ({ id, step }))
		);
		expect(
			db.prepare('SELECT min(id) AS first FROM columns WHERE project_id = 1 AND id > 6').get()
		).toEqual({
			first: 22
		}); // added steps never reuse the id of a dropped column
		expect(db.prepare('SELECT DISTINCT variant FROM projects').all()).toEqual([
			{ variant: 'software' }
		]);
	});

	it('puts every ticket in a step: human tickets in the step of their newest work run or the backlog, tickets of unknown or doubled columns in the backlog with a system comment', () => {
		const db = dbBefore016();
		migrate(db);

		expect(stepOfTicket(db)).toEqual({
			101: 'backlog',
			102: 'implement',
			103: 'critique',
			104: 'done',
			105: 'implement', // asked from a run in In Arbeit
			106: 'backlog', // answered, but never worked by a run
			107: 'implement', // older run in Review, newer one in In Arbeit, newest in the human column
			111: 'backlog',
			112: 'refine',
			113: 'plan',
			114: 'implement',
			115: 'critique',
			116: 'acceptance',
			117: 'done',
			118: 'critique', // its newest run sat in the human column itself, the one before in Review
			119: 'backlog', // its only run was in Abnahme, no work step
			120: 'backlog',
			121: 'backlog' // a second column for the critique step goes like an unknown one
		});
		expect(
			db
				.prepare(
					"SELECT ticket_id, author_kind, author, body, run_id FROM comments WHERE author_kind = 'system'"
				)
				.all()
		).toEqual([
			{
				ticket_id: 120,
				author_kind: 'system',
				author: 'system',
				body: 'Die Spalte „Parkplatz“ gibt es nicht mehr. Das Ticket liegt jetzt im Backlog.',
				run_id: null
			},
			{
				ticket_id: 121,
				author_kind: 'system',
				author: 'system',
				body: 'Die Spalte „Prüfung“ gibt es nicht mehr. Das Ticket liegt jetzt im Backlog.',
				run_id: null
			}
		]);
	});

	it('keeps questions, runs, tool and review approvals; only runs of dropped columns lose their column, explicitly', () => {
		const db = dbBefore016();
		const rows = (sql: string) => db.prepare(sql).all();
		const QUESTIONS = 'SELECT * FROM questions ORDER BY id';
		const RUNS = 'SELECT * FROM runs ORDER BY id';
		const RUN_EVENTS = 'SELECT * FROM run_events ORDER BY run_id, seq';
		const TICKETS =
			'SELECT id, project_id, number, title, description, docs_required, assignee, position, created_at, updated_at, review_approved_at, review_approved_by, moved_by FROM tickets ORDER BY id';
		const before = {
			questions: rows(QUESTIONS),
			runs: rows(RUNS),
			events: rows(RUN_EVENTS),
			tickets: rows(TICKETS)
		};

		migrate(db);

		expect(rows(QUESTIONS)).toEqual(before.questions);
		expect(rows(RUN_EVENTS)).toEqual(before.events);
		expect(rows(TICKETS)).toEqual(before.tickets);
		expect(rows(RUNS)).toEqual(
			before.runs.map((run) => ({
				...run,
				...(run.id === 5 || run.id === 7 || run.id === 11 ? { column_id: null } : {}),
				step_result: null
			}))
		);
	});

	it('keeps the app working on the migrated data: domain reads, the live state and an answer that resumes the paused run', () => {
		const db = dbBefore016();
		migrate(db);
		const human: Actor = { kind: 'user' };

		for (const { id } of db.prepare('SELECT id FROM tickets').all() as { id: number }[]) {
			expect(board.ticket(db, id).column_step).toBe(stepOfTicket(db)[id]);
			expect(board.allowedMoves(db, id, human)).toHaveLength(6);
		}
		expect(board.workableTickets(db, 1).map((t) => t.ref)).toEqual([
			'OLD-1',
			'OLD-6',
			'OLD-7',
			'OLD-3'
		]);
		expect(questions.latestOpenQuestion(db, 118)).toMatchObject({ id: 2, question: 'Wie streng?' });
		expect(liveState(db)).toMatchObject({ openQuestions: 2, activeRuns: 1 });

		expect(questions.answerQuestion(db, human, 1, { option: 2 })).toEqual({ resumesRun: true });
		expect(
			db.prepare('SELECT state, column_id, resumed_from_run_id FROM runs WHERE id = 12').get()
		).toEqual({ state: 'queued', column_id: 2, resumed_from_run_id: 1 });
		expect(db.prepare('SELECT state FROM runs WHERE id = 3').get()).toEqual({
			state: 'waiting_approval'
		});
	});

	it('drops transitions, the column kind, review flag and role, and the effort fields; adds step, generated phase, variant and size', () => {
		const db = dbBefore016();
		migrate(db);
		const columnsOf = (table: string) =>
			db
				.prepare(`SELECT name, hidden FROM pragma_table_xinfo('${table}')`)
				.all()
				.map((c) => (c.hidden === 0 ? String(c.name) : `${c.name} (generated)`));
		const uniqueKeys = (table: string) =>
			(
				db.prepare(`SELECT name FROM pragma_index_list('${table}') WHERE "unique" = 1`).all() as {
					name: string;
				}[]
			)
				.map(({ name }) =>
					db
						.prepare(`SELECT name FROM pragma_index_info('${name}') ORDER BY seqno`)
						.all()
						.map((c) => c.name)
						.join(', ')
				)
				.sort();

		expect(
			db.prepare("SELECT name FROM sqlite_master WHERE name = 'transitions'").get()
		).toBeUndefined();
		expect(columnsOf('columns')).toEqual([
			'id',
			'project_id',
			'step',
			'phase (generated)',
			'name',
			'position'
		]);
		expect(uniqueKeys('columns')).toEqual(['project_id, id', 'project_id, step']);
		expect(columnsOf('projects')).toContain('variant');
		expect(columnsOf('tickets')).toContain('size');
		expect(columnsOf('tickets').filter((name) => name.startsWith('effort'))).toEqual([]);

		const err = (() => {
			try {
				board.updateTicket(db, { kind: 'user' }, 101, { effort_estimate: 3 } as never);
			} catch (e) {
				return e as { code: string; hint: string };
			}
		})();
		expect(err).toMatchObject({ code: 'unknown_field' });
		expect(err?.hint).toContain('size');
		board.updateTicket(db, { kind: 'user' }, 101, { size: 'S' });
		expect(db.prepare('SELECT size FROM tickets WHERE id = 101').get()).toEqual({ size: 'S' });
	});

	it('gives the tasks that existed before 017 the owner agent', () => {
		const db = dbBefore016();
		migrate(db);
		expect(db.prepare('SELECT DISTINCT owner FROM tasks').all()).toEqual([{ owner: 'agent' }]);
		expect(rowCounts(db).tasks).toBe(2);
	});
});

const token = (n: number) => String(n).repeat(64);
const STEPS_AT_018: [variant: string, steps: string[]][] = [
	['software', ['backlog', 'refine', 'plan', 'implement', 'critique', 'acceptance', 'done']],
	['knowledge', ['backlog', 'research', 'draft', 'critique', 'acceptance', 'done']],
	['direct', ['backlog', 'implement', 'critique', 'acceptance', 'done']]
];

/**
 * Project p has a column 10p+i and a ticket 100+10p+i for the i-th step of its variant, so 113 is software/implement,
 * 122 knowledge/draft and 131 direct/implement. Runs in every state hang off the work tickets, and every table that
 * points to a ticket or a run holds rows that do.
 */
function dbBefore019() {
	const db = openDb(':memory:');
	migrate(db, shippedBefore('/migrations/019'));
	const project = db.prepare(
		'INSERT INTO projects (id, key, name, variant, ticket_seq) VALUES (?, ?, ?, ?, ?)'
	);
	const column = db.prepare(
		'INSERT INTO columns (id, project_id, step, name, position) VALUES (?, ?, ?, ?, ?)'
	);
	const ticket = db.prepare(
		'INSERT INTO tickets (id, project_id, number, column_id, title, position) VALUES (?, ?, ?, ?, ?, ?)'
	);
	STEPS_AT_018.forEach(([variant, steps], index) => {
		const p = index + 1;
		project.run(p, variant.slice(0, 3).toUpperCase(), variant, variant, steps.length);
		steps.forEach((step, i) => {
			column.run(10 * p + i, p, step, step, i);
			ticket.run(100 + 10 * p + i, p, i + 1, 10 * p + i, `${variant} ${step}`, i);
		});
	});
	db.exec(`
			UPDATE tickets SET type = 'epic', docs_required = 1, description = 'Alles' WHERE id = 111;
			UPDATE tickets SET assignee = 'agent (Run 4)', size = 'M', moved_by = '{"kind":"agent","runId":1}',
				created_at = '2026-10-12 09:00:00', updated_at = '2026-10-12 11:00:00' WHERE id = 113;
			UPDATE tickets SET review_approved_at = '2026-10-12 10:30:00', review_approved_by = '{"kind":"agent","runId":6}'
				WHERE id = 114;
			INSERT INTO tasks (id, ticket_id, title, position, done_at, owner) VALUES
				(1, 113, 'Parser', 0, '2026-10-12 10:00:00', 'agent'), (2, 113, 'Abnahme', 1, NULL, 'human'),
				(3, 122, 'Quellen', 0, NULL, 'system');
			INSERT INTO ticket_relations (from_ticket_id, to_ticket_id, type) VALUES
				(111, 113, 'parent_of'), (113, 114, 'blocks'), (121, 122, 'relates_to'), (132, 131, 'duplicate_of');
			INSERT INTO agent_profiles (id, name, executor, provider, model) VALUES (1, 'Lokal', 'builtin', 'openai-compatible', 'm');
			INSERT INTO runs (id, ticket_id, column_id, agent_profile_id, trigger, state, token_hash, worktree_path, branch,
					resumed_from_run_id, tokens_in, tokens_out, cost, error, created_at, started_at, finished_at, priority,
					resume_reason, not_before, halted, step_result) VALUES
				(1, 113, 13, 1, 'manual', 'succeeded', NULL, '/w/1', 'ticket/1', NULL, 10, 2, 0.5, NULL,
					'2026-10-12 10:00:00', '2026-10-12 10:00:01', '2026-10-12 10:05:00', 'normal', NULL, NULL, 0, 'done'),
				(2, 113, 13, 1, 'on_enter', 'paused', NULL, NULL, NULL, 1, 3, 1, 0.1, NULL,
					'2026-10-12 10:05:00', '2026-10-12 10:05:01', '2026-10-12 10:06:00', 'blocker', 'context_budget', NULL, 1, NULL),
				(3, 113, 13, 1, 'resume', 'queued', NULL, NULL, NULL, 2, 0, 0, 0, NULL,
					'2026-10-12 10:07:00', NULL, NULL, 'human', 'halt', '2026-10-14T08:00:00.000Z', 0, NULL),
				(4, 122, 22, 1, 'manual', 'running', '${token(4)}', NULL, NULL, NULL, 0, 0, 0, NULL,
					'2026-10-12 11:00:00', '2026-10-12 11:00:01', NULL, 'normal', NULL, NULL, 0, NULL),
				(5, 131, 31, 1, 'manual', 'waiting_approval', '${token(5)}', NULL, NULL, NULL, 0, 0, 0, NULL,
					'2026-10-12 11:00:00', '2026-10-12 11:00:01', NULL, 'normal', NULL, NULL, 0, NULL),
				(6, 114, 14, NULL, 'on_enter', 'failed', NULL, NULL, NULL, NULL, 0, 0, 0, '[x] kaputt',
					'2026-10-12 09:00:00', '2026-10-12 09:00:01', '2026-10-12 09:10:00', 'review', NULL, NULL, 0, 'blocked'),
				(7, 112, 12, 1, 'manual', 'cancelled', NULL, NULL, NULL, NULL, 0, 0, 0, NULL,
					'2026-10-12 09:00:00', NULL, '2026-10-12 09:00:30', 'normal', NULL, NULL, 0, NULL),
				(8, 112, NULL, 1, 'manual', 'paused', NULL, NULL, NULL, NULL, 0, 0, 0, NULL,
					'2026-10-12 12:00:00', '2026-10-12 12:00:01', '2026-10-12 12:01:00', 'normal', 'quota', NULL, 0, NULL);
			INSERT INTO run_events (run_id, seq, type, payload, idempotency_key, created_at) VALUES
				(2, 1, 'message', '{"text":"Stand"}', 'handoff', '2026-10-12 10:05:59'),
				(2, 2, 'intervention', '{"kind":"stagnation","attempt":1,"max":2}', NULL, '2026-10-12 10:06:00'),
				(5, 1, 'permission_request', '{"tool":"shell","command":"npm test"}', NULL, '2026-10-12 11:00:02');
			INSERT INTO comments (id, ticket_id, author_kind, author, body, run_id, redacted_at, redacted_reason) VALUES
				(1, 113, 'user', 'user', 'Bitte zuerst den Parser.', NULL, NULL, NULL),
				(2, 113, 'agent', 'agent (Run 1)', 'Parser steht.', 1, NULL, NULL),
				(3, 114, 'system', 'system', 'Run 6 ist fehlgeschlagen.', 6, NULL, NULL),
				(4, 112, 'agent', 'agent (Run 8)', '[entfernt]', 8, '2026-10-12 12:02:00', 'Secret');
			INSERT INTO questions (id, ticket_id, run_id, question, options, answer, answered_at, collected_at) VALUES
				(1, 112, 8, 'A oder B?', '[{"label":"A"},{"label":"B"}]', NULL, NULL, NULL),
				(2, 113, 1, 'Wie streng?', '[]', '{"text":"Streng"}', '2026-10-12 10:03:00', '2026-10-12 10:04:00'),
				(3, 121, NULL, 'Welche Quellen?', '[]', '{"option":1}', '2026-10-12 09:30:00', NULL);
			INSERT INTO idempotent_calls (run_id, key, request_hash, result) VALUES (4, 'k1', 'h', '{"task_ids":[3]}');
			INSERT INTO notes (id, slug, title, verified_at, verified_by_run_id) VALUES (1, 'parser', 'Parser', '2026-10-12 10:05:00', 1);
			INSERT INTO note_projects (note_id, project_id) VALUES (1, 1);
			INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (1, 113, 'documents');
		`);
	return db;
}

const everyRow = (db: ReturnType<typeof openDb>) =>
	Object.fromEntries(
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notes_fts%' AND name <> 'schema_migrations' ORDER BY name"
			)
			.all()
			.map(
				({ name }) =>
					[String(name), db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()] as const
			)
	);
const schemaOf = (db: ReturnType<typeof openDb>, table: string) =>
	db
		.prepare(
			'SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type DESC, name'
		)
		.all(table)
		.map((entry) => ({ type: entry.type, name: entry.name, sql: normalized(String(entry.sql)) }));
/** The statement without comments, quotes around names and layout whitespace. */
const normalized = (sql: string) =>
	sql
		.replace(/--[^\n]*/g, '')
		.replace(/"/g, '')
		.replace(/\s+/g, ' ')
		.replace(/\s*([(),])\s*/g, '$1')
		.trim();

describe('019 on a database at 018 with tickets in every step of every variant and runs in every state', () => {
	it('keeps every row of every table with all its columns, and nothing points into the void', () => {
		const db = dbBefore019();
		const before = everyRow(db);

		const upTo019 = shippedBefore('/migrations/020');
		expect(migrate(db, upTo019)).toEqual(['019_no_id_reuse.sql']);

		expect(before.tickets).toHaveLength(18);
		expect(new Set(before.runs.map((run) => run.state)).size).toBe(7);
		expect(everyRow(db)).toEqual(before);
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		expect(migrate(db, upTo019)).toEqual([]);
	});

	it('declares tickets and runs AUTOINCREMENT and changes nothing else about them, their indexes included', () => {
		const db = dbBefore019();
		const before = { tickets: schemaOf(db, 'tickets'), runs: schemaOf(db, 'runs') };

		migrate(db);

		for (const table of ['tickets', 'runs'] as const) {
			const after = schemaOf(db, table);
			expect(after[0].sql).toContain(' INTEGER PRIMARY KEY AUTOINCREMENT,');
			expect(
				after.map((entry) => ({ ...entry, sql: entry.sql.replace(' AUTOINCREMENT', '') }))
			).toEqual(before[table]);
		}
		expect(schemaOf(db, 'runs').map((entry) => entry.name)).toEqual([
			'runs',
			'runs_by_finished_at',
			'runs_by_resumed_from',
			'runs_by_state',
			'runs_by_ticket',
			'sqlite_autoindex_runs_1' // UNIQUE token_hash
		]);
		expect(recentFinishedRuns(db).map((run) => run.id)).toEqual([1, 6, 7]); // pins runs_by_finished_at by name
	});

	it('continues the ids after the current maximum and never hands out those of a deleted ticket or run again', () => {
		const db = dbBefore019();
		migrate(db);
		const human: Actor = { kind: 'user' };
		const createTicket = () => board.createTicket(db, human, 1, { title: 'Neu', column_id: 13 }).id;
		const createRun = (ticketId: number) =>
			runs.createRun(db, human, { ticketId, profileId: 1 }).id;

		expect(db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()).toEqual([
			{ name: 'runs', seq: 8 },
			{ name: 'tickets', seq: 134 }
		]);
		const deletedTicket = createTicket();
		expect([deletedTicket, createRun(deletedTicket)]).toEqual([135, 9]);
		board.deleteTicket(db, human, deletedTicket);

		const ticket = createTicket();
		expect([ticket, createRun(ticket)]).toEqual([136, 10]);
	});
});

describe('020 on a database at 019 with rows in every table', () => {
	function dbAt019() {
		const db = dbBefore019();
		expect(migrate(db, shippedBefore('/migrations/020'))).toEqual(['019_no_id_reuse.sql']);
		return db;
	}
	/** Every table, index and trigger, the automatic ones and sqlite_sequence included. */
	const wholeSchema = (db: ReturnType<typeof openDb>) =>
		db
			.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
			.all()
			.map((entry) => ({
				...entry,
				sql: entry.sql === null ? null : normalized(String(entry.sql))
			}));

	it('keeps every row of every table, and nothing points into the void', () => {
		const db = dbAt019();
		const before = everyRow(db);

		expect(migrate(db)).toEqual(['020_runners.sql']);

		const { runners, ...after } = everyRow(db);
		expect(runners).toEqual([]);
		expect(after).toEqual(before);
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		expect(migrate(db)).toEqual([]);
	});

	it('adds only the STRICT table runners with AUTOINCREMENT, and every other schema entry stays as it was', () => {
		const db = dbAt019();
		const before = wholeSchema(db);

		migrate(db);

		const after = wholeSchema(db);
		expect(after.filter((entry) => entry.tbl_name !== 'runners')).toEqual(before);
		const added = after.filter((entry) => entry.tbl_name === 'runners');
		expect(added.map((entry) => entry.name)).toEqual([
			'sqlite_autoindex_runners_1', // UNIQUE name
			'sqlite_autoindex_runners_2', // UNIQUE credential_hash
			'runners'
		]);
		expect(added[2].sql).toContain('id INTEGER PRIMARY KEY AUTOINCREMENT,');
		expect(added[2].sql).toMatch(/\)STRICT$/);
	});

	it('refuses a credential hash that is not 64 characters long, so a plain credential cannot slip in', () => {
		const db = dbAt019();
		migrate(db);
		const insert = db.prepare('INSERT INTO runners (name, credential_hash) VALUES (?, ?)');

		expect(() => insert.run('laptop', 'x'.repeat(43))).toThrow(/CHECK constraint failed/);
		expect(() => insert.run('', 'a'.repeat(64))).toThrow(/CHECK constraint failed/);
		insert.run('laptop', 'a'.repeat(64));
		expect(() => insert.run('desktop', 'a'.repeat(64))).toThrow(/UNIQUE constraint failed/);
	});
});

describe('migrate with foreign keys', () => {
	const shipped = import.meta.glob<string>('/migrations/*.sql', {
		query: '?raw',
		import: 'default',
		eager: true
	});
	const foreignKeys = (db: ReturnType<typeof openDb>) =>
		db.prepare('PRAGMA foreign_keys').get()?.foreign_keys;

	function dbWithLinkedNotes() {
		const db = openDb(':memory:');
		migrate(db);
		db.exec(`
			INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
			INSERT INTO columns (id, project_id, step, name) VALUES (10, 1, 'plan', 'Planen');
			INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 10, 'Ticket');
			INSERT INTO notes (id, slug, title) VALUES (1, 'note-a', 'A'), (2, 'note-b', 'B');
			INSERT INTO note_projects (note_id, project_id) VALUES (1, 1);
			INSERT INTO note_links (from_note_id, to_note_id, type) VALUES (2, 1, 'references');
			INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (1, 100, 'documents');
		`);
		return db;
	}

	// The documented SQLite procedure for a change ALTER TABLE cannot do (here: a new CHECK value).
	const rebuildNotes = `
		CREATE TABLE notes_new (
			id INTEGER PRIMARY KEY,
			slug TEXT NOT NULL UNIQUE,
			title TEXT NOT NULL,
			kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'adr', 'hub', 'method')),
			status TEXT,
			body TEXT NOT NULL DEFAULT '',
			tags TEXT NOT NULL DEFAULT '[]',
			archived INTEGER NOT NULL DEFAULT 0,
			verified_at TEXT,
			verified_by_run_id INTEGER,
			version INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		) STRICT;
		INSERT INTO notes_new SELECT * FROM notes;
		DROP TABLE notes;
		ALTER TABLE notes_new RENAME TO notes;
	`;

	it('rebuilds a table that other tables reference without deleting the rows that reference it', () => {
		const db = dbWithLinkedNotes();
		const referencingRows = () => ({
			links: db.prepare('SELECT * FROM note_links').all(),
			projects: db.prepare('SELECT * FROM note_projects').all(),
			tickets: db.prepare('SELECT * FROM note_tickets').all()
		});
		const before = referencingRows();

		expect(migrate(db, { ...shipped, '/migrations/999_rebuild_notes.sql': rebuildNotes })).toEqual([
			'999_rebuild_notes.sql'
		]);

		expect(referencingRows()).toEqual(before);
		expect(before.links).toHaveLength(1);
		// the references now point at the rebuilt table and are enforced again
		expect(() =>
			db.exec(
				"INSERT INTO note_links (from_note_id, to_note_id, type) VALUES (2, 999, 'references')"
			)
		).toThrow(/FOREIGN KEY/);
	});

	it('rolls back a migration that leaves a dangling reference and names the migration, table and row', () => {
		const db = dbWithLinkedNotes();
		// relies on ON DELETE CASCADE, which does not fire while a migration runs
		const orphaning = {
			...shipped,
			'/migrations/999_drop_note.sql': 'DELETE FROM notes WHERE id = 2'
		};

		expect(() => migrate(db, orphaning)).toThrowError(
			expect.objectContaining({
				code: 'migration_foreign_key_violation',
				message: expect.stringMatching(/999_drop_note\.sql.*note_links Zeile 1 .*notes/),
				hint: expect.stringContaining('backups/')
			})
		);
		expect(names(db)).not.toContain('999_drop_note.sql');
		expect(db.prepare('SELECT id FROM notes ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }]);
		expect(db.prepare('SELECT count(*) AS n FROM note_links').get()).toEqual({ n: 1 });
		expect(db.isTransaction).toBe(false);
		expect(foreignKeys(db)).toBe(1);
	});

	it('turns foreign keys back on after each migration, whether it succeeded or failed', () => {
		const db = openDb(':memory:');
		const ok = { '/m/001_ok.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY)' };

		migrate(db, ok);
		expect(foreignKeys(db)).toBe(1);

		expect(() => migrate(db, { ...ok, '/m/002_bad.sql': 'SELEKT kaputt' })).toThrow(
			'Migration 002_bad.sql fehlgeschlagen'
		);
		expect(foreignKeys(db)).toBe(1);
	});
});

describe('core schema', () => {
	let db: ReturnType<typeof openDb>;

	beforeEach(() => {
		db = openDb(':memory:');
		migrate(db);
		db.exec(`
		INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio'), (2, 'OTH', 'Anderes');
		INSERT INTO columns (id, project_id, step, name) VALUES (10, 1, 'plan', 'Planen'), (11, 1, 'done', 'Fertig'), (20, 2, 'plan', 'Planen');
		INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 10, 'Erstes'), (101, 1, 2, 10, 'Zweites');
		INSERT INTO tasks (ticket_id, title) VALUES (100, 'Kriterium');
		INSERT INTO comments (ticket_id, author_kind, author, body, redacted_at, redacted_reason) VALUES (100, 'agent', 'dev', 'x', CURRENT_TIMESTAMP, 'Secret');
		INSERT INTO ticket_relations VALUES (100, 101, 'blocks');
		INSERT INTO agent_profiles (id, name, executor, provider, model) VALUES (1, 'Lokal', 'builtin', 'openai-compatible', 'm');
		INSERT INTO runs (id, ticket_id, agent_profile_id, trigger) VALUES (1, 100, 1, 'manual');
		INSERT INTO run_events (run_id, seq, type) VALUES (1, 1, 'log');
		INSERT INTO comments (ticket_id, author_kind, author, body, run_id) VALUES (100, 'agent', 'agent (Run 1)', 'y', 1);
	`);
	});

	it.each([
		['duplicate project key', "INSERT INTO projects (key, name) VALUES ('STU', 'x')", /UNIQUE/],
		[
			'project key not upper-case letters/digits',
			"INSERT INTO projects (key, name) VALUES ('st-u', 'x')",
			/CHECK/
		],
		[
			'column without project',
			"INSERT INTO columns (project_id, step, name) VALUES (99, 'refine', 'x')",
			/FOREIGN KEY/
		],
		[
			'unknown step',
			"INSERT INTO columns (project_id, step, name) VALUES (1, 'archive', 'x')",
			/CHECK/
		],
		[
			'a second column for the same step',
			"INSERT INTO columns (project_id, step, name) VALUES (1, 'plan', 'Noch mal')",
			/UNIQUE/
		],
		[
			'a written phase',
			"INSERT INTO columns (project_id, step, phase, name) VALUES (1, 'refine', 'done', 'x')",
			/generated column/
		],
		[
			'unknown variant',
			"INSERT INTO projects (key, name, variant) VALUES ('VAR', 'x', 'kanban')",
			/CHECK/
		],
		['unknown size', "UPDATE tickets SET size = 'XXL' WHERE id = 100", /CHECK/],
		[
			'duplicate ticket number in a project',
			"INSERT INTO tickets (project_id, number, column_id, title) VALUES (1, 1, 10, 'x')",
			/UNIQUE/
		],
		[
			"ticket in another project's column",
			"INSERT INTO tickets (project_id, number, column_id, title) VALUES (1, 3, 20, 'x')",
			/FOREIGN KEY/
		],
		[
			'unknown ticket type',
			"INSERT INTO tickets (project_id, number, column_id, title, type) VALUES (1, 3, 10, 'x', 'bug')",
			/CHECK/
		],
		[
			'ticket without title',
			"INSERT INTO tickets (project_id, number, column_id, title) VALUES (1, 3, 10, '')",
			/CHECK/
		],
		[
			'wrong data type (STRICT)',
			"INSERT INTO tickets (project_id, number, column_id, title) VALUES (1, 'drei', 10, 'x')",
			/cannot store TEXT value in INTEGER column/
		],
		[
			'task without ticket',
			"INSERT INTO tasks (ticket_id, title) VALUES (999, 'x')",
			/FOREIGN KEY/
		],
		[
			'comment with unknown author kind',
			"INSERT INTO comments (ticket_id, author_kind, author, body) VALUES (100, 'bot', 'x', 'x')",
			/CHECK/
		],
		[
			'redaction without reason',
			"INSERT INTO comments (ticket_id, author_kind, author, body, redacted_at) VALUES (100, 'user', 'x', 'x', CURRENT_TIMESTAMP)",
			/CHECK/
		],
		['relation to itself', "INSERT INTO ticket_relations VALUES (100, 100, 'blocks')", /CHECK/],
		[
			'unknown relation type',
			"INSERT INTO ticket_relations VALUES (100, 101, 'depends_on')",
			/CHECK/
		],
		[
			'relation to a missing ticket',
			"INSERT INTO ticket_relations VALUES (100, 999, 'blocks')",
			/FOREIGN KEY/
		],
		['deleting a column that holds tickets', 'DELETE FROM columns WHERE id = 10', /FOREIGN KEY/],
		[
			'unknown blocks_satisfied_at',
			"UPDATE projects SET blocks_satisfied_at = 'review' WHERE id = 1",
			/CHECK/
		],
		[
			'review approval without actor',
			'UPDATE tickets SET review_approved_at = CURRENT_TIMESTAMP WHERE id = 100',
			/CHECK/
		],
		['actor not JSON', "UPDATE tickets SET moved_by = 'dev' WHERE id = 100", /CHECK/],
		[
			'profile with a plain-text key instead of a reference',
			"UPDATE agent_profiles SET api_key_ref = 'sk-abc123' WHERE id = 1",
			/CHECK/
		],
		[
			'builtin profile without model',
			"INSERT INTO agent_profiles (name, executor, provider) VALUES ('x', 'builtin', 'p')",
			/CHECK/
		],
		[
			'acp profile without command',
			"INSERT INTO agent_profiles (name, executor) VALUES ('x', 'acp')",
			/CHECK/
		],
		[
			'profile parameters not a JSON object',
			"UPDATE agent_profiles SET params = '[1]' WHERE id = 1",
			/CHECK/
		],
		['profile without a pool', "UPDATE agent_profiles SET pool = '' WHERE id = 1", /CHECK/],
		['unknown run state', "UPDATE runs SET state = 'done' WHERE id = 1", /CHECK/],
		[
			'run token on a queued run',
			"UPDATE runs SET token_hash = printf('%064d', 0) WHERE id = 1",
			/CHECK/
		],
		[
			'run token in plain text (wrong length)',
			"UPDATE runs SET state = 'running', token_hash = 'klartext' WHERE id = 1",
			/CHECK/
		],
		[
			'final state without finished_at',
			"UPDATE runs SET state = 'succeeded' WHERE id = 1",
			/CHECK/
		],
		[
			'failed without error text',
			"UPDATE runs SET state = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = 1",
			/CHECK/
		],
		[
			'run event with duplicate seq',
			"INSERT INTO run_events (run_id, seq, type) VALUES (1, 1, 'log')",
			/UNIQUE|PRIMARY KEY/
		],
		[
			'unknown run event type',
			"INSERT INTO run_events (run_id, seq, type) VALUES (1, 2, 'chat')",
			/CHECK/
		],
		[
			'run event payload not JSON',
			"INSERT INTO run_events (run_id, seq, type, payload) VALUES (1, 2, 'log', '{kaputt')",
			/CHECK/
		],
		[
			'duplicate idempotency key',
			"INSERT INTO run_events (run_id, seq, type, idempotency_key) VALUES (1, 2, 'log', 'k'), (1, 3, 'log', 'k')",
			/UNIQUE/
		],
		[
			'comment with unknown run',
			"INSERT INTO comments (ticket_id, author_kind, author, body, run_id) VALUES (100, 'agent', 'x', 'x', 99)",
			/FOREIGN KEY/
		],
		[
			'question with four options',
			"INSERT INTO questions (ticket_id, question, options) VALUES (100, 'q', '[1, 2, 3, 4]')",
			/CHECK/
		],
		[
			'answer without answered_at',
			`INSERT INTO questions (ticket_id, question, answer) VALUES (100, 'q', '{"option": 1}')`,
			/CHECK/
		],
		[
			'answer collected before it was given',
			"INSERT INTO questions (ticket_id, question, collected_at) VALUES (100, 'q', CURRENT_TIMESTAMP)",
			/CHECK/
		]
	])('rejects %s', (_, sql, error) => {
		expect(() => db.exec(sql)).toThrow(error);
	});

	it('deletes a project with its board by cascade', () => {
		db.exec('DELETE FROM projects WHERE id = 1');
		const count = (table: string) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
		const tables = [
			'columns',
			'tickets',
			'tasks',
			'comments',
			'ticket_relations',
			'runs',
			'run_events',
			'agent_profiles'
		];
		expect(tables.map(count)).toEqual([1, 0, 0, 0, 0, 0, 0, 1]); // left: the column of OTH and the (global) profile
	});
});

describe('notes schema', () => {
	let db: ReturnType<typeof openDb>;

	beforeEach(() => {
		db = openDb(':memory:');
		migrate(db);
		db.exec(`
		INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
		INSERT INTO columns (id, project_id, step, name) VALUES (10, 1, 'plan', 'Planen');
		INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 10, 'Ticket');
		INSERT INTO notes (id, slug, title, kind, status) VALUES (1, 'adr-a', 'A', 'adr', 'accepted'), (2, 'note-b', 'B', 'note', NULL);
		INSERT INTO note_projects (note_id, project_id) VALUES (1, 1);
		INSERT INTO note_links (from_note_id, to_note_id, type) VALUES (2, 1, 'references');
		INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (1, 100, 'documents');
	`);
	});

	it.each([
		['slug not kebab-case', "INSERT INTO notes (slug, title) VALUES ('Adr-A', 'x')", /CHECK/],
		[
			'unknown note kind',
			"INSERT INTO notes (slug, title, kind) VALUES ('n-x', 'x', 'faq')",
			/CHECK/
		],
		[
			'status without kind=adr',
			"INSERT INTO notes (slug, title, status) VALUES ('n-y', 'x', 'accepted')",
			/CHECK/
		],
		[
			'unknown status value',
			"INSERT INTO notes (slug, title, kind, status) VALUES ('n-z', 'x', 'adr', 'draft')",
			/CHECK/
		],
		['tags not a JSON array', "UPDATE notes SET tags = '{}' WHERE id = 1", /CHECK/],
		['duplicate slug', "INSERT INTO notes (slug, title) VALUES ('adr-a', 'x')", /UNIQUE/],
		[
			'note_projects without project',
			'INSERT INTO note_projects (note_id, project_id) VALUES (1, 999)',
			/FOREIGN KEY/
		],
		[
			'note_links to itself',
			"INSERT INTO note_links (from_note_id, to_note_id, type) VALUES (1, 1, 'references')",
			/CHECK/
		],
		[
			'unknown note_links type',
			"INSERT INTO note_links (from_note_id, to_note_id, type) VALUES (1, 2, 'related')",
			/CHECK/
		],
		[
			'unknown note_tickets relation',
			"INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (1, 100, 'mentions')",
			/CHECK/
		],
		[
			'note_tickets without ticket',
			"INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (1, 999, 'documents')",
			/FOREIGN KEY/
		],
		[
			'duplicate note_tickets relation',
			"INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (1, 100, 'documents')",
			/UNIQUE|PRIMARY KEY/
		]
	])('rejects %s', (_, sql, error) => {
		expect(() => db.exec(sql)).toThrow(error);
	});

	it('deletes a note by cascade from note_projects/note_links/note_tickets, and deleting a ticket cascades note_tickets', () => {
		db.exec('DELETE FROM notes WHERE id = 2'); // note-b links to adr-a via note_links
		expect(db.prepare('SELECT count(*) AS n FROM note_links').get()?.n).toBe(0);
		db.exec('DELETE FROM tickets WHERE id = 100');
		expect(db.prepare('SELECT count(*) AS n FROM note_tickets').get()?.n).toBe(0);
		expect(db.prepare('SELECT count(*) AS n FROM note_projects').get()?.n).toBe(1); // adr-a stays, only its ticket link is gone
	});

	it('keeps notes_fts in sync with INSERT/UPDATE/DELETE through FTS5 triggers', () => {
		const hits = (q: string) =>
			db
				.prepare(
					'SELECT n.slug FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid WHERE notes_fts MATCH ?'
				)
				.all(q)
				.map((r) => r.slug);
		// without a JOIN: a missing delete trigger would leave an orphaned row in notes_fts that a joined check masks
		// (the row in notes is gone as well), but a later reuse of the same rowid would then match wrongly.
		const rawHits = (q: string) =>
			db
				.prepare('SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?')
				.all(q)
				.map((r) => r.rowid);
		db.exec(
			"INSERT INTO notes (id, slug, title, body) VALUES (3, 'fts-x', 'FtsTitelWort', 'FtsBodyWort')"
		);
		expect(hits('FtsTitelWort')).toEqual(['fts-x']);
		db.exec("UPDATE notes SET body = 'FtsBodyWortGeaendert' WHERE id = 3");
		expect(hits('FtsBodyWort')).toEqual([]);
		expect(hits('FtsBodyWortGeaendert')).toEqual(['fts-x']);
		db.exec('DELETE FROM notes WHERE id = 3');
		expect(hits('FtsTitelWort')).toEqual([]);
		expect(rawHits('FtsTitelWort')).toEqual([]);
		expect(rawHits('FtsBodyWortGeaendert')).toEqual([]);
	});
});

describe('latestMigration', () => {
	it('names the most recently applied migration, for /api/health', () => {
		const db = openDb(join(tmp, 'latest-migration.db'));
		migrate(db, {
			'/m/001_a.sql': 'CREATE TABLE a (id INTEGER)',
			'/m/002_b.sql': 'CREATE TABLE b (id INTEGER)'
		});
		expect(latestMigration(db)).toBe('002_b.sql');
	});

	it('is null on a database with no migrations applied yet', () => {
		const db = openDb(join(tmp, 'no-migrations.db'));
		db.exec(
			'CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT'
		);
		expect(latestMigration(db)).toBeNull();
	});
});
