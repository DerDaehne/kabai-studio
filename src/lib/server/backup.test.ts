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
// A time zone far from UTC (UTC+14): names, ages and day boundaries must still be UTC, so local time shows up even
// in a CI running with TZ=UTC. Applies to the restore child processes too (they inherit the environment).
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
/** A Node child process that loads db.ts directly (without Vite, like the server start or the CLI) and runs `code`. */
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

/** Schema plus all rows of all tables; rows sorted because VACUUM may reassign rowids without INTEGER PRIMARY KEY. */
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

/** A small Studio DB with data in several tables (including FTS5 and BLOBs). */
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

/** Overwrites a table's root page with garbage (DB file without an open WAL). */
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

describe('backup before migration', () => {
	const m1 = { '/m/001_a.sql': 'CREATE TABLE a (x INTEGER) STRICT;' };
	const m2 = { ...m1, '/m/002_b.sql': 'CREATE TABLE b (x INTEGER) STRICT;' };

	it('backs up the previous state only when migrations are pending and the DB is not empty', () => {
		const dir = join(tmp, 'pre');
		const db = openDb(join(tmp, 'pre.db'));
		const hook = () => void backup(db, dir);
		migrate(db, m1, hook); // empty DB: nothing to back up
		expect(names(dir)).toEqual([]);
		db.exec('INSERT INTO a VALUES (42)');
		migrate(db, m1, hook); // nothing pending
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

	it('migrates nothing when the backup fails', () => {
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

describe('backup', () => {
	it('names backups by UTC minute and keeps names unique within the same minute', () => {
		const dir = join(tmp, 'names');
		const db = seed(join(tmp, 'names.db'));
		expect(new Date('2026-03-01T00:00:00Z').getTimezoneOffset()).toBe(-14 * 60); // the test really runs in UTC+14
		const at = new Date('2026-03-01T23:59:30+01:00'); // 22:59 in UTC, already 12:59 on 2 March in the test time zone
		expect(backup(db, dir, at)).toBe(join(dir, 'studio-20260301-2259.db'));
		expect(backup(db, dir, at)).toBe(join(dir, 'studio-20260301-2259-2.db'));
		expect(backup(db, dir, at)).toBe(join(dir, 'studio-20260301-2259-3.db'));
		expect(names(dir)).toEqual([
			'studio-20260301-2259-3.db',
			'studio-20260301-2259-2.db',
			'studio-20260301-2259.db'
		]);
	});

	it('leaves no valid backup behind after an aborted run', () => {
		const dir = join(tmp, 'abort');
		const file = join(tmp, 'abort.db');
		seed(file).close();
		corruptTable(file, 'projects'); // VACUUM INTO fails while reading, after it has already created the target file
		expect(() => backup(openDb(file), dir)).toThrow(
			/Sicherung nach .* fehlgeschlagen .* Speicherplatz und Schreibrechte prüfen/
		);
		expect(readdirSync(dir)).toEqual([]); // neither a valid backup nor a temp leftover
	});

	it('never counts a temp leftover from a crash as a backup, and it does not block the next one', () => {
		const dir = join(tmp, 'stale');
		mkdirSync(dir, { mode: 0o700 });
		writeFileSync(join(dir, 'studio-20260101-0000.db.tmp'), 'halb geschrieben');
		expect(listBackups(dir)).toEqual([]);
		expect(backupStatus(dir).last).toBeNull();
		backup(seed(join(tmp, 'stale.db')), dir, new Date('2026-01-01T00:00:00Z'));
		expect(readdirSync(dir)).toEqual(['studio-20260101-0000.db']);
	});
});

describe('retention', () => {
	it('backs up daily and keeps 7 daily plus 4 weekly backups', () => {
		const dir = join(tmp, 'days');
		const db = seed(join(tmp, 'days.db'));
		// 60 days from Thu 2026-01-01 03:00 UTC, checked every 6 hours like the timer (hourly) or frequent restarts
		const start = Date.UTC(2026, 0, 1, 3);
		for (let t = start; t < start + 60 * 24 * HOUR; t += 6 * HOUR)
			backupIfDue(db, dir, new Date(t));
		expect(names(dir)).toEqual([
			// daily: the last 7 days (Mon 23 Feb – Sun 1 Mar)
			'studio-20260301-0300.db',
			'studio-20260228-0300.db',
			'studio-20260227-0300.db',
			'studio-20260226-0300.db',
			'studio-20260225-0300.db',
			'studio-20260224-0300.db',
			'studio-20260223-0300.db',
			// weekly: the newest of each of the last 4 weeks (weeks start on Monday); 1 Mar covers the latest week
			'studio-20260222-0300.db',
			'studio-20260215-0300.db',
			'studio-20260208-0300.db'
		]);
	});

	it('deletes nothing after a long pause, because it counts days and weeks with a backup, not calendar days', () => {
		const dir = join(tmp, 'pause');
		const db = seed(join(tmp, 'pause.db'));
		const start = Date.UTC(2026, 0, 1, 3); // Thu 1 Jan
		for (let d = 0; d < 10; d++) backupIfDue(db, dir, new Date(start + d * DAY)); // until Sat 10 Jan
		backupIfDue(db, dir, new Date(start + 70 * DAY)); // server off for 60 days, then Thu 12 Mar
		expect(names(dir)).toEqual([
			'studio-20260312-0300.db',
			// the 6 latest days before that (daily) …
			'studio-20260110-0300.db',
			'studio-20260109-0300.db',
			'studio-20260108-0300.db',
			'studio-20260107-0300.db',
			'studio-20260106-0300.db',
			'studio-20260105-0300.db',
			// … and the newest of the week 1–4 Jan (weekly)
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

	it('keeps the newest backup per day and never deletes the latest one', () => {
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

describe('permissions', () => {
	it('writes backups with 0600 into a directory with 0700', () => {
		const dir = join(tmp, 'rechte', 'backups');
		const file = backup(seed(join(tmp, 'rechte.db')), dir);
		expect(mode(join(tmp, 'rechte'))).toBe(0o700);
		expect(mode(dir)).toBe(0o700);
		expect(mode(file)).toBe(0o600);
	});

	it('leaves an existing directory open to others as it is, with a warning and a way out', () => {
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

describe('single instance', () => {
	it('aborts a second instance before any DB access and keeps the first one locked; after kill -9 the lock is free', async () => {
		const dir = join(tmp, 'instanz'); // does not exist yet
		const first = await holdLock(dir); // like a running server
		let saved: string;
		try {
			expect(mode(dir)).toBe(0o700); // created by Studio → owner only

			// a second server start on the same directory (started twice by accident)
			const second = spawnSync(...nodeWithDb(dir, 'studio.db();'));
			expect(second.status).not.toBe(0);
			expect(second.stderr).toMatch(
				/Studio läuft bereits mit dem Datenverzeichnis .*instanz \(zweiter Server oder laufendes restore\)\. Die laufende Instanz verwenden oder beenden/
			);
			expect(readdirSync(dir)).not.toContain('studio.db'); // nothing opened, migrated or backed up

			// the first instance stays protected: restore detects it
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
	it('shows the newest backup with size and path, and flags missing or failed backups with a way out', () => {
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

		db.close(); // the next backup fails
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
	/** Current state of the server DB (connection closed again, as with a stopped server). */
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

	it('aborts while the server runs, without changing or backing up anything', async () => {
		const server = await holdLock(data);
		writeFileSync(`${file}.restore`, 'Temp-Kopie eines laufenden restore'); // belongs to the lock holder
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

	it('exits 1 on a broken current DB, naming it and the way out, and changes nothing', () => {
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
		expect(readdirSync(dir).filter((f) => f.startsWith('studio.db'))).toEqual(['studio.db']); // no copy, no WAL
	});

	it.each([
		[
			'is missing',
			() => join(tmp, 'gibt-es-nicht.db'),
			/nicht gefunden\. Sicherungen liegen unter /
		],
		[
			'is not SQLite',
			() => (
				writeFileSync(join(tmp, 'kaputt.db'), 'kein SQLite '.repeat(500)),
				join(tmp, 'kaputt.db')
			),
			/keine intakte Studio-Sicherung .* andere Datei aus /
		],
		[
			'is truncated',
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
			'contradicts its index (readable, only integrity_check notices)',
			() => {
				const bytes = readFileSync(saved);
				bytes.write('ALPHB', bytes.indexOf('ALPHA')); // change the table row; the UNIQUE index keeps "ALPHA"
				writeFileSync(join(tmp, 'index.db'), bytes);
				return join(tmp, 'index.db');
			},
			/keine intakte Studio-Sicherung \(Integritätsprüfung meldet Fehler\)/
		],
		[
			'is no Studio DB',
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
	])(
		'exits 1 with one line and a way out when the file %s, leaving the DB unchanged',
		(_, source, message) => {
			const r = restore(source());
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(message);
			expect(r.stderr.trim().split('\n')).toHaveLength(1);
			expect(current()).toEqual(changed);
			expect(readdirSync(data).filter((f) => f.includes('.restore'))).toEqual([]);
		}
	);

	it('exits 1 with the usage when called without an argument', () => {
		const r = restore();
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/^restore: Aufruf: npm run restore -- <backup-datei>/);
	});

	it('restores the saved state identically and backs up the current DB first', () => {
		const r = restore(saved);
		expect(r.stderr).toBe('');
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/Aktuelle Datenbank gesichert: .*studio-\d{8}-\d{4}\.db\nWiederhergestellt aus /
		);
		expect(current()).toEqual(atBackup);

		const pre = new DatabaseSync(join(backups, names(backups)[0]));
		expect(dump(pre)).toEqual(changed); // the state before the restore is not lost
		pre.close();
		expect(readdirSync(data).filter((f) => f.startsWith('studio.db'))).toEqual(['studio.db']); // no temp copy, no old WAL
		expect(mode(file)).toBe(0o600); // swapped in from a 0600 backup
	});

	it('does not replay a leftover WAL onto the restored backup', () => {
		// crash with an unwritten WAL, then studio.db moved aside by hand (the way out for a broken DB) — -wal/-shm stay behind
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
