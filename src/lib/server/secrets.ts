import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { format } from 'node:util';
import { dataDir } from './db';
import { DomainError } from './domain/core';

// Secrets-Store (ADR studio-011): AES-256-GCM, Schlüssel in `secret.key` bzw. STUDIO_SECRET_KEY.
// Klartext verlässt dieses Modul nur über resolveRef — für Provider-Clients und Prozess-Env, nie für UI, Prompts oder Agents.

const KEY_ENV = 'STUDIO_SECRET_KEY';
const KEY_FORMAT = /^[A-Za-z0-9+/]{43}=$/; // 32 Bytes als Base64
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/; // wie der CHECK in migrations/004_secrets.sql
/** Kürzere Werte ließen sich nicht maskieren, ohne gewöhnliche Wörter in Logs zu verdecken — und sind als Key/Token fast sicher unvollständig. */
export const MIN_LENGTH = 8;

type Row = { name: string; ciphertext: Uint8Array; iv: Uint8Array; auth_tag: Uint8Array };
export type SecretMeta = { name: string; created_at: string; updated_at: string };

const invalidKey = (what: string, hint: string) =>
	new DomainError('secret_key_invalid', `${what} ist kein gültiger Schlüssel (erwartet: 32 Bytes als Base64, 44 Zeichen).`, hint);

/**
 * Lädt den Schlüssel: `STUDIO_SECRET_KEY` hat Vorrang, sonst `<dir>/secret.key` — fehlt die Datei, wird sie mit Rechten 0600
 * erzeugt. Beide enthalten denselben Base64-Text, der Schlüssel lässt sich also zwischen Datei und Env umziehen.
 */
export function loadKey(dir = dataDir(), env = process.env[KEY_ENV]): Buffer {
	if (env !== undefined) {
		// auch leer ist ein Fehler: sonst entstünde still eine neue secret.key, und die gespeicherten Secrets wären unlesbar
		if (!KEY_FORMAT.test(env.trim()))
			throw invalidKey(KEY_ENV, `Erzeuge einen mit „openssl rand -base64 32“ — oder entferne ${KEY_ENV}, dann nutzt Studio secret.key im Datenverzeichnis.`);
		return Buffer.from(env.trim(), 'base64');
	}
	const file = join(dir, 'secret.key');
	mkdirSync(dir, { recursive: true });
	try {
		writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' }); // wx: nie einen Schlüssel überschreiben
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
		console.warn(`Warnung: ${file} ist für andere Nutzer lesbar — „chmod 600 ${file}“ schränkt das ein.`);
	return Buffer.from(text, 'base64');
}

let key: Buffer | undefined;
/** Der Schlüssel des Prozesses — beim ersten Aufruf geladen bzw. erzeugt (nicht beim Import: der Build legt nichts an). */
export const secretKey = () => (key ??= loadKey());

// Der Name ist Additional Authenticated Data: ein Chiffrat lässt sich nicht unbemerkt unter einen anderen Namen kopieren
// (etwa den Anthropic-Key in das Token eines fremden MCP-Servers).
function encrypt(key: Buffer, name: string, value: string) {
	const iv = randomBytes(12); // frisch je Wert — GCM darf einen IV mit demselben Schlüssel nie wiederverwenden
	const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(name));
	const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, row: Row): string {
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, row.iv, { authTagLength: 16 }).setAAD(Buffer.from(row.name));
		decipher.setAuthTag(row.auth_tag);
		return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
	} catch {
		// GCM prüft den Auth-Tag: falscher Schlüssel oder veränderte Daten ergeben diesen Fehler, nie Datenmüll
		throw new DomainError(
			'secret_undecryptable',
			`Secret „${row.name}“ lässt sich mit dem aktuellen Schlüssel nicht entschlüsseln.`,
			`Der Schlüssel (${KEY_ENV} bzw. secret.key im Datenverzeichnis) ist nicht der, mit dem das Secret gespeichert wurde: den richtigen wiederherstellen und neu starten — oder das Secret unter Einstellungen → Secrets ersetzen.`
		);
	}
}

// ---- Maskierung ----

/** Bekannte Secret-Werte → Platzhalter. Gelöschte bleiben bis zum Neustart drin: zu viel maskieren schadet nicht. */
const known = new Map<string, string>();

function remember(value: string, label: string): string {
	// auch die JSON-/inspect-escapte Form: mehrzeilige Werte (PEM) erscheinen in Logs als „…\n…“
	if (value.length >= MIN_LENGTH) for (const v of [value, JSON.stringify(value).slice(1, -1)]) known.set(v, label);
	return value;
}

function maskText(text: string): string {
	// längste zuerst: enthält ein Secret ein anderes, bleibt kein Rest des längeren stehen
	for (const [value, label] of [...known].sort(([a], [b]) => b.length - a.length)) text = text.replaceAll(value, () => label);
	return text;
}

/**
 * Ersetzt bekannte Secret-Werte durch `[secret:<name>]` bzw. `[env:<NAME>]` — in Strings, Arrays, einfachen Objekten
 * (Werte und Schlüssel) und Errors (Meldung, Stack, cause, eigene Felder wie code/hint; der Typ bleibt). Das Original bleibt
 * unverändert. Pflicht für alles, was ein Agent oder der Browser später lesen kann: run_events-Payloads, Fehlermeldungen, Tool-Ergebnisse.
 */
export function mask<T>(value: T): T {
	if (typeof value === 'string') return maskText(value) as T;
	if (Array.isArray(value)) return value.map(mask) as T;
	if (value instanceof Error) {
		const copy = Object.assign(Object.create(Object.getPrototypeOf(value)), mask({ ...value }), {
			message: maskText(value.message),
			stack: value.stack && maskText(value.stack)
		});
		if ('cause' in value) copy.cause = mask(value.cause);
		return copy;
	}
	const proto = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
	if (proto === Object.prototype || proto === null)
		return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [maskText(k), mask(v)])) as T;
	return value;
}

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/**
 * Legt die Maskierung um console.* — jede Log-Zeile des Prozesses läuft hindurch, auch die von Bibliotheken und
 * SvelteKits Fehlerausgabe. Formatiert erst (Objekte, Errors samt cause), maskiert dann den fertigen Text.
 */
export function maskConsole(target: Pick<Console, (typeof LEVELS)[number]> = console): void {
	// ponytail: direkte Schreibzugriffe auf process.stdout/stderr (z. B. Nodes Ausgabe bei uncaughtException) laufen vorbei — Hook ergänzen, falls das relevant wird.
	for (const level of LEVELS) {
		const write = target[level].bind(target);
		target[level] = (...args: unknown[]) => write('%s', maskText(format(...args)));
	}
}

// ---- Store ----

/** Namen und Zeitstempel, nie Werte oder Chiffrate — das Einzige, was das UI von Secrets zu sehen bekommt. */
export const listSecrets = (db: DatabaseSync) =>
	db.prepare('SELECT name, created_at, updated_at FROM secrets ORDER BY name').all() as SecretMeta[];

/**
 * Speichert ein Secret verschlüsselt. Einen vorhandenen Namen überschreibt es nur mit `replace` — Ersetzen ist unwiderruflich
 * und muss ausdrücklich gewollt sein. Leerraum am Rand (Einfügen aus der Zwischenablage) fällt weg.
 * Fehlermeldungen nennen den eingegebenen Wert nie — auch keinen ungültigen Namen, falls dort versehentlich der Key landete.
 */
export function setSecret(db: DatabaseSync, name: string, value: string, replace = false, key = secretKey()): void {
	value = value.trim();
	if (name === value)
		throw new DomainError('secret_name_is_value', 'Name und Wert sind gleich.', 'Der Name ist überall im Klartext sichtbar — wähle eine Bezeichnung wie „anthropic-api-key“.');
	if (!NAME.test(name))
		throw new DomainError(
			'secret_name_invalid',
			'Der Name ist ungültig.',
			'Erlaubt sind 1–64 Zeichen aus a–z, 0–9, „-“ und „_“, beginnend mit Buchstabe oder Ziffer — z. B. „anthropic-api-key“.'
		);
	if (!value) throw new DomainError('secret_empty', 'Der Wert ist leer.', 'Füge den vollständigen Key bzw. Token ein.');
	if (value.length < MIN_LENGTH)
		throw new DomainError(
			'secret_too_short',
			`Der Wert hat nur ${value.length} Zeichen, nötig sind mindestens ${MIN_LENGTH}.`,
			'Prüfe, ob der Key vollständig eingefügt wurde. So kurze Werte lassen sich in Logs nicht sicher maskieren und gehören nicht in den Secret-Store.'
		);
	if (!replace && db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(name))
		throw new DomainError('secret_exists', `Secret „${name}“ gibt es schon.`, 'Nutze „Ersetzen“ beim vorhandenen Eintrag — der bisherige Wert geht dabei verloren.');

	const { ciphertext, iv, tag } = encrypt(key, name, value);
	db.prepare(
		`INSERT INTO secrets (name, ciphertext, iv, auth_tag) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE
		SET ciphertext = excluded.ciphertext, iv = excluded.iv, auth_tag = excluded.auth_tag, updated_at = CURRENT_TIMESTAMP`
	).run(name, ciphertext, iv, tag);
	remember(value, `[secret:${name}]`);
}

/** Löscht ein Secret. Idempotent: `false`, wenn es keins (mehr) gab. */
export const deleteSecret = (db: DatabaseSync, name: string) => db.prepare('DELETE FROM secrets WHERE name = ?').run(name).changes > 0;

function getSecret(db: DatabaseSync, name: string, key: Buffer): string {
	const row = db.prepare('SELECT name, ciphertext, iv, auth_tag FROM secrets WHERE name = ?').get(name) as Row | undefined;
	if (!row)
		throw new DomainError('secret_not_found', `Secret „${name}“ gibt es nicht.`, 'Lege es unter Einstellungen → Secrets an oder korrigiere den Verweis secret:<name>.');
	return remember(decrypt(key, row), `[secret:${name}]`);
}

/**
 * Die eine Stelle, die Verweise in Konfigurationswerten auflöst: `secret:<name>` (ganzer Wert) → entschlüsseltes Secret;
 * sonst wird jedes `${ENV_NAME}` durch die Umgebungsvariable ersetzt, übriger Text bleibt (`Bearer ${TOKEN}`).
 * Aufgelöste Werte gehen in die Maskierung.
 */
export function resolveRef(db: DatabaseSync, ref: string, key = secretKey()): string {
	if (ref.startsWith('secret:')) return getSecret(db, ref.slice('secret:'.length), key);
	return ref.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
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
 * Beim Start: Schlüssel laden bzw. erzeugen und alle Secrets für die Maskierung entschlüsseln. Nicht entschlüsselbare
 * werden gemeldet, brechen den Start aber nicht ab — sie lassen sich im UI ersetzen.
 */
export function initSecrets(db: DatabaseSync, key = secretKey()): void {
	for (const row of db.prepare('SELECT name, ciphertext, iv, auth_tag FROM secrets').all() as Row[]) {
		try {
			remember(decrypt(key, row), `[secret:${row.name}]`);
		} catch (err) {
			const e = err as DomainError;
			console.warn(`Warnung: ${e.message} ${e.hint}`);
		}
	}
}
