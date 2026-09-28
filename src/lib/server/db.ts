import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Migrationen werden beim Build eingebettet: das ausgelieferte Paket braucht keinen Dateipfad zu migrations/.
const bundled = import.meta.glob<string>('/migrations/*.sql', { query: '?raw', import: 'default', eager: true });

export function openDb(file: string): DatabaseSync {
	const db = new DatabaseSync(file);
	db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
	return db;
}

/**
 * Wendet noch nicht angewendete Migrationen in Namensreihenfolge an, jede in eigener Transaktion.
 * Migrationsdateien dürfen daher selbst kein BEGIN/COMMIT enthalten. Gibt die angewendeten Namen zurück.
 */
export function migrate(db: DatabaseSync, migrations: Record<string, string> = bundled): string[] {
	db.exec(
		'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT'
	);
	const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
	const pending = Object.entries(migrations)
		.map(([path, sql]) => [path.split('/').pop()!, sql] as const)
		.filter(([name]) => !done.has(name))
		.sort(([a], [b]) => (a < b ? -1 : 1));

	for (const [name, sql] of pending) {
		db.exec('BEGIN');
		try {
			db.exec(sql);
			db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
			db.exec('COMMIT');
		} catch (err) {
			if (db.isTransaction) db.exec('ROLLBACK'); // manche Fehler beenden die Transaktion bereits selbst
			throw new Error(`Migration ${name} fehlgeschlagen`, { cause: err });
		}
	}
	return pending.map(([name]) => name);
}

let conn: DatabaseSync | undefined;

/** Die eine Verbindung des Prozesses — beim ersten Aufruf geöffnet und migriert. */
export function db(): DatabaseSync {
	if (!conn) {
		const dir = process.env.STUDIO_DATA_DIR || 'data';
		mkdirSync(dir, { recursive: true });
		const c = openDb(join(dir, 'studio.db'));
		migrate(c);
		conn = c;
	}
	return conn;
}
