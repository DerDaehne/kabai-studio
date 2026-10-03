// Backups of the SQLite DB: `VACUUM INTO` to `<data-dir>/backups/studio-YYYYMMDD-HHMM[-N].db` (UTC).
// node: imports only — the restore CLI loads this file directly under Node, without Vite.
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// ponytail: hard-wired because there is no settings table yet — make it editable in the UI once one exists.
export const RETENTION = { daily: 7, weekly: 4 };

// Only finished backups match: an aborted one ends in .tmp and never counts as a backup.
const NAME = /^studio-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(?:-(\d+))?\.db$/;

export type Backup = { file: string; at: Date; n: number };

/**
 * Creates a directory for the owner only (0700). An existing one that others can access stays as it is — silently
 * changing it could break a deliberate setup — and only gets a warning.
 */
export function privateDir(dir: string) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== 'win32' && statSync(dir).mode & 0o077)
		console.warn(
			`Warnung: ${dir} ist für andere Nutzer zugänglich — „chmod 700 ${dir}“ schränkt das ein.`
		);
}

/** Finished backups in `dir`, newest first. */
export function listBackups(dir: string): Backup[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return []; // the directory appears with the first backup
	}
	return names
		.flatMap((file) => {
			const m = NAME.exec(file);
			return m
				? [
						{
							file,
							at: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])),
							n: Number(m[6] ?? 1)
						}
					]
				: [];
		})
		.sort((a, b) => b.at.getTime() - a.at.getTime() || b.n - a.n);
}

/**
 * Consistent snapshot of `db` into `dir`; returns the path. Writes a temp file, fsyncs, then renames — an aborted run
 * leaves at most a .tmp file. Two backups in the same minute get `-2`, `-3`, ….
 * Throws an error with a way out; must not run inside a transaction (a VACUUM restriction).
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
		rmSync(tmp, { force: true }); // leftover of a crashed run — VACUUM INTO only accepts an empty target file
		// 0600 from the first byte: backups hold password and session hashes, ciphertexts and the whole history
		writeFileSync(tmp, '', { mode: 0o600, flag: 'wx' });
		db.prepare('VACUUM INTO ?').run(tmp);
		const fd = openSync(tmp, 'r+');
		fsyncSync(fd); // on disk first, then visible
		closeSync(fd);
		renameSync(tmp, file);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw new Error(
			`Sicherung nach ${dir} fehlgeschlagen (${(err as Error).message}). Freien Speicherplatz und Schreibrechte prüfen.`,
			{
				cause: err
			}
		);
	}
	return file;
}

/**
 * Retention: the newest backup of each of the last `daily` days and the last `weekly` weeks (Monday-based, UTC),
 * counted over days/weeks that have a backup at all — long pauses therefore delete nothing. The newest always stays.
 * Future-dated backups (at > now) are never deleted and take no retention slot, because they may be the only good state.
 * Returns the deleted file names.
 */
export function prune(dir: string, { daily, weekly } = RETENTION, now = new Date()): string[] {
	const present = listBackups(dir).filter((b) => b.at.getTime() <= now.getTime());
	const keep = new Set(present.slice(0, 1));
	const days = new Set<number>();
	const weeks = new Set<number>();
	for (const b of present) {
		const day = Math.floor(b.at.getTime() / DAY);
		const week = Math.floor((day + 3) / 7); // day 0 (1970-01-01) was a Thursday
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
		if (file.endsWith('.db.tmp')) rmSync(join(dir, file));
	}
	return gone.map((b) => b.file);
}

let lastError: string | null = null;

/** Backs up when the newest backup with at <= now is at least a day old (or missing), then prunes; errors land in the status. */
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
 * Checks at startup and then hourly, so the daily rhythm survives frequent restarts.
 * ponytail: VACUUM INTO runs synchronously in the server process and briefly holds up all requests on a large DB —
 * move it into a worker once that becomes noticeable.
 */
export function startBackups(db: DatabaseSync, dir: string) {
	backupIfDue(db, dir);
	setInterval(() => backupIfDue(db, dir), HOUR).unref();
}

export type BackupStatus = {
	dir: string;
	last: { path: string; size: number; at: string } | null;
	error: string | null;
};

/** For the system check: newest backup, size, path, and a problem with its way out. */
export function backupStatus(dir: string, now = new Date()): BackupStatus {
	const all = listBackups(dir);
	const recent = all.find((b) => b.at.getTime() <= now.getTime());
	const future = all.find((b) => b.at.getTime() > now.getTime());
	const last = all[0]
		? {
				path: join(dir, all[0].file),
				size: statSync(join(dir, all[0].file)).size,
				at: all[0].at.toISOString()
			}
		: null;
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
