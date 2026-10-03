import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { format, inspect } from 'node:util';
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
	new DomainError(
		'secret_key_invalid',
		`${what} ist kein gültiger Schlüssel (erwartet: 32 Bytes als Base64, 44 Zeichen).`,
		hint
	);

/**
 * Lädt den Schlüssel: `STUDIO_SECRET_KEY` hat Vorrang, sonst `<dir>/secret.key` — fehlt die Datei, wird sie mit Rechten 0600
 * erzeugt. Beide enthalten denselben Base64-Text, der Schlüssel lässt sich also zwischen Datei und Env umziehen.
 */
export function loadKey(dir = dataDir(), env = process.env[KEY_ENV]): Buffer {
	if (env !== undefined) {
		// auch leer ist ein Fehler: sonst entstünde still eine neue secret.key, und die gespeicherten Secrets wären unlesbar
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
		console.warn(
			`Warnung: ${file} ist für andere Nutzer lesbar — „chmod 600 ${file}“ schränkt das ein.`
		);
	return keyFrom(text);
}

/** Base64-Text → Schlüssel. Der Text selbst geht in die Maskierung: auch der Schlüssel darf in keinem Log auftauchen. */
const keyFrom = (text: string) => Buffer.from(remember(text, '[secret-key]'), 'base64');

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
		const decipher = createDecipheriv('aes-256-gcm', key, row.iv, { authTagLength: 16 }).setAAD(
			Buffer.from(row.name)
		);
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
	if (value.length >= MIN_LENGTH)
		for (const v of [value, JSON.stringify(value).slice(1, -1)]) known.set(v, label);
	return value;
}

function maskText(text: string): string {
	// längste zuerst: enthält ein Secret ein anderes, bleibt kein Rest des längeren stehen
	for (const [value, label] of [...known].sort(([a], [b]) => b.length - a.length))
		text = text.replaceAll(value, () => label);
	return text;
}

/**
 * Ersetzt bekannte Secret-Werte durch `[secret:<name>]`, `[env:<NAME>]` bzw. `[secret-key]` — in Strings, Arrays, einfachen
 * Objekten (Werte und Schlüssel) und Errors (Meldung, Stack, cause, eigene Felder wie code/hint; der Typ bleibt). Andere Objekte
 * (URL, Date, Map, Klasseninstanzen) kommen in ihrer JSON-Form zurück — so, wie sie gespeichert würden —, ohne JSON-Form als
 * maskierter inspect-Text; Zyklen werden zu `[Circular]`. Das Original bleibt unverändert.
 * Pflicht für alles, was ein Agent oder der Browser später lesen kann: run_events-Payloads, Fehlermeldungen, Tool-Ergebnisse.
 * Gleichwertig für schon serialisierte Payloads: `mask(JSON.stringify(payload))` (die JSON-escapte Form ist mit gemerkt).
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
		parents.delete(value); // nur Vorfahren zählen: dasselbe Objekt zweimal nebeneinander ist kein Zyklus
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
	db
		.prepare('SELECT name, created_at, updated_at FROM secrets ORDER BY name')
		.all() as SecretMeta[];

/**
 * Speichert ein Secret verschlüsselt. Einen vorhandenen Namen überschreibt es nur mit `replace` — Ersetzen ist unwiderruflich
 * und muss ausdrücklich gewollt sein. Leerraum am Rand (Einfügen aus der Zwischenablage) fällt weg.
 * Fehlermeldungen nennen den eingegebenen Wert nie — auch keinen ungültigen Namen, falls dort versehentlich der Key landete.
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

/** Löscht ein Secret. Idempotent: `false`, wenn es keins (mehr) gab. */
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
			: // kein gültiger Name, vielleicht ein versehentlich eingefügter Key: nicht wiederholen
				new DomainError(
					'secret_ref_invalid',
					'Der Verweis secret:<name> enthält keinen gültigen Secret-Namen.',
					`Namen bestehen aus 1–64 Zeichen a–z, 0–9, „-“ und „_“ — z. B. secret:anthropic-api-key. Steht dort der Key selbst, speichere ihn unter Einstellungen → Secrets und verweise auf seinen Namen.`
				);
	return remember(decrypt(key, row), `[secret:${name}]`);
}

/**
 * Die eine Stelle, die Verweise in Konfigurationswerten auflöst: `secret:<name>` (ganzer Wert) → entschlüsseltes Secret;
 * sonst wird jedes `${ENV_NAME}` durch die Umgebungsvariable ersetzt, übriger Text bleibt (`Bearer ${TOKEN}`).
 * Aufgelöste Werte gehen in die Maskierung. `${STUDIO_*}` wird verweigert (Schlüssel und andere Interna).
 */
export function resolveRef(db: DatabaseSync, ref: string, key = secretKey()): string {
	if (ref.startsWith('secret:')) return getSecret(db, ref.slice('secret:'.length), key);
	return ref.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
		// Studio-Interna (allen voran STUDIO_SECRET_KEY) gehen nie an Provider oder MCP-Server; i: Windows-Env ignoriert Groß/klein
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
 * Beim Start: Schlüssel laden bzw. erzeugen und alle Secrets für die Maskierung entschlüsseln. Nicht entschlüsselbare
 * werden gemeldet, brechen den Start aber nicht ab — sie lassen sich im UI ersetzen.
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
