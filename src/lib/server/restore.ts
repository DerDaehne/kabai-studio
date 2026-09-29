// Wiederherstellung ohne UI: `npm run restore -- <backup-datei>` ersetzt die DB durch eine Sicherung (#808).
// Nur bei gestopptem Server. Reihenfolge schützt die Daten: Quelle prüfen → aktuelle DB sichern → ersetzen.
// Läuft direkt mit Node (Type-Stripping, kein Build), wie reset-password.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backup } from './backup.ts';
import { backupDir, dataDir, openDb, pidFile } from './db.ts';

/** PID des laufenden Servers laut PID-Datei, sonst null (keine Datei oder Prozess beendet, etwa nach einem Absturz). */
function serverPid(): number | null {
	const pid = existsSync(pidFile()) ? Number(readFileSync(pidFile(), 'utf8')) : 0;
	if (!pid) return null;
	try {
		process.kill(pid, 0); // Signal 0 prüft nur, ob der Prozess existiert
		return pid;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null; // EPERM: lebt, gehört nur einem anderen Nutzer
	}
}

/** Wirft, wenn `file` keine intakte Studio-Datenbank ist. */
function check(file: string) {
	const db = new DatabaseSync(file);
	try {
		const result = db.prepare('PRAGMA integrity_check').all();
		if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error('Integritätsprüfung meldet Fehler');
		db.prepare('SELECT 1 FROM schema_migrations LIMIT 1').get(); // keine Studio-DB → „no such table"
	} finally {
		db.close();
	}
}

const file = join(dataDir(), 'studio.db');
const tmp = `${file}.restore`;
try {
	const src = process.argv[2];
	if (!src) throw new Error(`Aufruf: npm run restore -- <backup-datei>. Sicherungen liegen unter ${backupDir()}.`);
	if (!existsSync(src)) throw new Error(`${src} nicht gefunden. Sicherungen liegen unter ${backupDir()}.`);
	const pid = serverPid();
	if (pid)
		throw new Error(
			`Studio läuft noch (PID ${pid}). Server stoppen und erneut ausführen — läuft er sicher nicht mehr, ${pidFile()} löschen.`
		);

	// Geprüft wird die Kopie, die gleich eingesetzt wird — so entstehen auch keine -wal/-shm-Dateien neben der Quelle.
	mkdirSync(dataDir(), { recursive: true });
	copyFileSync(src, tmp);
	try {
		check(tmp);
	} catch (err) {
		throw new Error(`${src} ist keine intakte Studio-Sicherung (${(err as Error).message}). Eine andere Datei aus ${backupDir()} wählen.`);
	}

	if (existsSync(file)) {
		const current = openDb(file);
		let saved: string;
		try {
			saved = backup(current, backupDir());
		} catch (err) {
			throw new Error(
				`Aktuelle Datenbank lässt sich nicht sichern (${(err as Error).message}). Ist sie defekt: ${file} samt -wal/-shm von Hand beiseitelegen und erneut ausführen.`
			);
		} finally {
			current.close(); // letzte Verbindung: SQLite schreibt das WAL zurück und löscht es
		}
		console.log(`Aktuelle Datenbank gesichert: ${saved}`);
	}
	// Ein altes WAL würde sonst auf die eingesetzte Datei angewendet und sie zerstören.
	rmSync(`${file}-wal`, { force: true });
	rmSync(`${file}-shm`, { force: true });
	renameSync(tmp, file);
	console.log(`Wiederhergestellt aus ${src}. Studio jetzt starten; Secrets brauchen den passenden secret.key.`);
} catch (err) {
	rmSync(tmp, { force: true });
	console.error(`restore: ${(err as Error).message}`);
	process.exitCode = 1;
}
