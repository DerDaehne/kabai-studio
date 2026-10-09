// `npm run restore -- <backup-file>` replaces the database with a backup; runs directly under Node like
// reset-password. It holds the data directory's single-instance lock for its whole run, so it refuses to
// run next to a server, and a server started meanwhile refuses to start. The order protects the data:
// verify the source → back up the current database → replace it.
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backup } from './backup.ts';
import { assertKnownMigrations, backupDir, dataDir, lockDataDir, openDb } from './db.ts';
import { DomainError, formatError } from './domain/error.ts';

// Resolved relative to this module rather than the process cwd — restore may run from any directory.
const MIGRATIONS_DIR = new URL('../../../migrations', import.meta.url);

/** Throws if `file` isn't an intact Studio database, or contains migrations this code doesn't know. */
function check(file: string) {
	const db = new DatabaseSync(file);
	try {
		const result = db.prepare('PRAGMA integrity_check').all();
		if (result.length !== 1 || result[0].integrity_check !== 'ok')
			throw new Error('Integritätsprüfung meldet Fehler');
		const names = (
			db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]
		).map((r) => r.name); // not a Studio DB → "no such table"
		assertKnownMigrations(
			names,
			new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')))
		);
	} finally {
		db.close();
	}
}

/** A raw filesystem error (EACCES, ENOSPC, EISDIR, …) as a DomainError with a stable code and a way out; anything else passes through. */
function fsError(err: unknown): unknown {
	if (err instanceof DomainError) return err;
	const code = (err as { code?: unknown } | undefined)?.code;
	if (typeof code !== 'string' || !/^E[A-Z]+$/.test(code)) return err;
	const syscall = (err as { syscall?: unknown } | undefined)?.syscall;
	const from = (err as { path?: unknown } | undefined)?.path;
	const to = (err as { dest?: unknown } | undefined)?.dest;
	const detail = [syscall, from, to].filter((x): x is string => typeof x === 'string').join(', ');
	return new DomainError(
		'restore_fs_error',
		`Dateisystemfehler (${code}${detail ? `, ${detail}` : ''}) beim Kopieren der Quelle.`,
		'Schreibrechte und Speicherplatz im Datenverzeichnis prüfen; die Quelle darf kein Verzeichnis sein und muss lesbar sein.'
	);
}

function requireSourceArgument(): string {
	const src = process.argv[2];
	if (!src)
		throw new Error(
			`Aufruf: npm run restore -- <backup-datei> oder kabai-studio restore <backup-datei>. ` +
				`Sicherungen liegen unter ${backupDir()}.`
		);
	if (!existsSync(src))
		throw new Error(`${src} nicht gefunden. Sicherungen liegen unter ${backupDir()}.`);
	return src;
}

function lockDataDirOrThrow() {
	let locked: boolean;
	try {
		locked = lockDataDir();
	} catch {
		throw new DomainError(
			'restore_fs_error',
			`Das Datenverzeichnis ${resolve(dataDir())} lässt sich nicht sperren.`,
			'Schreibrechte und Speicherplatz im Datenverzeichnis prüfen; restore als Besitzer des Datenverzeichnisses ausführen.'
		);
	}
	if (!locked)
		throw new Error(
			`Studio läuft noch mit dem Datenverzeichnis ${resolve(dataDir())} (oder ein anderes restore). Server stoppen und erneut ausführen.`
		);
}

/** Verifies the copy that is about to be swapped in, so no -wal/-shm files appear next to the source. */
function copyAndVerify(src: string, copy: string) {
	copyFileSync(src, copy);
	try {
		check(copy);
	} catch (err) {
		if (err instanceof DomainError) throw err;
		throw new Error(
			`${src} ist keine intakte Studio-Sicherung (${(err as Error).message}). Eine andere Datei aus ${backupDir()} wählen.`
		);
	}
}

function backUpCurrentDb(file: string): string {
	try {
		const current = openDb(file); // throws already if the current file is no SQLite database anymore
		try {
			return backup(current, backupDir());
		} finally {
			current.close(); // last connection: SQLite checkpoints the WAL and deletes it
		}
	} catch (err) {
		const reason = (((err as Error).cause as Error | undefined) ?? (err as Error)).message;
		throw new Error(
			`Die aktuelle Datenbank ${file} lässt sich vorher nicht sichern (${reason}). Ist sie defekt: sie samt -wal/-shm von Hand beiseitelegen (umbenennen) und erneut ausführen; sonst Speicherplatz und Schreibrechte in ${backupDir()} prüfen.`
		);
	}
}

function swapIn(copy: string, file: string) {
	// A leftover WAL would otherwise be replayed onto the restored file and corrupt it.
	rmSync(`${file}-wal`, { force: true });
	rmSync(`${file}-shm`, { force: true });
	renameSync(copy, file);
}

const file = join(dataDir(), 'studio.db');
const tmp = `${file}.restore`;
let locked = false; // only once locked does the temporary copy belong to this run
try {
	const src = requireSourceArgument();
	lockDataDirOrThrow();
	locked = true;
	copyAndVerify(src, tmp);
	if (existsSync(file)) console.log(`Aktuelle Datenbank gesichert: ${backUpCurrentDb(file)}`);
	swapIn(tmp, file);
	console.log(
		`Wiederhergestellt aus ${src}. Studio jetzt starten; Secrets brauchen den passenden secret.key.`
	);
} catch (err) {
	if (locked) rmSync(tmp, { force: true });
	console.error(`restore: ${formatError(fsError(err))}`);
	process.exitCode = 1;
}
