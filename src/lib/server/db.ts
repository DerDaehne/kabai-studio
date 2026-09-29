import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backup } from './backup.ts';

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
/** Enthält die PID des laufenden Servers; restore bricht ab, solange dieser Prozess lebt. */
export const pidFile = () => join(dataDir(), 'studio.pid');

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
	migrations: Record<string, string> = import.meta.glob<string>('/migrations/*.sql', { query: '?raw', import: 'default', eager: true }),
	beforeUpgrade?: () => void
): string[] {
	db.exec(
		'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT'
	);
	const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?');
	const pending = Object.entries(migrations)
		.map(([path, sql]) => [path.split('/').pop()!, sql] as const)
		.filter(([name]) => !applied.get(name))
		.sort(([a], [b]) => (a < b ? -1 : 1));
	if (pending.length && db.prepare('SELECT 1 FROM schema_migrations LIMIT 1').get()) beforeUpgrade?.();

	const ran: string[] = [];
	for (const [name, sql] of pending) {
		db.exec('BEGIN IMMEDIATE');
		try {
			if (!applied.get(name)) {
				db.exec(sql);
				db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
				ran.push(name);
			}
			db.exec('COMMIT');
		} catch (err) {
			if (db.isTransaction) db.exec('ROLLBACK'); // manche Fehler beenden die Transaktion bereits selbst
			throw new Error(`Migration ${name} fehlgeschlagen`, { cause: err });
		}
	}
	return ran;
}

let conn: DatabaseSync | undefined;

/** Die eine Verbindung des Prozesses — beim ersten Aufruf geöffnet, gesichert (falls Migrationen anstehen) und migriert. */
export function db(): DatabaseSync {
	if (!conn) {
		mkdirSync(dataDir(), { recursive: true });
		const c = openDb(join(dataDir(), 'studio.db'));
		migrate(c, undefined, () => backup(c, backupDir())); // Sicherung scheitert → Start bricht ab, nichts wird migriert
		conn = c;
	}
	return conn;
}
