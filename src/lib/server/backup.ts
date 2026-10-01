// Sicherungen der SQLite-DB (#808): `VACUUM INTO` nach `<datenverzeichnis>/backups/studio-YYYYMMDD-HHMM[-N].db` (UTC).
// Nur node:-Importe: die CLI restore lädt diese Datei direkt mit Node, ohne Vite.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// ponytail: fest verdrahtet, weil es noch keine settings-Tabelle gibt — im UI änderbar machen, sobald #812 sie anlegt.
export const RETENTION = { daily: 7, weekly: 4 };

// Nur fertige Sicherungen passen: eine abgebrochene endet auf .tmp und gilt nie als Backup.
const NAME = /^studio-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(?:-(\d+))?\.db$/;

export type Backup = { file: string; at: Date; n: number };

/**
 * Legt ein Verzeichnis nur für den eigenen Nutzer an (0700). Ein vorhandenes mit Rechten für andere bleibt, wie es ist —
 * still umbiegen könnte eine bewusste Einrichtung brechen —, es gibt nur eine Warnung.
 */
export function privateDir(dir: string) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== 'win32' && statSync(dir).mode & 0o077)
		console.warn(`Warnung: ${dir} ist für andere Nutzer zugänglich — „chmod 700 ${dir}“ schränkt das ein.`);
}

/** Fertige Sicherungen in `dir`, neueste zuerst. */
export function listBackups(dir: string): Backup[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return []; // Verzeichnis entsteht mit der ersten Sicherung
	}
	return names
		.flatMap((file) => {
			const m = NAME.exec(file);
			return m ? [{ file, at: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])), n: Number(m[6] ?? 1) }] : [];
		})
		.sort((a, b) => b.at.getTime() - a.at.getTime() || b.n - a.n);
}

/**
 * Konsistenter Schnappschuss von `db` nach `dir`; gibt den Pfad zurück. Erst in eine Temp-Datei, fsync, dann Rename —
 * ein abgebrochener Lauf hinterlässt höchstens eine .tmp-Datei. Zwei Sicherungen in derselben Minute bekommen `-2`, `-3`, ….
 * Wirft einen Fehler mit Ausweg; läuft nicht innerhalb einer Transaktion (Einschränkung von VACUUM).
 */
export function backup(db: DatabaseSync, dir: string, now = new Date()): string {
	const stamp = now.toISOString().replace(/\D/g, '');
	const base = join(dir, `studio-${stamp.slice(0, 8)}-${stamp.slice(8, 12)}`);
	const taken = new Set(listBackups(dir).map((b) => join(dir, b.file)));
	let file = `${base}.db`;
	for (let n = 2; taken.has(file); n++) file = `${base}-${n}.db`;
	const tmp = `${file}.tmp`;
	try {
		privateDir(dir);
		rmSync(tmp, { force: true }); // Rest eines abgestürzten Laufs — VACUUM INTO nimmt nur eine leere Zieldatei
		// 0600 ab dem ersten Byte: Sicherungen enthalten Passwort- und Session-Hashes, Chiffrate und den ganzen Verlauf
		writeFileSync(tmp, '', { mode: 0o600, flag: 'wx' });
		db.prepare('VACUUM INTO ?').run(tmp);
		const fd = openSync(tmp, 'r+');
		fsyncSync(fd); // erst auf der Platte, dann sichtbar
		closeSync(fd);
		renameSync(tmp, file);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw new Error(`Sicherung nach ${dir} fehlgeschlagen (${(err as Error).message}). Freien Speicherplatz und Schreibrechte prüfen.`, {
			cause: err
		});
	}
	return file;
}

/**
 * Aufbewahrung: die neueste Sicherung der letzten `daily` Tage und der letzten `weekly` Wochen (ab Montag, UTC), jeweils
 * gezählt über Tage/Wochen, die überhaupt eine Sicherung haben — lange Pausen löschen also nichts. Die neueste bleibt immer.
 * Gibt die gelöschten Dateinamen zurück.
 */
export function prune(dir: string, { daily, weekly } = RETENTION, now = new Date()): string[] {
	const present = listBackups(dir).filter((b) => b.at.getTime() <= now.getTime());
	const keep = new Set(present.slice(0, 1));
	const days = new Set<number>();
	const weeks = new Set<number>();
	for (const b of present) {
		const day = Math.floor(b.at.getTime() / DAY);
		const week = Math.floor((day + 3) / 7); // Tag 0 (1970-01-01) war ein Donnerstag
		if (!days.has(day) && days.size < daily) {
			days.add(day);
			keep.add(b);
		}
		if (!weeks.has(week) && weeks.size < weekly) {
			weeks.add(week);
			keep.add(b);
		}
	}
	const gone = present.filter((b) => !keep.has(b));
	for (const b of gone) rmSync(join(dir, b.file));
	// Aborted runs leave a .tmp behind; prune runs right after backup() in the only process holding the data-dir lock, so nothing is in flight.
	for (const file of readdirSync(dir)) {
		if (file.endsWith('.tmp')) rmSync(join(dir, file));
	}
	return gone.map((b) => b.file);
}

let lastError: string | null = null;

/** Sichert, wenn die neueste Sicherung mindestens einen Tag alt ist (oder fehlt), und räumt auf. Fehler landen im Status. */
export function backupIfDue(db: DatabaseSync, dir: string, now = new Date()) {
	const last = listBackups(dir).find((b) => b.at.getTime() <= now.getTime());
	if (last && now.getTime() - last.at.getTime() < DAY) return;
	try {
		backup(db, dir, now);
		prune(dir, RETENTION, now);
		lastError = null;
	} catch (err) {
		lastError = (err as Error).message;
		console.error(lastError);
	}
}

/**
 * Beim Start und dann stündlich prüfen — so übersteht der Tagesrhythmus auch häufige Neustarts.
 * ponytail: VACUUM INTO läuft synchron im Server-Prozess und hält bei großer DB kurz alle Anfragen an — in einen Worker
 * verlegen, sobald das spürbar wird.
 */
export function startBackups(db: DatabaseSync, dir: string) {
	backupIfDue(db, dir);
	setInterval(() => backupIfDue(db, dir), HOUR).unref();
}

export type BackupStatus = { dir: string; last: { path: string; size: number; at: string } | null; error: string | null };

/** Für den System-Check (#812 übernimmt ihn in seine Prüfungs-Registry): letzte Sicherung, Größe, Pfad, Problem mit Ausweg. */
export function backupStatus(dir: string, now = new Date()): BackupStatus {
	const all = listBackups(dir);
	const recent = all.find((b) => b.at.getTime() <= now.getTime());
	const future = all.find((b) => b.at.getTime() > now.getTime());
	const last = all[0] ? { path: join(dir, all[0].file), size: statSync(join(dir, all[0].file)).size, at: all[0].at.toISOString() } : null;
	const stale = !recent || now.getTime() - recent.at.getTime() > DAY + HOUR;
	const error =
		lastError ??
		(future
			? `Neueste Sicherung liegt mit ${future.at.toISOString()} in der Zukunft — die Frische zählt nur Sicherungen bis jetzt. Uhr prüfen (fehlerhafte Uhr oder Restore von einem anderen Host).`
			: stale
			? `Keine Sicherung aus den letzten 24 Stunden. Studio sichert stündlich nach — Server-Log und Schreibrechte in ${dir} prüfen.`
			: null);
	return { dir, last, error };
}
