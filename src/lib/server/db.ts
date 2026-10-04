import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backup, privateDir } from './backup.ts';
import { DomainError } from './domain/error.ts';

export function openDb(file: string): DatabaseSync {
	const db = new DatabaseSync(file);
	// busy_timeout first: otherwise journal_mode=WAL fails on a second connection right away with
	// "database is locked" instead of waiting.
	db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
	return db;
}

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

// This process's locks per lock file — on globalThis so that a reloaded db.ts (Vite HMR) recognises its own lock
// instead of failing on it.
const locks: Map<string, DatabaseSync> = ((
	globalThis as { studioLocks?: Map<string, DatabaseSync> }
).studioLocks ??= new Map());

/**
 * Single-instance lock on the data directory: an exclusive SQLite lock on `<dir>/studio.lock`, held until the process
 * ends. The kernel releases it even after a crash or kill -9 — no stale files, no PID reuse, and a second instance can
 * neither take it over nor delete it. false = another process (server or restore) holds it.
 */
export function lockDataDir(dir = dataDir()): boolean {
	const file = resolve(dir, 'studio.lock');
	if (locks.has(file)) return true;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = new DatabaseSync(file);
	try {
		// in EXCLUSIVE locking mode the lock taken by BEGIN EXCLUSIVE outlives COMMIT until the connection closes
		lock.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
	} catch (err) {
		lock.close();
		if ((err as { errcode?: number }).errcode === 5) return false; // SQLITE_BUSY: held elsewhere
		throw err;
	}
	locks.set(file, lock);
	return true;
}

/**
 * Applies pending migrations in name order, each in its own transaction (so migration files contain no BEGIN/COMMIT),
 * and returns their names. Foreign keys are off while a migration runs (ON DELETE actions do not fire) and are checked
 * before its COMMIT. Safe across processes: each transaction re-checks schema_migrations under the write lock.
 * `beforeUpgrade` runs once before upgrading a non-empty DB; if it throws, nothing is applied.
 */
export function migrate(
	db: DatabaseSync,
	// Embedded at build time (the shipped package needs no path to migrations/). As a default parameter, so that
	// db.ts stays importable without Vite (reset-password CLI).
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

/** Name of the most recently applied migration, for /api/health — a schema identifier, never a row count. */
export function latestMigration(db: DatabaseSync): string | null {
	const row = db.prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1').get() as
		{ name: string } | undefined;
	return row?.name ?? null;
}

/**
 * Applies one migration with foreign keys off, so that rebuilding a table (create new, copy, drop old, rename new) does
 * not cascade into the rows referencing it; false if another process applied it first.
 */
function applyMigration(db: DatabaseSync, name: string, sql: string): boolean {
	// Outside the transaction on purpose: SQLite ignores PRAGMA foreign_keys while a transaction is open.
	db.exec('PRAGMA foreign_keys = OFF');
	try {
		return applyInTransaction(db, name, sql);
	} finally {
		db.exec('PRAGMA foreign_keys = ON');
	}
}

/** Runs the migration in its own write transaction and commits only if it leaves no dangling reference behind. */
function applyInTransaction(db: DatabaseSync, name: string, sql: string): boolean {
	db.exec('BEGIN IMMEDIATE');
	try {
		const runsHere = !isApplied(db, name);
		if (runsHere) {
			db.exec(sql);
			assertNoDanglingReferences(db, name);
			db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
		}
		db.exec('COMMIT');
		return runsHere;
	} catch (err) {
		if (db.isTransaction) db.exec('ROLLBACK'); // some errors already end the transaction themselves
		if (err instanceof DomainError) throw err;
		throw new Error(`Migration ${name} fehlgeschlagen`, { cause: err });
	}
}

type ForeignKeyViolation = { table: string; rowid: number; parent: string };

function assertNoDanglingReferences(db: DatabaseSync, name: string): void {
	const violations = db.prepare('PRAGMA foreign_key_check').all() as ForeignKeyViolation[];
	if (!violations.length) return;
	const { table, rowid, parent } = violations[0];
	throw new DomainError(
		'migration_foreign_key_violation',
		`Migration ${name} hinterlässt Verweise ins Leere (${violations.length}), zuerst ${table} Zeile ${rowid} → ${parent}. ` +
			'Die Migration wurde vollständig zurückgerollt.',
		'Die Sicherung von vor dem Update aus backups/ im Datenverzeichnis mit restore zurückspielen und die vorherige ' +
			'Studio-Version starten, oder eine Version mit korrigierter Migration installieren.'
	);
}

let conn: DatabaseSync | undefined;

/**
 * The process's single connection — on the first call it locks the data directory (before any DB access), opens,
 * backs up (if migrations are pending) and migrates.
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
		migrate(c, undefined, () => backup(c, backupDir())); // a failed backup aborts the start before any migration
		conn = c;
	}
	return conn;
}
