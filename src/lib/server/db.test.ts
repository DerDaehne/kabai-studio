import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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

	it('006 ergänzt comments.run_id (mit FK) auch in einer DB mit Kommentaren', () => {
		const bundled = import.meta.glob<string>('/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
		const db = openDb(':memory:');
		migrate(db, Object.fromEntries(Object.entries(bundled).filter(([path]) => !path.endsWith('/006_runs.sql'))));
		db.exec(`
			INSERT INTO projects (id, key, name) VALUES (1, 'STU', 'Studio');
			INSERT INTO columns (id, project_id, name) VALUES (10, 1, 'Ready');
			INSERT INTO tickets (id, project_id, number, column_id, title) VALUES (100, 1, 1, 10, 'Alt');
			INSERT INTO comments (ticket_id, author_kind, author, body) VALUES (100, 'user', 'user', 'vorher');
		`);
		expect(migrate(db)).toEqual(['006_runs.sql']);
		expect(db.prepare('SELECT body, run_id FROM comments').all()).toEqual([{ body: 'vorher', run_id: null }]);
		expect(() => db.exec("INSERT INTO comments (ticket_id, author_kind, author, body, run_id) VALUES (100, 'agent', 'x', 'x', 7)")).toThrow(/FOREIGN KEY/);
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
		['Run-Zustand unbekannt', "UPDATE runs SET state = 'done' WHERE id = 1", /CHECK/],
		['Run-Token in wartendem Run', "UPDATE runs SET token_hash = printf('%064d', 0) WHERE id = 1", /CHECK/],
		['Run-Token im Klartext (falsche Länge)', "UPDATE runs SET state = 'running', token_hash = 'klartext' WHERE id = 1", /CHECK/],
		['Endzustand ohne finished_at', "UPDATE runs SET state = 'succeeded' WHERE id = 1", /CHECK/],
		['failed ohne Fehlertext', "UPDATE runs SET state = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = 1", /CHECK/],
		['Run-Event mit doppelter seq', "INSERT INTO run_events (run_id, seq, type) VALUES (1, 1, 'log')", /UNIQUE|PRIMARY KEY/],
		['Run-Event-Typ unbekannt', "INSERT INTO run_events (run_id, seq, type) VALUES (1, 2, 'chat')", /CHECK/],
		['Run-Event-Payload kein JSON', "INSERT INTO run_events (run_id, seq, type, payload) VALUES (1, 2, 'log', '{kaputt')", /CHECK/],
		['Idempotenz-Schlüssel doppelt', "INSERT INTO run_events (run_id, seq, type, idempotency_key) VALUES (1, 2, 'log', 'k'), (1, 3, 'log', 'k')", /UNIQUE/],
		['Kommentar mit unbekanntem Run', "INSERT INTO comments (ticket_id, author_kind, author, body, run_id) VALUES (100, 'agent', 'x', 'x', 99)", /FOREIGN KEY/]
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
