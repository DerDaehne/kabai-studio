import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { backup, backupIfDue, backupStatus, listBackups, prune } from './backup';
import { migrate, openDb } from './db';

const tmp = mkdtempSync(join(tmpdir(), 'studio-backup-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HOUR = 3_600_000;
const names = (dir: string) => listBackups(dir).map((b) => b.file);

/** Schema + alle Zeilen aller Tabellen; Zeilen sortiert, weil VACUUM Rowids ohne INTEGER PRIMARY KEY neu vergeben darf. */
function dump(db: DatabaseSync) {
	const tables = db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
	const rows = tables
		.filter((t) => t.type === 'table')
		.map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}"`).all().map((r) => JSON.stringify(r)).sort()]);
	return { tables, rows: Object.fromEntries(rows) };
}

/** Kleine Studio-DB mit Daten in mehreren Tabellen (inkl. FTS5 und BLOBs). */
function seed(file: string) {
	const db = openDb(file);
	migrate(db);
	db.exec(`
		INSERT INTO projects (key, name) VALUES ('ALPHA', 'Alpha');
		INSERT INTO notes (slug, title, body) VALUES ('erste-note', 'Erste Note', 'Volltext über Sicherungen');
		INSERT INTO secrets (name, ciphertext, iv, auth_tag) VALUES ('api-key', randomblob(32), randomblob(12), randomblob(16));
	`);
	return db;
}

/** Überschreibt die Wurzelseite einer Tabelle mit Müll (DB-Datei ohne offenes WAL). */
function corruptTable(file: string, table: string) {
	const db = new DatabaseSync(file);
	const { rootpage } = db.prepare('SELECT rootpage FROM sqlite_schema WHERE name = ?').get(table)!;
	const { page_size } = db.prepare('PRAGMA page_size').get()!;
	db.close();
	const fd = openSync(file, 'r+');
	writeSync(fd, Buffer.alloc(Number(page_size), 0xff), 0, Number(page_size), (Number(rootpage) - 1) * Number(page_size));
	closeSync(fd);
}

describe('Sicherung vor Migration', () => {
	const m1 = { '/m/001_a.sql': 'CREATE TABLE a (x INTEGER) STRICT;' };
	const m2 = { ...m1, '/m/002_b.sql': 'CREATE TABLE b (x INTEGER) STRICT;' };

	it('sichert nur, wenn Migrationen anstehen und die DB nicht leer ist — mit dem Stand davor', () => {
		const dir = join(tmp, 'pre');
		const db = openDb(join(tmp, 'pre.db'));
		const hook = () => void backup(db, dir);
		migrate(db, m1, hook); // leere DB: nichts zu sichern
		expect(names(dir)).toEqual([]);
		db.exec('INSERT INTO a VALUES (42)');
		migrate(db, m1, hook); // nichts steht an
		expect(names(dir)).toEqual([]);

		expect(migrate(db, m2, hook)).toEqual(['002_b.sql']);
		expect(names(dir)).toHaveLength(1);
		const copy = new DatabaseSync(join(dir, names(dir)[0]));
		expect(copy.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_a.sql' }]);
		expect(copy.prepare('SELECT x FROM a').all()).toEqual([{ x: 42 }]);
		copy.close();
	});

	it('scheitert die Sicherung, wird nichts migriert', () => {
		const db = openDb(join(tmp, 'pre-fail.db'));
		migrate(db, m1);
		expect(() =>
			migrate(db, m2, () => {
				throw new Error('Platte voll');
			})
		).toThrow('Platte voll');
		expect(db.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_a.sql' }]);
	});
});

describe('Sicherung', () => {
	it('benennt nach UTC-Minute und bleibt in derselben Minute eindeutig', () => {
		const dir = join(tmp, 'names');
		const db = seed(join(tmp, 'names.db'));
		const at = new Date('2026-03-01T23:59:30+01:00'); // lokal schon der 1., in UTC noch 22:59
		expect(backup(db, dir, at)).toBe(join(dir, 'studio-20260301-2259.db'));
		expect(backup(db, dir, at)).toBe(join(dir, 'studio-20260301-2259-2.db'));
		expect(backup(db, dir, at)).toBe(join(dir, 'studio-20260301-2259-3.db'));
		expect(names(dir)).toEqual(['studio-20260301-2259-3.db', 'studio-20260301-2259-2.db', 'studio-20260301-2259.db']);
	});

	it('ein abgebrochener Lauf hinterlässt keine gültige Sicherung', () => {
		const dir = join(tmp, 'abort');
		const file = join(tmp, 'abort.db');
		seed(file).close();
		corruptTable(file, 'projects'); // VACUUM INTO bricht beim Lesen ab, nachdem es die Zieldatei schon angelegt hat
		expect(() => backup(openDb(file), dir)).toThrow(/Sicherung nach .* fehlgeschlagen .* Speicherplatz und Schreibrechte prüfen/);
		expect(readdirSync(dir)).toEqual([]); // weder gültige Sicherung noch Temp-Rest
	});

	it('ein Temp-Rest aus einem Absturz gilt nie als Sicherung und blockiert die nächste nicht', () => {
		const dir = join(tmp, 'stale');
		mkdirSync(dir);
		writeFileSync(join(dir, 'studio-20260101-0000.db.tmp'), 'halb geschrieben');
		expect(listBackups(dir)).toEqual([]);
		expect(backupStatus(dir).last).toBeNull();
		backup(seed(join(tmp, 'stale.db')), dir, new Date('2026-01-01T00:00:00Z'));
		expect(readdirSync(dir)).toEqual(['studio-20260101-0000.db']);
	});
});

describe('Aufbewahrung', () => {
	it('sichert täglich und behält 7 tägliche + 4 wöchentliche', () => {
		const dir = join(tmp, 'days');
		const db = seed(join(tmp, 'days.db'));
		// 60 Tage ab Do 2026-01-01 03:00 UTC, Prüfung alle 6 Stunden wie der Timer (stündlich) oder häufige Neustarts
		const start = Date.UTC(2026, 0, 1, 3);
		for (let t = start; t < start + 60 * 24 * HOUR; t += 6 * HOUR) backupIfDue(db, dir, new Date(t));
		expect(names(dir)).toEqual([
			// täglich: die letzten 7 Tage (Mo 23.2. – So 1.3.)
			'studio-20260301-0300.db',
			'studio-20260228-0300.db',
			'studio-20260227-0300.db',
			'studio-20260226-0300.db',
			'studio-20260225-0300.db',
			'studio-20260224-0300.db',
			'studio-20260223-0300.db',
			// wöchentlich: die neueste der letzten 4 Wochen (Wochen beginnen montags); die jüngste Woche deckt der 1.3. ab
			'studio-20260222-0300.db',
			'studio-20260215-0300.db',
			'studio-20260208-0300.db'
		]);
	});

	it('behält je Tag die neueste und löscht nie die jüngste Sicherung', () => {
		const dir = join(tmp, 'keep');
		const db = seed(join(tmp, 'keep.db'));
		for (const at of ['2026-01-05T08:00:00Z', '2026-01-05T20:00:00Z', '2026-01-06T08:00:00Z']) backup(db, dir, new Date(at));
		expect(prune(dir, { daily: 7, weekly: 0 })).toEqual(['studio-20260105-0800.db']);
		expect(prune(dir, { daily: 0, weekly: 0 })).toEqual(['studio-20260105-2000.db']);
		expect(names(dir)).toEqual(['studio-20260106-0800.db']);
	});
});

describe('backupStatus', () => {
	it('zeigt letzte Sicherung, Größe und Pfad — und markiert ausbleibende oder fehlgeschlagene mit Ausweg', () => {
		const dir = join(tmp, 'status');
		const db = seed(join(tmp, 'status.db'));
		const now = new Date('2026-02-01T12:00:00Z');
		expect(backupStatus(dir, now)).toEqual({ dir, last: null, error: expect.stringMatching(/Keine Sicherung .* Schreibrechte in .* prüfen/) });

		backupIfDue(db, dir, now);
		const path = join(dir, 'studio-20260201-1200.db');
		expect(backupStatus(dir, now)).toEqual({ dir, last: { path, size: statSync(path).size, at: '2026-02-01T12:00:00.000Z' }, error: null });
		expect(backupStatus(dir, new Date(now.getTime() + 26 * HOUR)).error).toMatch(/Keine Sicherung aus den letzten 24 Stunden/);

		db.close(); // nächste Sicherung scheitert
		const later = new Date(now.getTime() + 25 * HOUR);
		backupIfDue(db, dir, later);
		expect(backupStatus(dir, later).error).toMatch(/fehlgeschlagen .* Speicherplatz und Schreibrechte prüfen/);
		backupIfDue(seed(join(tmp, 'status2.db')), dir, later);
		expect(backupStatus(dir, later).error).toBeNull();
	});
});

describe('restore (CLI)', () => {
	const data = join(tmp, 'data');
	const file = join(data, 'studio.db');
	const backups = join(data, 'backups');
	const restore = (...args: string[]) =>
		spawnSync(process.execPath, ['src/lib/server/restore.ts', ...args], { env: { ...process.env, STUDIO_DATA_DIR: data }, encoding: 'utf8' });
	/** Aktueller Stand der Server-DB (Verbindung wieder zu, wie bei gestopptem Server). */
	const current = () => {
		const db = openDb(file);
		const d = dump(db);
		db.close();
		return d;
	};

	mkdirSync(data, { recursive: true });
	const db = seed(file);
	const saved = backup(db, backups, new Date('2026-01-01T00:00:00Z'));
	const atBackup = dump(db);
	db.exec(`UPDATE projects SET name = 'geändert'; DELETE FROM notes; DELETE FROM secrets;`);
	const changed = dump(db);
	db.close();

	it.each([
		['dieser Prozess', process.pid],
		['PID 1 (gehört einem anderen Nutzer: EPERM heißt trotzdem „lebt")', 1]
	])('bricht ab, solange der Server läuft — %s', (_, pid) => {
		writeFileSync(join(data, 'studio.pid'), String(pid));
		const r = restore(saved);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/^restore: Studio läuft noch \(PID \d+\)\. Server stoppen und erneut ausführen .*\n$/);
		expect(current()).toEqual(changed);
		expect(names(backups)).toEqual(['studio-20260101-0000.db']); // auch nichts gesichert
	});

	it.each([
		['fehlt', () => join(tmp, 'gibt-es-nicht.db'), /nicht gefunden\. Sicherungen liegen unter /],
		['ist kein SQLite', () => (writeFileSync(join(tmp, 'kaputt.db'), 'kein SQLite '.repeat(500)), join(tmp, 'kaputt.db')), /keine intakte Studio-Sicherung .* andere Datei aus /],
		[
			'ist abgeschnitten',
			() => (writeFileSync(join(tmp, 'halb.db'), readFileSync(saved).subarray(0, statSync(saved).size / 2)), join(tmp, 'halb.db')),
			/keine intakte Studio-Sicherung/
		],
		[
			'widerspricht ihrem Index (lesbar, nur integrity_check merkt es)',
			() => {
				const bytes = readFileSync(saved);
				bytes.write('ALPHB', bytes.indexOf('ALPHA')); // Tabellenzeile ändern, UNIQUE-Index behält „ALPHA"
				writeFileSync(join(tmp, 'index.db'), bytes);
				return join(tmp, 'index.db');
			},
			/keine intakte Studio-Sicherung \(Integritätsprüfung meldet Fehler\)/
		],
		['ist keine Studio-DB', () => (new DatabaseSync(join(tmp, 'fremd.db')).exec('CREATE TABLE t (x)'), join(tmp, 'fremd.db')), /keine intakte Studio-Sicherung \(no such table/]
	])('Datei %s → Exit 1, eine Zeile mit Ausweg, DB unverändert', (_, source, message) => {
		rmSync(join(data, 'studio.pid'), { force: true }); // Server gestoppt
		const r = restore(source());
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(message);
		expect(r.stderr.trim().split('\n')).toHaveLength(1);
		expect(current()).toEqual(changed);
		expect(readdirSync(data).filter((f) => f.includes('.restore'))).toEqual([]);
	});

	it('ohne Argument → Exit 1 mit Aufruf', () => {
		const r = restore();
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/^restore: Aufruf: npm run restore -- <backup-datei>/);
	});

	it('stellt den gesicherten Stand identisch wieder her und sichert vorher die aktuelle DB', () => {
		// PID-Datei eines beendeten Prozesses (Absturz) blockiert nicht
		writeFileSync(join(data, 'studio.pid'), String(spawnSync(process.execPath, ['-e', '']).pid));
		const r = restore(saved);
		expect(r.stderr).toBe('');
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Aktuelle Datenbank gesichert: .*studio-\d{8}-\d{4}\.db\nWiederhergestellt aus /);
		expect(current()).toEqual(atBackup);

		const pre = new DatabaseSync(join(backups, names(backups)[0]));
		expect(dump(pre)).toEqual(changed); // der Stand vor dem Restore ist nicht verloren
		pre.close();
		expect(readdirSync(data).sort()).toEqual(['backups', 'studio.db', 'studio.pid']);
	});

	it('wendet ein liegengebliebenes WAL nicht auf die eingesetzte Sicherung an', () => {
		// Absturz mit ungeschriebenem WAL, danach studio.db von Hand beiseitegelegt (Ausweg bei defekter DB) — -wal/-shm bleiben liegen
		const crash = `const db = new (require('node:sqlite').DatabaseSync)(${JSON.stringify(file)});
			db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; UPDATE projects SET name = 'aus dem WAL'; INSERT INTO projects (key, name) VALUES ('WAL', 'x')");
			process.kill(process.pid, 'SIGKILL');`;
		spawnSync(process.execPath, ['-e', crash]);
		renameSync(file, `${file}.beiseite`);
		expect(readdirSync(data)).toContain('studio.db-wal');

		const r = restore(saved);
		expect(r.stderr).toBe('');
		expect(r.status).toBe(0);
		expect(current()).toEqual(atBackup);
	});
});
