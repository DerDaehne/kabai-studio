import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
	chmodSync,
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { backup, backupIfDue, backupStatus, listBackups, prune } from './backup';
import { migrate, openDb } from './db';

const tmp = mkdtempSync(join(tmpdir(), 'studio-backup-'));
// Zeitzone weit weg von UTC (UTC+14): Namen, Alter und Tagesgrenzen müssen trotzdem UTC sein — so fällt Lokalzeit auch in
// einer CI mit TZ=UTC auf. Gilt auch für die restore-Kindprozesse (erben die Umgebung).
const tz = process.env.TZ;
process.env.TZ = 'Pacific/Kiritimati';
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
	if (tz === undefined) delete process.env.TZ;
	else process.env.TZ = tz;
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const names = (dir: string) => listBackups(dir).map((b) => b.file);
const mode = (path: string) => statSync(path).mode & 0o777;

const DB_TS = JSON.stringify(resolve('src/lib/server/db.ts'));
/** Node-Kindprozess, der db.ts direkt lädt (ohne Vite, wie Server-Start bzw. CLI) und `code` ausführt. */
const nodeWithDb = (dir: string, code: string) =>
	[
		process.execPath,
		['--input-type=module', '-e', `import * as studio from ${DB_TS}; ${code}`],
		{ env: { ...process.env, STUDIO_DATA_DIR: dir }, encoding: 'utf8' }
	] as const;

/** Terminates hard like a crash (kill -9) — the kernel releases the lock. */
const stop = (child: ChildProcess) => new Promise((res) => child.once('exit', res).kill('SIGKILL'));

/** Holds the data-dir lock like a running server, until `stop`. */
async function holdLock(dir: string): Promise<ChildProcess> {
	const child = spawn(
		...nodeWithDb(dir, 'console.log(studio.lockDataDir()); setInterval(() => {}, 1e6);')
	);
	const out = await new Promise<string>((res) =>
		child.stdout!.once('data', (chunk) => res(String(chunk)))
	);
	if (out.trim() !== 'true') {
		await stop(child);
		throw new Error(`Could not hold the lock (${out.trim()}).`);
	}
	return child;
}

/** Schema + alle Zeilen aller Tabellen; Zeilen sortiert, weil VACUUM Rowids ohne INTEGER PRIMARY KEY neu vergeben darf. */
function dump(db: DatabaseSync) {
	const tables = db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all();
	const rows = tables
		.filter((t) => t.type === 'table')
		.map((t) => [
			t.name,
			db
				.prepare(`SELECT * FROM "${t.name}"`)
				.all()
				.map((r) => JSON.stringify(r))
				.sort()
		]);
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
	writeSync(
		fd,
		Buffer.alloc(Number(page_size), 0xff),
		0,
		Number(page_size),
		(Number(rootpage) - 1) * Number(page_size)
	);
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
		expect(copy.prepare('SELECT name FROM schema_migrations').all()).toEqual([
			{ name: '001_a.sql' }
		]);
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
		expect(new Date('2026-03-01T00:00:00Z').getTimezoneOffset()).toBe(-14 * 60); // Test läuft wirklich in UTC+14
		const at = new Date('2026-03-01T23:59:30+01:00'); // in UTC 22:59, in der Test-Zeitzone schon der 2.3. 12:59
		expect(backup(db, dir, at)).toBe(join(dir, 'studio-20260301-2259.db'));
		expect(backup(db, dir, at)).toBe(join(dir, 'studio-20260301-2259-2.db'));
		expect(backup(db, dir, at)).toBe(join(dir, 'studio-20260301-2259-3.db'));
		expect(names(dir)).toEqual([
			'studio-20260301-2259-3.db',
			'studio-20260301-2259-2.db',
			'studio-20260301-2259.db'
		]);
	});

	it('ein abgebrochener Lauf hinterlässt keine gültige Sicherung', () => {
		const dir = join(tmp, 'abort');
		const file = join(tmp, 'abort.db');
		seed(file).close();
		corruptTable(file, 'projects'); // VACUUM INTO bricht beim Lesen ab, nachdem es die Zieldatei schon angelegt hat
		expect(() => backup(openDb(file), dir)).toThrow(
			/Sicherung nach .* fehlgeschlagen .* Speicherplatz und Schreibrechte prüfen/
		);
		expect(readdirSync(dir)).toEqual([]); // weder gültige Sicherung noch Temp-Rest
	});

	it('ein Temp-Rest aus einem Absturz gilt nie als Sicherung und blockiert die nächste nicht', () => {
		const dir = join(tmp, 'stale');
		mkdirSync(dir, { mode: 0o700 });
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
		for (let t = start; t < start + 60 * 24 * HOUR; t += 6 * HOUR)
			backupIfDue(db, dir, new Date(t));
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

	it('eine lange Pause löscht nichts: gezählt werden Tage und Wochen mit Sicherung, nicht Kalendertage', () => {
		const dir = join(tmp, 'pause');
		const db = seed(join(tmp, 'pause.db'));
		const start = Date.UTC(2026, 0, 1, 3); // Do 1.1.
		for (let d = 0; d < 10; d++) backupIfDue(db, dir, new Date(start + d * DAY)); // bis Sa 10.1.
		backupIfDue(db, dir, new Date(start + 70 * DAY)); // 60 Tage Server aus, dann Do 12.3.
		expect(names(dir)).toEqual([
			'studio-20260312-0300.db',
			// die 6 jüngsten Tage davor (täglich) …
			'studio-20260110-0300.db',
			'studio-20260109-0300.db',
			'studio-20260108-0300.db',
			'studio-20260107-0300.db',
			'studio-20260106-0300.db',
			'studio-20260105-0300.db',
			// … und die neueste der Woche 1.–4.1. (wöchentlich)
			'studio-20260104-0300.db'
		]);
	});

	it('cleans a .tmp of a different minute and keeps the newest backup', () => {
		const dir = join(tmp, 'prune-tmp');
		mkdirSync(dir, { mode: 0o700 });
		writeFileSync(join(dir, 'studio-20260101-0000.db.tmp'), 'halb geschrieben'); // aborted run at 00:00
		backup(seed(join(tmp, 'prune-tmp.db')), dir, new Date('2026-01-01T00:05:00Z')); // backup at 00:05
		expect(readdirSync(dir).sort()).toEqual([
			'studio-20260101-0000.db.tmp',
			'studio-20260101-0005.db'
		]);
		expect(prune(dir)).toEqual([]);
		expect(readdirSync(dir).sort()).toEqual(['studio-20260101-0005.db']);
	});

	it('behält je Tag die neueste und löscht nie die jüngste Sicherung', () => {
		const dir = join(tmp, 'keep');
		const db = seed(join(tmp, 'keep.db'));
		for (const at of ['2026-01-05T08:00:00Z', '2026-01-05T20:00:00Z', '2026-01-06T08:00:00Z'])
			backup(db, dir, new Date(at));
		expect(prune(dir, { daily: 7, weekly: 0 })).toEqual(['studio-20260105-0800.db']);
		expect(prune(dir, { daily: 0, weekly: 0 })).toEqual(['studio-20260105-2000.db']);
		expect(names(dir)).toEqual(['studio-20260106-0800.db']);
	});
});

describe('freshness ignores a backup in the future', () => {
	it('a backup in the future does not block the daily cadence - one new backup, then back to 24 hours', () => {
		const dir = join(tmp, 'future-cadence');
		const db = seed(join(tmp, 'future-cadence.db'));
		const now = new Date('2026-03-01T12:00:00Z');
		backup(db, dir, new Date(now.getTime() + 5 * DAY)); // newest backup is five days ahead
		backupIfDue(db, dir, now); // freshness ignores the future backup, so this still runs
		expect(names(dir)).toHaveLength(2);
		backupIfDue(db, dir, new Date(now.getTime() + 2 * HOUR)); // within 24 h: no second one
		expect(names(dir)).toHaveLength(2);
		backupIfDue(db, dir, new Date(now.getTime() + DAY)); // next day: one more
		expect(names(dir)).toHaveLength(3);
	});

	it('warns about a backup in the future and does not delete it', () => {
		const dir = join(tmp, 'future-status');
		const db = seed(join(tmp, 'future-status.db'));
		const now = new Date('2026-03-01T12:00:00Z');
		backup(db, dir, new Date(now.getTime() + 5 * DAY));
		const status = backupStatus(dir, now);
		expect(status.error).toMatch(/in der Zukunft.*Uhr prüfen/);
		expect(status.last).not.toBeNull();
		expect(names(dir)).toHaveLength(1);
	});

	it('keeps the present backup and every future-dated one when a future backup shares the day', () => {
		const dir = join(tmp, 'repro-a');
		const db = seed(join(tmp, 'repro-a.db'));
		const now = new Date('2026-03-01T12:00:00Z');
		const future = 'studio-20260301-1500.db';
		backup(db, dir, new Date(now.getTime() + 3 * HOUR)); // future backup on the same UTC day
		backupIfDue(db, dir, now); // creates the present backup
		expect(names(dir)).toContain('studio-20260301-1200.db');
		expect(names(dir)).toContain(future);
		backupIfDue(db, dir, new Date(now.getTime() + HOUR)); // within 24 h: no second one
		expect(names(dir)).toHaveLength(2);
		expect(names(dir)).toContain('studio-20260301-1200.db');
		expect(names(dir)).toContain(future);
	});

	it('does not let future-dated backups take retention slots', () => {
		const dir = join(tmp, 'repro-b');
		const db = seed(join(tmp, 'repro-b.db'));
		const now = new Date('2026-03-01T12:00:00Z');
		for (let d = 30; d < 60; d++) backup(db, dir, new Date(now.getTime() + d * DAY)); // 30 future-dated backups
		const future = names(dir);
		expect(future).toHaveLength(30);
		for (let h = 0; h < 3; h++) backupIfDue(db, dir, new Date(now.getTime() + h * HOUR)); // 3 hourly ticks
		expect(names(dir)).toContain('studio-20260301-1200.db'); // present backup survives
		expect(names(dir)).toEqual(expect.arrayContaining(future)); // no future-dated backup deleted
		expect(names(dir).filter((n) => !future.includes(n))).toEqual(['studio-20260301-1200.db']);
	});
});

describe('Rechte', () => {
	it('Sicherungen 0600 in einem Verzeichnis mit 0700', () => {
		const dir = join(tmp, 'rechte', 'backups');
		const file = backup(seed(join(tmp, 'rechte.db')), dir);
		expect(mode(join(tmp, 'rechte'))).toBe(0o700);
		expect(mode(dir)).toBe(0o700);
		expect(mode(file)).toBe(0o600);
	});

	it('ein vorhandenes, für andere offenes Verzeichnis bleibt, wie es ist — mit Warnung und Ausweg', () => {
		const dir = join(tmp, 'offen');
		mkdirSync(dir);
		chmodSync(dir, 0o755);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const file = backup(seed(join(tmp, 'offen.db')), dir);
			expect(warn.mock.calls).toEqual([
				[`Warnung: ${dir} ist für andere Nutzer zugänglich — „chmod 700 ${dir}“ schränkt das ein.`]
			]);
			expect(mode(file)).toBe(0o600);
		} finally {
			warn.mockRestore();
		}
		expect(mode(dir)).toBe(0o755);
	});
});

describe('Einzelinstanz', () => {
	it('eine zweite Instanz bricht vor jeder DB-Aktion ab und lässt die Sperre der ersten stehen; nach kill -9 ist sie frei', async () => {
		const dir = join(tmp, 'instanz'); // existiert noch nicht
		const first = await holdLock(dir); // wie ein laufender Server
		let saved: string;
		try {
			expect(mode(dir)).toBe(0o700); // von Studio angelegt → nur für den eigenen Nutzer

			// zweiter Server-Start auf demselben Verzeichnis (versehentlich doppelt gestartet)
			const second = spawnSync(...nodeWithDb(dir, 'studio.db();'));
			expect(second.status).not.toBe(0);
			expect(second.stderr).toMatch(
				/Studio läuft bereits mit dem Datenverzeichnis .*instanz \(zweiter Server oder laufendes restore\)\. Die laufende Instanz verwenden oder beenden/
			);
			expect(readdirSync(dir)).not.toContain('studio.db'); // nichts geöffnet, migriert oder gesichert

			// die erste Instanz ist weiter geschützt: restore erkennt sie (Szenario aus dem Review)
			saved = backup(seed(join(tmp, 'instanz-quelle.db')), join(tmp, 'instanz-backups'));
			const blocked = spawnSync(process.execPath, ['src/lib/server/restore.ts', saved], {
				env: { ...process.env, STUDIO_DATA_DIR: dir },
				encoding: 'utf8'
			});
			expect(blocked.status).toBe(1);
			expect(blocked.stderr).toMatch(
				/^restore: Studio läuft noch mit dem Datenverzeichnis .* Server stoppen und erneut ausführen\.\n$/
			);
			expect(readdirSync(dir)).not.toContain('studio.db');
		} finally {
			await stop(first); // stop it on the failing path too, so no child process stays open
		}

		const ok = spawnSync(process.execPath, ['src/lib/server/restore.ts', saved], {
			env: { ...process.env, STUDIO_DATA_DIR: dir },
			encoding: 'utf8'
		});
		expect(ok.stderr).toBe('');
		expect(ok.status).toBe(0);
	});
});

describe('backupStatus', () => {
	it('zeigt letzte Sicherung, Größe und Pfad — und markiert ausbleibende oder fehlgeschlagene mit Ausweg', () => {
		const dir = join(tmp, 'status');
		const db = seed(join(tmp, 'status.db'));
		const now = new Date('2026-02-01T12:00:00Z');
		expect(backupStatus(dir, now)).toEqual({
			dir,
			last: null,
			error: expect.stringMatching(/Keine Sicherung .* Schreibrechte in .* prüfen/)
		});

		backupIfDue(db, dir, now);
		const path = join(dir, 'studio-20260201-1200.db');
		expect(backupStatus(dir, now)).toEqual({
			dir,
			last: { path, size: statSync(path).size, at: '2026-02-01T12:00:00.000Z' },
			error: null
		});
		expect(backupStatus(dir, new Date(now.getTime() + 26 * HOUR)).error).toMatch(
			/Keine Sicherung aus den letzten 24 Stunden/
		);

		db.close(); // nächste Sicherung scheitert
		const later = new Date(now.getTime() + 25 * HOUR);
		backupIfDue(db, dir, later);
		expect(backupStatus(dir, later).error).toMatch(
			/fehlgeschlagen .* Speicherplatz und Schreibrechte prüfen/
		);
		backupIfDue(seed(join(tmp, 'status2.db')), dir, later);
		expect(backupStatus(dir, later).error).toBeNull();
	});
});

describe('restore (CLI)', () => {
	const data = join(tmp, 'data');
	const file = join(data, 'studio.db');
	const backups = join(data, 'backups');
	const restore = (...args: string[]) =>
		spawnSync(process.execPath, ['src/lib/server/restore.ts', ...args], {
			env: { ...process.env, STUDIO_DATA_DIR: data },
			encoding: 'utf8'
		});
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

	it('bricht ab, solange der Server läuft — ohne etwas zu verändern oder zu sichern', async () => {
		const server = await holdLock(data);
		writeFileSync(`${file}.restore`, 'Temp-Kopie eines laufenden restore'); // gehört dem Sperrinhaber
		try {
			const r = restore(saved);
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(
				/^restore: Studio läuft noch mit dem Datenverzeichnis .*data \(oder ein anderes restore\)\. Server stoppen und erneut ausführen\.\n$/
			);
			expect(current()).toEqual(changed);
			expect(names(backups)).toEqual(['studio-20260101-0000.db']);
			expect(readFileSync(`${file}.restore`, 'utf8')).toBe('Temp-Kopie eines laufenden restore');
		} finally {
			await stop(server);
			rmSync(`${file}.restore`);
		}
	});

	it('aktuelle DB defekt → Exit 1, benennt die aktuelle DB und den Ausweg; nichts verändert', () => {
		const dir = join(tmp, 'aktuell-defekt');
		mkdirSync(dir, { mode: 0o700 });
		const garbage = 'kein SQLite '.repeat(500);
		writeFileSync(join(dir, 'studio.db'), garbage);
		const r = spawnSync(process.execPath, ['src/lib/server/restore.ts', saved], {
			env: { ...process.env, STUDIO_DATA_DIR: dir },
			encoding: 'utf8'
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			/^restore: Die aktuelle Datenbank .*studio\.db lässt sich vorher nicht sichern \(file is not a database\)\. Ist sie defekt: sie samt -wal\/-shm von Hand beiseitelegen \(umbenennen\) und erneut ausführen; sonst Speicherplatz und Schreibrechte in .* prüfen\.\n$/
		);
		expect(readFileSync(join(dir, 'studio.db'), 'utf8')).toBe(garbage);
		expect(readdirSync(dir).filter((f) => f.startsWith('studio.db'))).toEqual(['studio.db']); // keine Kopie, kein WAL
	});

	it.each([
		['fehlt', () => join(tmp, 'gibt-es-nicht.db'), /nicht gefunden\. Sicherungen liegen unter /],
		[
			'ist kein SQLite',
			() => (
				writeFileSync(join(tmp, 'kaputt.db'), 'kein SQLite '.repeat(500)),
				join(tmp, 'kaputt.db')
			),
			/keine intakte Studio-Sicherung .* andere Datei aus /
		],
		[
			'ist abgeschnitten',
			() => (
				writeFileSync(
					join(tmp, 'halb.db'),
					readFileSync(saved).subarray(0, statSync(saved).size / 2)
				),
				join(tmp, 'halb.db')
			),
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
		[
			'ist keine Studio-DB',
			() => (
				new DatabaseSync(join(tmp, 'fremd.db')).exec('CREATE TABLE t (x)'),
				join(tmp, 'fremd.db')
			),
			/keine intakte Studio-Sicherung \(no such table/
		],
		[
			'contains an unknown migration (DB newer than code)',
			() => {
				const db = seed(join(tmp, 'newer.db'));
				db.exec("INSERT INTO schema_migrations (name) VALUES ('999_future.sql')");
				const saved = backup(db, join(tmp, 'newer-backups'));
				db.close();
				return saved;
			},
			/^restore: \[db_newer_than_code\] Datenbank enthält unbekannte Migrationen, die dieser Code nicht kennt: 999_future\.sql\. Eine neuere Studio-Version installieren oder eine ältere Sicherung wiederherstellen\.\n$/
		]
	])('Datei %s → Exit 1, eine Zeile mit Ausweg, DB unverändert', (_, source, message) => {
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
		const r = restore(saved);
		expect(r.stderr).toBe('');
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/Aktuelle Datenbank gesichert: .*studio-\d{8}-\d{4}\.db\nWiederhergestellt aus /
		);
		expect(current()).toEqual(atBackup);

		const pre = new DatabaseSync(join(backups, names(backups)[0]));
		expect(dump(pre)).toEqual(changed); // der Stand vor dem Restore ist nicht verloren
		pre.close();
		expect(readdirSync(data).filter((f) => f.startsWith('studio.db'))).toEqual(['studio.db']); // keine Temp-Kopie, kein altes WAL
		expect(mode(file)).toBe(0o600); // eingesetzt aus einer 0600-Sicherung
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

describe('restore run from a directory other than the package root', () => {
	const cwdTmp = mkdtempSync(join(tmp, 'restore-cwd-'));
	const data = join(cwdTmp, 'data');
	mkdirSync(data);
	const source = openDb(join(cwdTmp, 'source.db'));
	migrate(
		source,
		import.meta.glob<string>('/migrations/*.sql', { query: '?raw', import: 'default', eager: true })
	);
	const older = backup(source, join(cwdTmp, 'older'));
	source.exec("INSERT INTO schema_migrations (name) VALUES ('999_future.sql')");
	const newer = backup(source, join(cwdTmp, 'newer'));
	source.close();
	const restoreFrom = (cwd: string, file: string) =>
		spawnSync(process.execPath, [resolve('src/lib/server/restore.ts'), file], {
			cwd,
			env: { ...process.env, STUDIO_DATA_DIR: data },
			encoding: 'utf8'
		});

	it('still rejects a backup from a newer version with db_newer_than_code', () => {
		const r = restoreFrom(cwdTmp, newer);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/^restore: \[db_newer_than_code\] .*999_future\.sql/);
	});

	it('restores a valid backup', () => {
		const r = restoreFrom(cwdTmp, older);
		expect(r.stderr).toBe('');
		expect(r.status).toBe(0);
	});
});

describe('restore (fs error)', () => {
	it('reports a raw fs error (EISDIR) with a stable code, the source path, a hint, one line and a non-zero exit', () => {
		const data = join(tmp, 'fs-error');
		mkdirSync(data, { mode: 0o700 });
		const source = join(tmp, 'source-is-a-directory');
		mkdirSync(source);
		const r = spawnSync(process.execPath, ['src/lib/server/restore.ts', source], {
			env: { ...process.env, STUDIO_DATA_DIR: data },
			encoding: 'utf8'
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			/^restore: \[restore_fs_error\] Dateisystemfehler \(EISDIR, copyfile, .*source-is-a-directory, .*studio\.db\.restore\) beim Kopieren der Quelle\./
		);
		expect(r.stderr).toMatch(/die Quelle darf kein Verzeichnis sein und muss lesbar sein\./);
		expect(r.stderr.trim().split('\n')).toHaveLength(1);
		expect(readdirSync(data).filter((f) => f.includes('.restore'))).toEqual([]);
	});

	it('reports an unreadable source (EACCES) with the source path and a hint', () => {
		if (process.getuid?.() === 0) return; // root ignores file permissions
		const data = join(tmp, 'fs-error-acc');
		mkdirSync(data, { mode: 0o700 });
		const source = join(tmp, 'unreadable-source.db');
		const db = openDb(source);
		db.close();
		try {
			chmodSync(source, 0o000);
			const r = spawnSync(process.execPath, ['src/lib/server/restore.ts', source], {
				env: { ...process.env, STUDIO_DATA_DIR: data },
				encoding: 'utf8'
			});
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(
				/\[restore_fs_error\] Dateisystemfehler \(EACCES, copyfile, .*unreadable-source\.db/
			);
			expect(r.stderr).toMatch(/muss lesbar sein\./);
		} finally {
			chmodSync(source, 0o600);
		}
	});

	it('wraps a non-writable data dir (0500) as restore_fs_error naming the directory', () => {
		if (process.getuid?.() === 0) return; // root ignores directory permissions
		const data = join(tmp, 'data-0500');
		mkdirSync(data, { mode: 0o500 });
		const source = join(tmp, 'data-0500-source.db');
		const db = openDb(source);
		db.close();
		const r = spawnSync(process.execPath, ['src/lib/server/restore.ts', source], {
			env: { ...process.env, STUDIO_DATA_DIR: data },
			encoding: 'utf8'
		});
		expect(r.status).toBe(1);
		expect(r.stderr.trim().split('\n')).toHaveLength(1);
		expect(r.stderr).toMatch(/^restore: \[restore_fs_error\] /);
		expect(r.stderr).toContain(data);
	});
});
