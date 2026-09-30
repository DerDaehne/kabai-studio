// Wiederherstellung ohne UI: `npm run restore -- <backup-datei>` ersetzt die DB durch eine Sicherung (#808).
// Nur bei gestopptem Server: restore hält die Einzelinstanz-Sperre des Datenverzeichnisses für seine ganze Laufzeit — läuft ein
// Server, bricht restore ab; startet einer währenddessen, bricht der ab. Reihenfolge schützt die Daten: Quelle prüfen →
// aktuelle DB sichern → ersetzen. Läuft direkt mit Node (Type-Stripping, kein Build), wie reset-password.
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backup } from './backup.ts';
import { assertKnownMigrations, backupDir, dataDir, lockDataDir, openDb } from './db.ts';
import { DomainError, formatError } from './domain/error.ts';

// Migration filenames this code knows, resolved relative to this module rather than the process cwd — restore may
// run with any working directory.
const MIGRATIONS_DIR = new URL('../../../migrations', import.meta.url);

/** Throws if `file` isn't an intact Studio database, or contains migrations this code doesn't know. */
function check(file: string) {
	const db = new DatabaseSync(file);
	try {
		const result = db.prepare('PRAGMA integrity_check').all();
		if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error('Integritätsprüfung meldet Fehler');
		const names = (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name); // not a Studio DB → "no such table"
		assertKnownMigrations(names, new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))));
	} finally {
		db.close();
	}
}

const file = join(dataDir(), 'studio.db');
const tmp = `${file}.restore`;
let locked = false; // erst mit der Sperre gehört die Temp-Kopie diesem Lauf
try {
	const src = process.argv[2];
	if (!src) throw new Error(`Aufruf: npm run restore -- <backup-datei>. Sicherungen liegen unter ${backupDir()}.`);
	if (!existsSync(src)) throw new Error(`${src} nicht gefunden. Sicherungen liegen unter ${backupDir()}.`);
	locked = lockDataDir();
	if (!locked)
		throw new Error(`Studio läuft noch mit dem Datenverzeichnis ${resolve(dataDir())} (oder ein anderes restore). Server stoppen und erneut ausführen.`);

	// Geprüft wird die Kopie, die gleich eingesetzt wird — so entstehen auch keine -wal/-shm-Dateien neben der Quelle.
	copyFileSync(src, tmp);
	try {
		check(tmp);
	} catch (err) {
		if (err instanceof DomainError) throw err;
		throw new Error(`${src} ist keine intakte Studio-Sicherung (${(err as Error).message}). Eine andere Datei aus ${backupDir()} wählen.`);
	}

	if (existsSync(file)) {
		let saved: string;
		try {
			const current = openDb(file); // wirft schon hier, wenn die aktuelle Datei keine SQLite-DB mehr ist
			try {
				saved = backup(current, backupDir());
			} finally {
				current.close(); // letzte Verbindung: SQLite schreibt das WAL zurück und löscht es
			}
		} catch (err) {
			const reason = (((err as Error).cause as Error | undefined) ?? (err as Error)).message;
			throw new Error(
				`Die aktuelle Datenbank ${file} lässt sich vorher nicht sichern (${reason}). Ist sie defekt: sie samt -wal/-shm von Hand beiseitelegen (umbenennen) und erneut ausführen; sonst Speicherplatz und Schreibrechte in ${backupDir()} prüfen.`
			);
		}
		console.log(`Aktuelle Datenbank gesichert: ${saved}`);
	}
	// Ein altes WAL würde sonst auf die eingesetzte Datei angewendet und sie zerstören.
	rmSync(`${file}-wal`, { force: true });
	rmSync(`${file}-shm`, { force: true });
	renameSync(tmp, file);
	console.log(`Wiederhergestellt aus ${src}. Studio jetzt starten; Secrets brauchen den passenden secret.key.`);
} catch (err) {
	if (locked) rmSync(tmp, { force: true });
	console.error(`restore: ${formatError(err)}`);
	process.exitCode = 1;
}
