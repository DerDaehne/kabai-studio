import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backup, privateDir } from './backup.ts';
import { DomainError } from './domain/error.ts';

export function openDb(file: string): DatabaseSync {
	const db = new DatabaseSync(file);
	// busy_timeout zuerst: sonst scheitert journal_mode=WAL bei einer zweiten Verbindung sofort mit
	// "database is locked" statt zu warten (#817).
	db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
	return db;
}

/** Datenverzeichnis: `STUDIO_DATA_DIR`, Default `./data`. */
export const dataDir = () => process.env.STUDIO_DATA_DIR || 'data';
export const backupDir = () => join(dataDir(), 'backups');

export function assertKnownMigrations(applied: Iterable<string>, known: ReadonlySet<string>): void {
	const unknown = [...applied].filter((name) => !known.has(name));
	if (unknown.length)
		throw new DomainError(
			'db_newer_than_code',
			`Datenbank enthält unbekannte Migrationen, die dieser Code nicht kennt: ${unknown.join(', ')}.`,
			'Eine neuere Studio-Version installieren oder eine ältere Sicherung wiederherstellen.'
		);
}

// Sperren dieses Prozesses je Lock-Datei — auf globalThis, damit ein neu geladenes db.ts (Vite-HMR) die eigene Sperre
// wiedererkennt, statt an ihr zu scheitern.
const locks: Map<string, DatabaseSync> = ((
	globalThis as { studioLocks?: Map<string, DatabaseSync> }
).studioLocks ??= new Map());

/**
 * Einzelinstanz-Sperre auf dem Datenverzeichnis: exklusive SQLite-Sperre auf `<dir>/studio.lock`, gehalten bis zum
 * Prozessende. Der Kernel gibt sie auch nach Absturz oder kill -9 frei — keine verwaisten Dateien, keine PID-Wiederverwendung,
 * und eine zweite Instanz kann sie weder übernehmen noch löschen. false = ein anderer Prozess (Server oder restore) hält sie.
 */
export function lockDataDir(dir = dataDir()): boolean {
	const file = resolve(dir, 'studio.lock');
	if (locks.has(file)) return true;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = new DatabaseSync(file);
	try {
		// im EXCLUSIVE-Modus bleibt die mit BEGIN EXCLUSIVE geholte Sperre nach COMMIT bestehen, bis die Verbindung schließt
		lock.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
	} catch (err) {
		lock.close();
		if ((err as { errcode?: number }).errcode === 5) return false; // SQLITE_BUSY: gehalten
		throw err;
	}
	locks.set(file, lock);
	return true;
}

/**
 * Wendet noch nicht angewendete Migrationen in Namensreihenfolge an, jede in eigener Transaktion.
 * Migrationsdateien dürfen daher selbst kein BEGIN/COMMIT enthalten. Gibt die angewendeten Namen zurück.
 * Mehrprozessfest: BEGIN IMMEDIATE holt die Schreibsperre (busy_timeout wartet), danach wird
 * schema_migrations in der Transaktion erneut geprüft — ein zweiter Prozess überspringt, was der erste schon anwendete.
 * `beforeUpgrade` läuft einmal vor der ersten Migration, wenn welche anstehen und die DB schon Migrationen hat (nicht leer);
 * wirft er, bricht migrate ab, ohne etwas anzuwenden.
 */
export function migrate(
	db: DatabaseSync,
	// Beim Build eingebettet (das ausgelieferte Paket braucht keinen Pfad zu migrations/). Als Default-Parameter,
	// damit db.ts auch ohne Vite importierbar bleibt (CLI reset-password).
	migrations: Record<string, string> = import.meta.glob<string>('/migrations/*.sql', {
		query: '?raw',
		import: 'default',
		eager: true
	}),
	beforeUpgrade?: () => void
): string[] {
	db.exec(
		'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT'
	);
	const known = new Set(Object.keys(migrations).map((path) => path.split('/').pop()!));
	// Before any transaction: a DB with migrations this code doesn't know must not be written to.
	assertKnownMigrations(
		(db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map(
			(r) => r.name
		),
		known
	);
	const pending = Object.entries(migrations)
		.map(([path, sql]) => [path.split('/').pop()!, sql] as const)
		.filter(([name]) => !isApplied(db, name))
		.sort(([a], [b]) => (a < b ? -1 : 1));
	if (pending.length && db.prepare('SELECT 1 FROM schema_migrations LIMIT 1').get())
		beforeUpgrade?.();

	const ran: string[] = [];
	for (const [name, sql] of pending) {
		if (applyMigration(db, name, sql)) ran.push(name);
	}
	return ran;
}

function isApplied(db: DatabaseSync, name: string): boolean {
	return !!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name);
}

/** Applies one migration in its own write transaction; false if another process applied it first. */
function applyMigration(db: DatabaseSync, name: string, sql: string): boolean {
	db.exec('BEGIN IMMEDIATE');
	try {
		const runsHere = !isApplied(db, name);
		if (runsHere) {
			db.exec(sql);
			db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
		}
		db.exec('COMMIT');
		return runsHere;
	} catch (err) {
		if (db.isTransaction) db.exec('ROLLBACK'); // some errors already end the transaction themselves
		throw new Error(`Migration ${name} fehlgeschlagen`, { cause: err });
	}
}

let conn: DatabaseSync | undefined;

/**
 * Die eine Verbindung des Prozesses — beim ersten Aufruf: Datenverzeichnis sperren (vor jeder DB-Aktion), öffnen,
 * sichern (falls Migrationen anstehen) und migrieren.
 */
export function db(): DatabaseSync {
	if (!conn) {
		privateDir(dataDir());
		if (!lockDataDir())
			throw new Error(
				`Studio läuft bereits mit dem Datenverzeichnis ${resolve(dataDir())} (zweiter Server oder laufendes restore). ` +
					`Die laufende Instanz verwenden oder beenden — für eine weitere Instanz STUDIO_DATA_DIR auf ein eigenes Verzeichnis setzen.`
			);
		const c = openDb(join(dataDir(), 'studio.db'));
		migrate(c, undefined, () => backup(c, backupDir())); // Sicherung scheitert → Start bricht ab, nichts wird migriert
		conn = c;
	}
	return conn;
}
