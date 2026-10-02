import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from './db';

const tmp = mkdtempSync(join(tmpdir(), 'studio-db-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const names = (db: ReturnType<typeof openDb>) =>
	db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name);

describe('openDb', () => {
	it('setzt WAL, foreign_keys und busy_timeout', () => {
		const db = openDb(join(tmp, 'pragmas.db'));
		expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
		expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
		expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
	});

	it('wartet auf eine zweite, bereits offene Verbindung statt sofort mit "database is locked" zu scheitern (#817)', async () => {
		const file = join(tmp, 'zweiter-prozess.db');
		// Simuliert einen zweiten, bereits laufenden Prozess auf der frischen Datei: hält eine
		// Lese-Transaktion (Shared Lock), die journal_mode=WAL zwingend braucht, für 300ms.
		const childScript = `
			const { DatabaseSync } = require('node:sqlite');
			const db = new DatabaseSync(${JSON.stringify(file)});
			db.exec('BEGIN');
			db.exec('SELECT 1 FROM sqlite_master');
			process.stdout.write('LOCKED\\n');
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
			db.exec('COMMIT');
		`;
		const child = spawn(process.execPath, ['-e', childScript], { stdio: ['ignore', 'pipe', 'inherit'] });
		await new Promise<void>((resolve) => {
			child.stdout.on('data', (chunk: Buffer) => {
				if (chunk.toString().includes('LOCKED')) resolve();
			});
		});

		const t0 = Date.now();
		const db = openDb(file); // darf nicht sofort scheitern — muss auf die Freigabe warten
		expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // hat wirklich gewartet, nicht nur Glück gehabt
		expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });

		await new Promise((resolve) => child.on('exit', resolve));
	});
});

describe('migrate', () => {
	it('ist idempotent: zweiter Lauf führt nichts aus', () => {
		const file = join(tmp, 'idem.db');
		const first = migrate(openDb(file));
		expect(first.slice(0, 2)).toEqual(['001_core_schema.sql', '002_workflow_state.sql']);
		expect(first).toContain('006_runs.sql');
		const db = openDb(file); // wie ein Neustart
		expect(migrate(db)).toEqual([]);
		expect(names(db)).toEqual(first);
	});

	it('überspringt, was ein anderer Prozess inzwischen angewendet hat (Prüfung in der Transaktion)', () => {
		const db = openDb(':memory:');
		// 001 simuliert den Konkurrenten: trägt 002 als angewendet ein, nachdem die Pending-Liste schon feststeht
		const ran = migrate(db, {
			'/m/001_a.sql': "CREATE TABLE a (id INTEGER); INSERT INTO schema_migrations (name) VALUES ('002_b.sql')",
			'/m/002_b.sql': 'CREATE TABLE b (id INTEGER)'
		});
		expect(ran).toEqual(['001_a.sql']);
		expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'b'").get()).toBeUndefined();
	});

	it('hält die Schreibsperre ab BEGIN: ein zweiter Prozess kann nicht dazwischen schreiben', () => {
		const file = join(tmp, 'konkurrenz.db');
		const base = { '/m/001_side.sql': 'CREATE TABLE side (x INTEGER)' };
		migrate(openDb(file), base);
		const other = openDb(file);
		other.exec('PRAGMA busy_timeout = 0');
		const [a, rival] = [openDb(file), { wrote: false }];
		// Direkt bevor A die Migration ausführt (nach BEGIN und Re-Check), versucht ein zweiter Prozess zu schreiben.
		// Mit plain BEGIN gelänge das, und A scheiterte danach mit „database is locked" (veralteter Snapshot).
		const spy = new Proxy(a, {
			get(target, prop) {
				if (prop === 'exec')
					return (sql: string) => {
						if (sql.startsWith('CREATE TABLE x'))
							try {
								other.exec('INSERT INTO side VALUES (1)');
								rival.wrote = true;
							} catch {
								/* gesperrt — erwartet */
							}
						return target.exec(sql);
					};
				const value = Reflect.get(target, prop);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		expect(migrate(spy, { ...base, '/m/002_x.sql': 'CREATE TABLE x (id INTEGER)' })).toEqual(['002_x.sql']);
		expect(rival.wrote).toBe(false);
	});

	it('wendet in Namensreihenfolge an, unabhängig von der Eingabereihenfolge', () => {
		const db = openDb(':memory:');
		const ran = migrate(db, { '/m/002_b.sql': 'CREATE TABLE b (a_id INTEGER REFERENCES a (id))', '/m/001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY)' });
		expect(ran).toEqual(['001_a.sql', '002_b.sql']);
	});

	it('rollt eine fehlgeschlagene Migration vollständig zurück', () => {
		const db = openDb(':memory:');
		const ok = { '/m/001_ok.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY)' };
		const bad = { '/m/002_bad.sql': 'CREATE TABLE b (id INTEGER); INSERT INTO a VALUES (1); SELEKT kaputt;' };

		expect(() => migrate(db, { ...ok, ...bad })).toThrow('Migration 002_bad.sql fehlgeschlagen');
		expect(names(db)).toEqual(['001_ok.sql']);
		expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'b'").get()).toBeUndefined();
		expect(db.prepare('SELECT count(*) AS n FROM a').get()).toEqual({ n: 0 });
		expect(db.isTransaction).toBe(false);

		// korrigiert läuft sie beim nächsten Start
		expect(migrate(db, { ...ok, '/m/002_bad.sql': 'CREATE TABLE b (id INTEGER)' })).toEqual(['002_bad.sql']);
	});

	it('aborts before any transaction when schema_migrations has a migration this code does not know (DB newer than code, e.g. after a downgrade) — known, still-pending migrations are not applied either', () => {
		const db = openDb(':memory:');
		migrate(db, { '/m/001_a.sql': 'CREATE TABLE a (id INTEGER)' });
		db.exec("INSERT INTO schema_migrations (name) VALUES ('003_future.sql')");
		const withPending = { '/m/001_a.sql': 'CREATE TABLE a (id INTEGER)', '/m/002_b.sql': 'CREATE TABLE b (id INTEGER)' };

		expect(() => migrate(db, withPending)).toThrowError(
			expect.objectContaining({
				code: 'db_newer_than_code',
				message: expect.stringContaining('003_future.sql'),
				hint: expect.stringMatching(/neuere Studio-Version installieren|ältere Sicherung wiederherstellen/)
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

		expect(() => migrate(db, { '/m/001_a.sql': 'CREATE TABLE a (id INTEGER)', '/m/002_b.sql': 'CREATE TABLE b (id INTEGER)' }, beforeUpgrade)).toThrowError(
			expect.objectContaining({ code: 'db_newer_than_code' })
		);
		expect(beforeUpgrade).not.toHaveBeenCalled();
	});

	it('006 ergänzt comments.run_id (mit FK) auch in einer DB mit Kommentaren', () => {
		const bundled = import.meta.glob<string>('/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
		const db = openDb(':memory:');
		migrate(db, Object.fromEntries(Object.entries(bundled).filter(([path]) => path < '/migrations/006'))); // schema before 006; later migrations build on it
		db.exec(`
			INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
			INSERT INTO columns (id, project_id, name) VALUES (10, 1, 'Ready');
			INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 10, 'Alt');
			INSERT INTO comments (ticket_id, author_kind, author, body) VALUES (100, 'user', 'user', 'vorher');
		`);
		expect(migrate(db)[0]).toBe('006_runs.sql');
		expect(db.prepare('SELECT body, run_id FROM comments').all()).toEqual([{ body: 'vorher', run_id: null }]);
		expect(() => db.exec("INSERT INTO comments (ticket_id, author_kind, author, body, run_id) VALUES (100, 'agent', 'x', 'x', 7)")).toThrow(/FOREIGN KEY/);
	});

	it('005 setzt docs_required für Epics, die schon vor der Migration bestanden (die Domain-Regel „Epic immer docs_required" kennt nur das Flag, keinen Sonderfall für type=epic)', () => {
		const bundled = import.meta.glob<string>('/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
		const db = openDb(':memory:');
		migrate(db, Object.fromEntries(Object.entries(bundled).filter(([path]) => !path.endsWith('/005_notes.sql'))));
		db.exec(`
			INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
			INSERT INTO columns (id, project_id, name) VALUES (10, 1, 'Ready');
			INSERT INTO tickets (id, project_id, number, column_id, title, type, docs_required) VALUES
				(100, 1, 1, 10, 'Altes Epic', 'epic', 0),
				(101, 1, 2, 10, 'Altes Ticket', 'ticket', 0);
		`);
		expect(migrate(db)).toEqual(['005_notes.sql']);
		expect(db.prepare('SELECT id, docs_required FROM tickets ORDER BY id').all()).toEqual([
			{ id: 100, docs_required: 1 }, // Bestands-Epic nachgezogen
			{ id: 101, docs_required: 0 } // gewöhnliches Ticket unberührt
		]);
	});

	it('009 marks existing Review columns and gives existing runs the normal priority', () => {
		const bundled = import.meta.glob<string>('/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
		const db = openDb(':memory:');
		migrate(db, Object.fromEntries(Object.entries(bundled).filter(([path]) => path < '/migrations/009')));
		db.exec(`
			INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
			INSERT INTO columns (id, project_id, name) VALUES (10, 1, 'In Arbeit'), (11, 1, 'Review');
			INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 11, 'Old');
			INSERT INTO agent_profiles (id, name, executor, provider, model) VALUES (1, 'p', 'builtin', 'openai-compatible', 'm');
			INSERT INTO runs (id, ticket_id, column_id, agent_profile_id, trigger) VALUES (7, 100, 11, 1, 'on_enter');
		`);
		expect(migrate(db)[0]).toBe('009_run_priority.sql');
		expect(db.prepare('SELECT name, review FROM columns ORDER BY id').all()).toEqual([{ name: 'In Arbeit', review: 0 }, { name: 'Review', review: 1 }]);
		expect(db.prepare('SELECT priority FROM runs').all()).toEqual([{ priority: 'normal' }]);
		expect(migrate(db)).toEqual([]);
		expect(() => db.exec("UPDATE runs SET priority = 'urgent'")).toThrow(/CHECK/);
	});

	it('011 keeps existing run events with their keys, accepts intervention, still refuses unknown event types and adds the resume columns', () => {
		const bundled = import.meta.glob<string>('/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
		const db = openDb(':memory:');
		migrate(db, Object.fromEntries(Object.entries(bundled).filter(([path]) => path < '/migrations/011')));
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
		db.exec(`INSERT INTO run_events (run_id, seq, type, payload) VALUES (7, 3, 'intervention', '{"kind":"stagnation","attempt":1,"max":2}')`);
		expect(() => db.exec("INSERT INTO run_events (run_id, seq, type) VALUES (7, 4, 'nudge')")).toThrow(/CHECK/);
		expect(() => db.exec("INSERT INTO run_events (run_id, seq, type, idempotency_key) VALUES (7, 4, 'log', 'call-1')")).toThrow(/UNIQUE/);
		expect(() => db.exec("INSERT INTO run_events (run_id, seq, type) VALUES (7, 1, 'log')")).toThrow(/UNIQUE/);
		expect(() => db.exec("INSERT INTO run_events (run_id, seq, type) VALUES (8, 1, 'log')")).toThrow(/FOREIGN KEY/);

		expect(db.prepare('SELECT resume_reason, not_before FROM runs').all()).toEqual([{ resume_reason: null, not_before: null }]);
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

describe('Kernschema', () => {
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
		['Projekt-Key doppelt', "INSERT INTO projects (key, name) VALUES ('STU', 'x')", /UNIQUE/],
		['Projekt-Key nicht Großbuchstaben/Ziffern', "INSERT INTO projects (key, name) VALUES ('st-u', 'x')", /CHECK/],
		['Spalte ohne Projekt', "INSERT INTO columns (project_id, name) VALUES (99, 'x')", /FOREIGN KEY/],
		['Spaltenart unbekannt', "INSERT INTO columns (project_id, name, kind) VALUES (1, 'x', 'archive')", /CHECK/],
		['Transition in Spalte eines anderen Projekts', 'INSERT INTO transitions (project_id, from_column_id, to_column_id) VALUES (1, 10, 20)', /FOREIGN KEY/],
		['Transition auf sich selbst', 'INSERT INTO transitions (project_id, from_column_id, to_column_id) VALUES (1, 10, 10)', /CHECK/],
		['Transition doppelt', 'INSERT INTO transitions (project_id, from_column_id, to_column_id) VALUES (1, 10, 11)', /UNIQUE|PRIMARY KEY/],
		['Ticketnummer im Projekt doppelt', "INSERT INTO tickets (project_id, number, column_id, title) VALUES (1, 1, 10, 'x')", /UNIQUE/],
		['Ticket in Spalte eines anderen Projekts', "INSERT INTO tickets (project_id, number, column_id, title) VALUES (1, 3, 20, 'x')", /FOREIGN KEY/],
		['Tickettyp unbekannt', "INSERT INTO tickets (project_id, number, column_id, title, type) VALUES (1, 3, 10, 'x', 'bug')", /CHECK/],
		['Ticket ohne Titel', "INSERT INTO tickets (project_id, number, column_id, title) VALUES (1, 3, 10, '')", /CHECK/],
		['falscher Datentyp (STRICT)', "INSERT INTO tickets (project_id, number, column_id, title) VALUES (1, 'drei', 10, 'x')", /cannot store TEXT value in INTEGER column/],
		['Task ohne Ticket', "INSERT INTO tasks (ticket_id, title) VALUES (999, 'x')", /FOREIGN KEY/],
		['Kommentar mit unbekannter Autorenart', "INSERT INTO comments (ticket_id, author_kind, author, body) VALUES (100, 'bot', 'x', 'x')", /CHECK/],
		['Redaktion ohne Grund', "INSERT INTO comments (ticket_id, author_kind, author, body, redacted_at) VALUES (100, 'user', 'x', 'x', CURRENT_TIMESTAMP)", /CHECK/],
		['Relation auf sich selbst', "INSERT INTO ticket_relations VALUES (100, 100, 'blocks')", /CHECK/],
		['Relationstyp unbekannt', "INSERT INTO ticket_relations VALUES (100, 101, 'depends_on')", /CHECK/],
		['Relation zu fehlendem Ticket', "INSERT INTO ticket_relations VALUES (100, 999, 'blocks')", /FOREIGN KEY/],
		['Spalte mit Tickets löschen', 'DELETE FROM columns WHERE id = 10', /FOREIGN KEY/],
		['blocks_satisfied_at unbekannt', "UPDATE projects SET blocks_satisfied_at = 'review' WHERE id = 1", /CHECK/],
		['Review-Freigabe ohne Actor', 'UPDATE tickets SET review_approved_at = CURRENT_TIMESTAMP WHERE id = 100', /CHECK/],
		['Actor kein JSON', "UPDATE tickets SET moved_by = 'dev' WHERE id = 100", /CHECK/],
		['Profil mit Klartext-Key statt Verweis', "UPDATE agent_profiles SET api_key_ref = 'sk-abc123' WHERE id = 1", /CHECK/],
		['builtin-Profil ohne Modell', "INSERT INTO agent_profiles (name, executor, provider) VALUES ('x', 'builtin', 'p')", /CHECK/],
		['acp-Profil ohne Kommando', "INSERT INTO agent_profiles (name, executor) VALUES ('x', 'acp')", /CHECK/],
		['Profil-Parameter kein JSON-Objekt', "UPDATE agent_profiles SET params = '[1]' WHERE id = 1", /CHECK/],
		['profile without a pool', "UPDATE agent_profiles SET pool = '' WHERE id = 1", /CHECK/],
		['Run-Zustand unbekannt', "UPDATE runs SET state = 'done' WHERE id = 1", /CHECK/],
		['Run-Token in wartendem Run', "UPDATE runs SET token_hash = printf('%064d', 0) WHERE id = 1", /CHECK/],
		['Run-Token im Klartext (falsche Länge)', "UPDATE runs SET state = 'running', token_hash = 'klartext' WHERE id = 1", /CHECK/],
		['Endzustand ohne finished_at', "UPDATE runs SET state = 'succeeded' WHERE id = 1", /CHECK/],
		['failed ohne Fehlertext', "UPDATE runs SET state = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = 1", /CHECK/],
		['Run-Event mit doppelter seq', "INSERT INTO run_events (run_id, seq, type) VALUES (1, 1, 'log')", /UNIQUE|PRIMARY KEY/],
		['Run-Event-Typ unbekannt', "INSERT INTO run_events (run_id, seq, type) VALUES (1, 2, 'chat')", /CHECK/],
		['Run-Event-Payload kein JSON', "INSERT INTO run_events (run_id, seq, type, payload) VALUES (1, 2, 'log', '{kaputt')", /CHECK/],
		['Idempotenz-Schlüssel doppelt', "INSERT INTO run_events (run_id, seq, type, idempotency_key) VALUES (1, 2, 'log', 'k'), (1, 3, 'log', 'k')", /UNIQUE/],
		['Kommentar mit unbekanntem Run', "INSERT INTO comments (ticket_id, author_kind, author, body, run_id) VALUES (100, 'agent', 'x', 'x', 99)", /FOREIGN KEY/],
		['question with four options', "INSERT INTO questions (ticket_id, question, options) VALUES (100, 'q', '[1, 2, 3, 4]')", /CHECK/],
		['answer without answered_at', `INSERT INTO questions (ticket_id, question, answer) VALUES (100, 'q', '{"option": 1}')`, /CHECK/],
		['answer collected before it was given', "INSERT INTO questions (ticket_id, question, collected_at) VALUES (100, 'q', CURRENT_TIMESTAMP)", /CHECK/]
	])('weist ab: %s', (_, sql, error) => {
		expect(() => db.exec(sql)).toThrow(error);
	});

	it('löscht ein Projekt samt Board kaskadierend', () => {
		db.exec('DELETE FROM projects WHERE id = 1');
		const count = (table: string) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
		const tables = ['columns', 'transitions', 'tickets', 'tasks', 'comments', 'ticket_relations', 'runs', 'run_events', 'agent_profiles'];
		expect(tables.map(count)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 1]); // übrig: die Spalte von OTH und das Profil (global)
	});
});

describe('Notes-Schema', () => {
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
		['Slug nicht kebab-case', "INSERT INTO notes (slug, title) VALUES ('Adr-A', 'x')", /CHECK/],
		['Notekind unbekannt', "INSERT INTO notes (slug, title, kind) VALUES ('n-x', 'x', 'faq')", /CHECK/],
		['Status ohne kind=adr', "INSERT INTO notes (slug, title, status) VALUES ('n-y', 'x', 'accepted')", /CHECK/],
		['Status-Wert unbekannt', "INSERT INTO notes (slug, title, kind, status) VALUES ('n-z', 'x', 'adr', 'draft')", /CHECK/],
		['tags kein JSON-Array', "UPDATE notes SET tags = '{}' WHERE id = 1", /CHECK/],
		['Slug doppelt', "INSERT INTO notes (slug, title) VALUES ('adr-a', 'x')", /UNIQUE/],
		['note_projects ohne Projekt', 'INSERT INTO note_projects (note_id, project_id) VALUES (1, 999)', /FOREIGN KEY/],
		['note_links auf sich selbst', "INSERT INTO note_links (from_note_id, to_note_id, type) VALUES (1, 1, 'references')", /CHECK/],
		['note_links Typ unbekannt', "INSERT INTO note_links (from_note_id, to_note_id, type) VALUES (1, 2, 'related')", /CHECK/],
		['note_tickets Relation unbekannt', "INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (1, 100, 'mentions')", /CHECK/],
		['note_tickets ohne Ticket', "INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (1, 999, 'documents')", /FOREIGN KEY/],
		['note_tickets Relation doppelt', "INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (1, 100, 'documents')", /UNIQUE|PRIMARY KEY/]
	])('weist ab: %s', (_, sql, error) => {
		expect(() => db.exec(sql)).toThrow(error);
	});

	it('löscht eine Note kaskadierend aus note_projects/note_links/note_tickets; ein Ticket löschen kaskadiert note_tickets', () => {
		db.exec('DELETE FROM notes WHERE id = 2'); // note-b verweist per note_links auf adr-a
		expect(db.prepare('SELECT count(*) AS n FROM note_links').get()?.n).toBe(0);
		db.exec('DELETE FROM tickets WHERE id = 100');
		expect(db.prepare('SELECT count(*) AS n FROM note_tickets').get()?.n).toBe(0);
		expect(db.prepare('SELECT count(*) AS n FROM note_projects').get()?.n).toBe(1); // adr-a bleibt, nur ihr Ticket-Link ist weg
	});

	it('FTS5-Trigger halten notes_fts synchron mit INSERT/UPDATE/DELETE', () => {
		const hits = (q: string) => db.prepare("SELECT n.slug FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid WHERE notes_fts MATCH ?").all(q).map((r) => r.slug);
		// ohne JOIN: ein fehlender AD-Trigger ließe eine verwaiste Zeile in notes_fts zurück, die der gejointe Check maskiert
		// (die Zeile in notes fehlt dann ja auch), eine spätere Wiederverwendung derselben rowid träfe aber falsch.
		const rawHits = (q: string) => db.prepare('SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?').all(q).map((r) => r.rowid);
		db.exec("INSERT INTO notes (id, slug, title, body) VALUES (3, 'fts-x', 'FtsTitelWort', 'FtsBodyWort')");
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
