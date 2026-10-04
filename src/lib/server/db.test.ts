import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { latestMigration, migrate, openDb } from './db';

const tmp = mkdtempSync(join(tmpdir(), 'studio-db-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const names = (db: ReturnType<typeof openDb>) =>
	db
		.prepare('SELECT name FROM schema_migrations ORDER BY name')
		.all()
		.map((r) => r.name);

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
			INSERT INTO columns (id, project_id, name) VALUES (10, 1, 'Ready');
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
		expect(migrate(db)[0]).toBe('009_run_priority.sql');
		expect(db.prepare('SELECT name, review FROM columns ORDER BY id').all()).toEqual([
			{ name: 'In Arbeit', review: 0 },
			{ name: 'Review', review: 1 }
		]);
		expect(db.prepare('SELECT priority FROM runs').all()).toEqual([{ priority: 'normal' }]);
		expect(migrate(db)).toEqual([]);
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
			INSERT INTO columns (id, project_id, name) VALUES (10, 1, 'Ready');
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
	const db = openDb(':memory:');
	migrate(db);
	db.exec(`
		INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio'), (2, 'OTH', 'Anderes');
		INSERT INTO columns (id, project_id, name, kind) VALUES (10, 1, 'Ready', 'normal'), (11, 1, 'Done', 'done'), (20, 2, 'Fremd', 'normal');
		INSERT INTO transitions (project_id, from_column_id, to_column_id, requires_human) VALUES (1, 10, 11, 1);
		INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 10, 'Erstes'), (101, 1, 2, 10, 'Zweites');
		INSERT INTO tasks (ticket_id, title) VALUES (100, 'Kriterium');
		INSERT INTO comments (ticket_id, author_kind, author, body, redacted_at, redacted_reason) VALUES (100, 'agent', 'dev', 'x', CURRENT_TIMESTAMP, 'Secret');
		INSERT INTO ticket_relations VALUES (100, 101, 'blocks');
		INSERT INTO agent_profiles (id, name, executor, provider, model) VALUES (1, 'Lokal', 'builtin', 'openai-compatible', 'm');
		INSERT INTO runs (id, ticket_id, agent_profile_id, trigger) VALUES (1, 100, 1, 'manual');
		INSERT INTO run_events (run_id, seq, type) VALUES (1, 1, 'log');
		INSERT INTO comments (ticket_id, author_kind, author, body, run_id) VALUES (100, 'agent', 'agent (Run 1)', 'y', 1);
	`);

	it.each([
		['duplicate project key', "INSERT INTO projects (key, name) VALUES ('STU', 'x')", /UNIQUE/],
		[
			'project key not upper-case letters/digits',
			"INSERT INTO projects (key, name) VALUES ('st-u', 'x')",
			/CHECK/
		],
		[
			'column without project',
			"INSERT INTO columns (project_id, name) VALUES (99, 'x')",
			/FOREIGN KEY/
		],
		[
			'unknown column kind',
			"INSERT INTO columns (project_id, name, kind) VALUES (1, 'x', 'archive')",
			/CHECK/
		],
		[
			"transition into another project's column",
			'INSERT INTO transitions (project_id, from_column_id, to_column_id) VALUES (1, 10, 20)',
			/FOREIGN KEY/
		],
		[
			'transition to itself',
			'INSERT INTO transitions (project_id, from_column_id, to_column_id) VALUES (1, 10, 10)',
			/CHECK/
		],
		[
			'duplicate transition',
			'INSERT INTO transitions (project_id, from_column_id, to_column_id) VALUES (1, 10, 11)',
			/UNIQUE|PRIMARY KEY/
		],
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
			'transitions',
			'tickets',
			'tasks',
			'comments',
			'ticket_relations',
			'runs',
			'run_events',
			'agent_profiles'
		];
		expect(tables.map(count)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 1]); // left: the column of OTH and the (global) profile
	});
});

describe('notes schema', () => {
	const db = openDb(':memory:');
	migrate(db);
	db.exec(`
		INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
		INSERT INTO columns (id, project_id, name) VALUES (10, 1, 'Ready');
		INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 10, 'Ticket');
		INSERT INTO notes (id, slug, title, kind, status) VALUES (1, 'adr-a', 'A', 'adr', 'accepted'), (2, 'note-b', 'B', 'note', NULL);
		INSERT INTO note_projects (note_id, project_id) VALUES (1, 1);
		INSERT INTO note_links (from_note_id, to_note_id, type) VALUES (2, 1, 'references');
		INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (1, 100, 'documents');
	`);

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
