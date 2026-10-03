import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { format, inspect } from 'node:util';
import { dataDir } from './db';
import { DomainError } from './domain/core';

// Secrets store: AES-256-GCM, with the key in `secret.key` or STUDIO_SECRET_KEY.
// Plain text leaves this module only through resolveRef — for provider clients and process env, never for UI, prompts or agents.

const KEY_ENV = 'STUDIO_SECRET_KEY';
const KEY_FORMAT = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes as Base64
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/; // same as the CHECK in migrations/004_secrets.sql
/** Shorter values could not be masked without hiding ordinary words in logs, and as a key or token they are almost certainly incomplete. */
export const MIN_LENGTH = 8;

type Row = { name: string; ciphertext: Uint8Array; iv: Uint8Array; auth_tag: Uint8Array };
export type SecretMeta = { name: string; created_at: string; updated_at: string };

const invalidKey = (what: string, hint: string) =>
	new DomainError(
		'secret_key_invalid',
		`${what} ist kein gültiger Schlüssel (erwartet: 32 Bytes als Base64, 44 Zeichen).`,
		hint
	);

/**
 * Loads the key: `STUDIO_SECRET_KEY` wins, otherwise `<dir>/secret.key` — a missing file is created with mode 0600.
 * Both hold the same Base64 text, so the key can move between file and env.
 */
export function loadKey(dir = dataDir(), env = process.env[KEY_ENV]): Buffer {
	if (env !== undefined) {
		// empty is an error too: otherwise a new secret.key would appear silently and the stored secrets would be unreadable
		if (!KEY_FORMAT.test(env.trim()))
			throw invalidKey(
				KEY_ENV,
				`Erzeuge einen mit „openssl rand -base64 32“ — oder entferne ${KEY_ENV}, dann nutzt Studio secret.key im Datenverzeichnis.`
			);
		return keyFrom(env.trim());
	}
	const file = join(dir, 'secret.key');
	mkdirSync(dir, { recursive: true });
	try {
		writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' }); // wx: never overwrite a key
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
	}
	const text = readFileSync(file, 'utf8').trim();
	if (!KEY_FORMAT.test(text))
		throw invalidKey(
			file,
			'Stelle die Datei aus dem Backup wieder her. Ist der Schlüssel verloren: Datei löschen und neu starten — Studio erzeugt einen neuen, gespeicherte Secrets müssen dann neu eingegeben werden.'
		);
	if (process.platform !== 'win32' && statSync(file).mode & 0o077)
		console.warn(
			`Warnung: ${file} ist für andere Nutzer lesbar — „chmod 600 ${file}“ schränkt das ein.`
		);
	return keyFrom(text);
}

/** Base64 text → key. The text itself is masked too: the key must not appear in any log either. */
const keyFrom = (text: string) => Buffer.from(remember(text, '[secret-key]'), 'base64');

let key: Buffer | undefined;
/** The process's key, loaded or created on the first call (not on import, so the build creates nothing). */
export const secretKey = () => (key ??= loadKey());

// The name is additional authenticated data: a ciphertext cannot be copied unnoticed under another name
// (say, the Anthropic key into the token of a foreign MCP server).
function encrypt(key: Buffer, name: string, value: string) {
	const iv = randomBytes(12); // fresh per value — GCM must never reuse an IV with the same key
	const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(name));
	const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, row: Row): string {
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, row.iv, { authTagLength: 16 }).setAAD(
			Buffer.from(row.name)
		);
		decipher.setAuthTag(row.auth_tag);
		return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
	} catch {
		// GCM checks the auth tag: a wrong key or altered data end up here, never as garbage data
		throw new DomainError(
			'secret_undecryptable',
			`Secret „${row.name}“ lässt sich mit dem aktuellen Schlüssel nicht entschlüsseln.`,
			`Der Schlüssel (${KEY_ENV} bzw. secret.key im Datenverzeichnis) ist nicht der, mit dem das Secret gespeichert wurde: den richtigen wiederherstellen und neu starten — oder das Secret unter Einstellungen → Secrets ersetzen.`
		);
	}
}

// ---- Masking ----

/** Known secret values → placeholder. Deleted ones stay until a restart: masking too much does no harm. */
const known = new Map<string, string>();

function remember(value: string, label: string): string {
	// the JSON/inspect-escaped form too: multi-line values (PEM) appear in logs as "…\n…"
	if (value.length >= MIN_LENGTH)
		for (const v of [value, JSON.stringify(value).slice(1, -1)]) known.set(v, label);
	return value;
}

function maskText(text: string): string {
	// longest first: if one secret contains another, no rest of the longer one is left
	for (const [value, label] of [...known].sort(([a], [b]) => b.length - a.length))
		text = text.replaceAll(value, () => label);
	return text;
}

/**
 * Replaces known secret values with `[secret:<name>]`, `[env:<NAME>]` or `[secret-key]` — in strings, arrays, plain
 * objects (values and keys) and errors (message, stack, cause, own fields like code/hint; the type stays). Other objects
 * (URL, Date, Map, class instances) come back in their JSON form, as they would be stored; without a JSON form as
 * masked inspect text. Cycles become `[Circular]`. The original stays unchanged.
 * Required for everything an agent or the browser can read later: run_events payloads, error messages, tool results.
 * Works the same on serialised payloads: `mask(JSON.stringify(payload))` (the JSON-escaped form is remembered too).
 */
export const mask = <T>(value: T): T => walk(value, new Set()) as T;

function walk(value: unknown, parents: Set<object>): unknown {
	if (typeof value === 'string') return maskText(value);
	if (!value || typeof value !== 'object') return value;
	if (parents.has(value)) return '[Circular]';
	parents.add(value);
	try {
		if (Array.isArray(value)) return value.map((v) => walk(v, parents));
		if (value instanceof Error) return walkError(value, parents);
		const proto = Object.getPrototypeOf(value);
		if (proto === Object.prototype || proto === null)
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [maskText(k), walk(v, parents)])
			);
		const json = tryStringify(value);
		return json === undefined ? maskText(inspect(value)) : walk(JSON.parse(json), parents);
	} finally {
		parents.delete(value); // only ancestors count: the same object twice side by side is no cycle
	}
}

function walkError(error: Error, parents: Set<object>): Error {
	const copy = Object.assign(
		Object.create(Object.getPrototypeOf(error)),
		walk({ ...error }, parents),
		{
			message: maskText(error.message),
			stack: error.stack && maskText(error.stack)
		}
	);
	if ('cause' in error) copy.cause = walk(error.cause, parents);
	return copy;
}

/** undefined for values JSON cannot represent: cycles, BigInt, throwing getters. */
function tryStringify(value: object): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/**
 * Wraps console.* in the masking, so every log line of the process passes through it, including those of libraries
 * and SvelteKit's error output. Formats first (objects, errors with cause), then masks the finished text.
 */
export function maskConsole(target: Pick<Console, (typeof LEVELS)[number]> = console): void {
	// ponytail: direct writes to process.stdout/stderr (e.g. Node's output on uncaughtException) bypass this — add a hook if that becomes relevant.
	for (const level of LEVELS) {
		const write = target[level].bind(target);
		target[level] = (...args: unknown[]) => write('%s', maskText(format(...args)));
	}
}

// ---- Store ----

/** Names and timestamps, never values or ciphertexts — all the UI ever sees of secrets. */
export const listSecrets = (db: DatabaseSync) =>
	db
		.prepare('SELECT name, created_at, updated_at FROM secrets ORDER BY name')
		.all() as SecretMeta[];

/**
 * Stores a secret encrypted. It overwrites an existing name only with `replace`, because replacing cannot be undone
 * and must be intended. Surrounding whitespace (from pasting) is dropped.
 * Error messages never repeat the entered value — not even an invalid name, in case the key ended up there by mistake.
 */
export function setSecret(
	db: DatabaseSync,
	name: string,
	value: string,
	replace = false,
	key = secretKey()
): void {
	value = value.trim();
	assertStorable(name, value);
	if (!replace && db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(name))
		throw new DomainError(
			'secret_exists',
			`Secret „${name}“ gibt es schon.`,
			'Nutze „Ersetzen“ beim vorhandenen Eintrag — der bisherige Wert geht dabei verloren.'
		);

	const { ciphertext, iv, tag } = encrypt(key, name, value);
	db.prepare(
		`INSERT INTO secrets (name, ciphertext, iv, auth_tag) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE
		SET ciphertext = excluded.ciphertext, iv = excluded.iv, auth_tag = excluded.auth_tag, updated_at = CURRENT_TIMESTAMP`
	).run(name, ciphertext, iv, tag);
	remember(value, `[secret:${name}]`);
}

function assertStorable(name: string, value: string) {
	if (name === value)
		throw new DomainError(
			'secret_name_is_value',
			'Name und Wert sind gleich.',
			'Der Name ist überall im Klartext sichtbar — wähle eine Bezeichnung wie „anthropic-api-key“.'
		);
	if (!NAME.test(name))
		throw new DomainError(
			'secret_name_invalid',
			'Der Name ist ungültig.',
			'Erlaubt sind 1–64 Zeichen aus a–z, 0–9, „-“ und „_“, beginnend mit Buchstabe oder Ziffer — z. B. „anthropic-api-key“.'
		);
	if (!value)
		throw new DomainError(
			'secret_empty',
			'Der Wert ist leer.',
			'Füge den vollständigen Key bzw. Token ein.'
		);
	if (value.length < MIN_LENGTH)
		throw new DomainError(
			'secret_too_short',
			`Der Wert hat nur ${value.length} Zeichen, nötig sind mindestens ${MIN_LENGTH}.`,
			'Prüfe, ob der Key vollständig eingefügt wurde. So kurze Werte lassen sich in Logs nicht sicher maskieren und gehören nicht in den Secret-Store.'
		);
}

/** Deletes a secret. Idempotent: `false` if there was none (any more). */
export const deleteSecret = (db: DatabaseSync, name: string) =>
	db.prepare('DELETE FROM secrets WHERE name = ?').run(name).changes > 0;

function getSecret(db: DatabaseSync, name: string, key: Buffer): string {
	const row = db
		.prepare('SELECT name, ciphertext, iv, auth_tag FROM secrets WHERE name = ?')
		.get(name) as Row | undefined;
	if (!row)
		throw NAME.test(name)
			? new DomainError(
					'secret_not_found',
					`Secret „${name}“ gibt es nicht.`,
					'Lege es unter Einstellungen → Secrets an oder korrigiere den Verweis secret:<name>.'
				)
			: // not a valid name, maybe a key pasted by mistake: do not repeat it
				new DomainError(
					'secret_ref_invalid',
					'Der Verweis secret:<name> enthält keinen gültigen Secret-Namen.',
					`Namen bestehen aus 1–64 Zeichen a–z, 0–9, „-“ und „_“ — z. B. secret:anthropic-api-key. Steht dort der Key selbst, speichere ihn unter Einstellungen → Secrets und verweise auf seinen Namen.`
				);
	return remember(decrypt(key, row), `[secret:${name}]`);
}

/**
 * The one place that resolves references in configuration values: `secret:<name>` (the whole value) → decrypted secret;
 * otherwise every `${ENV_NAME}` is replaced by the environment variable and other text stays (`Bearer ${TOKEN}`).
 * Resolved values are masked. `${STUDIO_*}` is refused (the key and other internals).
 */
export function resolveRef(db: DatabaseSync, ref: string, key = secretKey()): string {
	if (ref.startsWith('secret:')) return getSecret(db, ref.slice('secret:'.length), key);
	return ref.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
		// Studio internals (above all STUDIO_SECRET_KEY) never go to providers or MCP servers; i: the Windows env ignores case
		if (/^STUDIO_/i.test(name))
			throw new DomainError(
				'env_forbidden',
				`${name} ist eine interne Studio-Variable und lässt sich nicht als Verweis auflösen.`,
				'Speichere den benötigten Wert unter Einstellungen → Secrets und verweise mit secret:<name> darauf.'
			);
		const value = process.env[name];
		if (!value)
			throw new DomainError(
				'env_missing',
				`Umgebungsvariable ${name} ist nicht gesetzt.`,
				`Setze ${name} für den Studio-Prozess und starte neu — oder speichere den Wert unter Einstellungen → Secrets und verweise mit secret:<name> darauf.`
			);
		return remember(value, `[env:${name}]`);
	});
}

/**
 * At startup: loads or creates the key and decrypts all secrets for the masking. Secrets that cannot be decrypted
 * are reported but do not abort the start; they can be replaced in the UI.
 */
export function initSecrets(db: DatabaseSync, key = secretKey()): void {
	for (const row of db
		.prepare('SELECT name, ciphertext, iv, auth_tag FROM secrets')
		.all() as Row[]) {
		try {
			remember(decrypt(key, row), `[secret:${row.name}]`);
		} catch (err) {
			const e = err as DomainError;
			console.warn(`Warnung: ${e.message} ${e.hint}`);
		}
	}
}
