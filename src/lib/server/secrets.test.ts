import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from './db';
import { DomainError } from './domain/core';
import { deleteSecret, listSecrets, loadKey, mask, maskConsole, resolveRef, setSecret } from './secrets';

const tmp = mkdtempSync(join(tmpdir(), 'studio-secrets-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Nur offensichtliche Testwerte.
const KEY = randomBytes(32);
const OTHER = randomBytes(32);
const VALUE = 'test-token-0123456789';
const MASKED = 'test-mask-value-42'; // eigener Wert: dieselbe Zeichenkette unter mehreren Namen trüge den zuletzt gemerkten

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	return db;
}

function caught(fn: () => unknown): DomainError {
	try {
		fn();
	} catch (err) {
		if (err instanceof DomainError) return err;
		throw err;
	}
	throw new Error('DomainError erwartet');
}

const row = (db: ReturnType<typeof setup>, name: string) =>
	db.prepare('SELECT ciphertext, iv, auth_tag FROM secrets WHERE name = ?').get(name) as Record<string, Uint8Array>;

describe('Store', () => {
	it('set/get-Roundtrip; in der DB steht nur Chiffrat, jeder Wert mit frischem IV', () => {
		const db = setup();
		setSecret(db, 'a', `  ${VALUE}\n`, false, KEY); // Leerraum vom Einfügen fällt weg
		setSecret(db, 'b', VALUE, false, KEY);
		expect(resolveRef(db, 'secret:a', KEY)).toBe(VALUE);
		expect(Buffer.from(row(db, 'a').ciphertext).includes(VALUE)).toBe(false);
		expect(Buffer.from(row(db, 'a').iv).equals(row(db, 'b').iv)).toBe(false);
	});

	it('falscher Schlüssel → sauberer Fehler mit Ausweg statt Datenmüll', () => {
		const db = setup();
		setSecret(db, 'a', VALUE, false, KEY);
		const err = caught(() => resolveRef(db, 'secret:a', OTHER));
		expect(err.code).toBe('secret_undecryptable');
		expect(err.hint).toMatch(/wiederherstellen|ersetzen/);
		expect(`${err.message} ${err.hint}`).not.toContain(VALUE);
	});

	it('weist verändertes oder unter anderen Namen kopiertes Chiffrat ab (Auth-Tag, Name als AAD)', () => {
		const db = setup();
		setSecret(db, 'a', VALUE, false, KEY);
		setSecret(db, 'b', 'other-value-abcdef', false, KEY);
		db.exec(`UPDATE secrets SET (ciphertext, iv, auth_tag) = (SELECT ciphertext, iv, auth_tag FROM secrets WHERE name = 'a') WHERE name = 'b'`);
		expect(caught(() => resolveRef(db, 'secret:b', KEY)).code).toBe('secret_undecryptable');
		const c = Buffer.from(row(db, 'a').ciphertext);
		c[0] ^= 1;
		db.prepare(`UPDATE secrets SET ciphertext = ? WHERE name = 'a'`).run(c);
		expect(caught(() => resolveRef(db, 'secret:a', KEY)).code).toBe('secret_undecryptable');
	});

	it('ungültige Eingaben: Fehler mit Code und Ausweg, ohne den eingegebenen Wert zu nennen', () => {
		const db = setup();
		const cases: [name: string, value: string, code: string, leak: string][] = [
			[VALUE.toUpperCase(), 'some-value-123', 'secret_name_invalid', VALUE.toUpperCase()], // Key versehentlich ins Namensfeld
			[VALUE, VALUE, 'secret_name_is_value', VALUE], // Key in beiden Feldern: wäre als Name überall sichtbar
			['a', '  \n', 'secret_empty', '\n'],
			['a', 'kurz12', 'secret_too_short', 'kurz12']
		];
		for (const [name, value, code, leak] of cases) {
			const err = caught(() => setSecret(db, name, value, false, KEY));
			expect(err.code).toBe(code);
			expect(err.hint.length).toBeGreaterThan(20); // Ausweg, nicht nur „Fehler“
			expect(`${err.message} ${err.hint}`).not.toContain(leak);
		}
		expect(listSecrets(db)).toEqual([]);
	});

	it('überschreibt nur ausdrücklich (replace), Ersetzen hält den neuen Wert', () => {
		const db = setup();
		setSecret(db, 'a', VALUE, false, KEY);
		expect(caught(() => setSecret(db, 'a', 'second-value-xyz', false, KEY)).code).toBe('secret_exists');
		expect(resolveRef(db, 'secret:a', KEY)).toBe(VALUE);
		setSecret(db, 'a', 'second-value-xyz', true, KEY);
		expect(resolveRef(db, 'secret:a', KEY)).toBe('second-value-xyz');
	});

	it('listSecrets liefert nur Namen und Zeitstempel; deleteSecret ist idempotent', () => {
		const db = setup();
		setSecret(db, 'a', VALUE, false, KEY);
		expect(listSecrets(db).map((s) => Object.keys(s).sort())).toEqual([['created_at', 'name', 'updated_at']]);
		expect(deleteSecret(db, 'a')).toBe(true);
		expect(deleteSecret(db, 'a')).toBe(false);
		expect(caught(() => resolveRef(db, 'secret:a', KEY)).code).toBe('secret_not_found');
	});

	it('die DB erzwingt Namensregel und Längen von IV/Auth-Tag', () => {
		const db = setup();
		const insert = (name: string, iv: number, tag: number) =>
			db.prepare('INSERT INTO secrets (name, ciphertext, iv, auth_tag) VALUES (?, ?, ?, ?)').run(name, Buffer.from('x'), Buffer.alloc(iv), Buffer.alloc(tag));
		expect(() => insert('Gross', 12, 16)).toThrow(/CHECK/);
		expect(() => insert('mit leer', 12, 16)).toThrow(/CHECK/);
		expect(() => insert('ok', 11, 16)).toThrow(/CHECK/);
		expect(() => insert('ok', 12, 8)).toThrow(/CHECK/);
		expect(() => insert('ok-name_1', 12, 16)).not.toThrow();
	});
});

describe('Schlüssel', () => {
	it('secret.key entsteht mit Rechten 0600 und bleibt beim nächsten Start derselbe', () => {
		const dir = join(tmp, 'fresh');
		const key = loadKey(dir, undefined);
		const file = join(dir, 'secret.key');
		// Reihenfolge bewusst: erst lesen (Nutzung), dann die Rechte prüfen — vermeidet das
		// Check-then-use-Muster (stat vor read auf demselben Pfad), das CodeQL js/file-system-race meldet.
		expect(readFileSync(file, 'utf8').trim()).toBe(key.toString('base64'));
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(key.length).toBe(32);
		expect(loadKey(dir, undefined).equals(key)).toBe(true);
	});

	it('der Schlüssel selbst wird maskiert — aus der Datei wie aus STUDIO_SECRET_KEY', () => {
		const fileKey = loadKey(join(tmp, 'masked-key'), undefined).toString('base64');
		const envKey = randomBytes(32).toString('base64');
		loadKey(join(tmp, 'unused'), ` ${envKey}\n`);
		expect(mask(`file=${fileKey} env=${envKey}`)).toBe('file=[secret-key] env=[secret-key]');
	});

	it('STUDIO_SECRET_KEY hat Vorrang vor secret.key und legt keine Datei an', () => {
		const withFile = join(tmp, 'fresh-env');
		const fileKey = loadKey(withFile, undefined);
		expect(loadKey(withFile, KEY.toString('base64')).equals(KEY)).toBe(true);
		expect(fileKey.equals(KEY)).toBe(false);
		const noFile = join(tmp, 'env-only');
		expect(loadKey(noFile, KEY.toString('base64')).equals(KEY)).toBe(true);
		expect(existsSync(join(noFile, 'secret.key'))).toBe(false);
	});

	it('ungültiger Schlüssel (Env leer/falsch, Datei kaputt) → Fehler mit Ausweg, ohne den Wert zu nennen', () => {
		for (const env of ['', 'kein-base64-schluessel', randomBytes(16).toString('base64')]) {
			const err = caught(() => loadKey(join(tmp, 'unused'), env));
			expect(err.code).toBe('secret_key_invalid');
			expect(err.hint).toContain('openssl rand -base64 32');
			if (env) expect(`${err.message} ${err.hint}`).not.toContain(env);
		}
		const broken = join(tmp, 'broken');
		mkdirSync(broken);
		writeFileSync(join(broken, 'secret.key'), 'kaputt\n');
		const err = caught(() => loadKey(broken, undefined));
		expect(err.code).toBe('secret_key_invalid');
		expect(err.hint).toContain('Backup');
		expect(readFileSync(join(broken, 'secret.key'), 'utf8')).toBe('kaputt\n'); // nie überschrieben
	});

	it('warnt, wenn secret.key für andere lesbar ist', () => {
		const dir = join(tmp, 'open');
		loadKey(dir, undefined);
		chmodSync(join(dir, 'secret.key'), 0o644);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		loadKey(dir, undefined);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('chmod 600'));
		warn.mockRestore();
	});
});

describe('Verweise', () => {
	it('löst secret:<name> und ${ENV} an einer Stelle auf, übriger Text bleibt', () => {
		const db = setup();
		setSecret(db, 'gh', VALUE, false, KEY);
		process.env.TEST_API_TOKEN = 'env-token-abcdef';
		expect(resolveRef(db, 'secret:gh', KEY)).toBe(VALUE);
		expect(resolveRef(db, 'Bearer ${TEST_API_TOKEN}', KEY)).toBe('Bearer env-token-abcdef');
		expect(resolveRef(db, 'plain value', KEY)).toBe('plain value');
		const err = caught(() => resolveRef(db, '${TEST_MISSING_VAR}', KEY));
		expect(err.code).toBe('env_missing');
		expect(err.hint).toContain('secret:<name>');
	});

	it('verweigert Studio-Interna: ${STUDIO_SECRET_KEY} (auch klein geschrieben) liefert nie den Schlüssel', () => {
		const db = setup();
		const before = process.env.STUDIO_SECRET_KEY;
		process.env.STUDIO_SECRET_KEY = KEY.toString('base64');
		try {
			for (const ref of ['${STUDIO_SECRET_KEY}', 'Bearer ${studio_secret_key}', '${STUDIO_DATA_DIR}']) {
				const err = caught(() => resolveRef(db, ref, KEY));
				expect(err.code).toBe('env_forbidden');
				expect(err.hint).toContain('secret:<name>');
				expect(`${err.message} ${err.hint}`).not.toContain(KEY.toString('base64'));
			}
		} finally {
			if (before === undefined) delete process.env.STUDIO_SECRET_KEY;
			else process.env.STUDIO_SECRET_KEY = before;
		}
	});

	it('nennt im Fehler nur gültige Secret-Namen — ein versehentlich eingefügter Key wird nicht wiederholt', () => {
		const db = setup();
		expect(caught(() => resolveRef(db, 'secret:fehlt', KEY)).message).toContain('„fehlt“');
		const pasted = 'sk-Test_NotARealKey.123';
		const err = caught(() => resolveRef(db, `secret:${pasted}`, KEY));
		expect(err.code).toBe('secret_ref_invalid');
		expect(err.hint).toContain('secret:anthropic-api-key');
		expect(`${err.message} ${err.hint}`).not.toContain(pasted);
	});
});

describe('Maskierung', () => {
	const db = setup();
	setSecret(db, 'anthropic', MASKED, false, KEY);

	it('ersetzt Secret-Werte in einem Event-Payload (verschachtelt, Arrays, Schlüssel), Original bleibt', () => {
		const payload = { type: 'tool_result', data: { output: `key=${MASKED};`, args: [MASKED, 1], [MASKED]: true }, seq: 3, none: null };
		const masked = mask(payload);
		expect(JSON.stringify(masked)).not.toContain(MASKED);
		expect(masked).toEqual({
			type: 'tool_result',
			data: { output: 'key=[secret:anthropic];', args: ['[secret:anthropic]', 1], '[secret:anthropic]': true },
			seq: 3,
			none: null
		});
		expect(payload.data.output).toContain(MASKED);
	});

	it('maskiert per ${ENV} aufgelöste Werte und mehrzeilige Werte auch in escapter Form', () => {
		process.env.TEST_API_TOKEN = 'env-token-abcdef';
		resolveRef(db, '${TEST_API_TOKEN}', KEY);
		expect(mask('Authorization: Bearer env-token-abcdef')).toBe('Authorization: Bearer [env:TEST_API_TOKEN]');
		const pem = '-----BEGIN TEST-----\nnot-a-real-key\n-----END TEST-----';
		setSecret(db, 'pem', pem, false, KEY);
		expect(mask(JSON.stringify({ pem }))).toBe('{"pem":"[secret:pem]"}');
	});

	it('längste Werte zuerst: enthält ein Secret ein anderes, bleibt vom längeren nichts stehen', () => {
		setSecret(db, 'inner', 'test-inner-value-1', false, KEY); // zuerst gemerkt
		setSecret(db, 'outer', 'outer-start-test-inner-value-1-outer-end', false, KEY);
		expect(mask('x outer-start-test-inner-value-1-outer-end y')).toBe('x [secret:outer] y');
	});

	it('Nicht-Plain-Objekte (URL, Date, Klasseninstanz, Map) laufen über ihre JSON- bzw. inspect-Form; Zyklen werfen nicht', () => {
		class Client {
			readonly apiKey: string;
			constructor(apiKey: string) {
				this.apiKey = apiKey;
			}
		}
		const holder = { url: new URL(`https://api.example.test/v1?key=${MASKED}`), client: new Client(MASKED), at: new Date(0) };
		const masked = mask(holder);
		expect(JSON.stringify(masked)).not.toContain(MASKED);
		expect(masked.url).toBe('https://api.example.test/v1?key=[secret:anthropic]');
		expect(masked.client).toEqual({ apiKey: '[secret:anthropic]' });
		expect(masked.at).toBe('1970-01-01T00:00:00.000Z');
		expect(holder.url).toBeInstanceOf(URL); // Original unverändert

		const big = { n: 1n, s: MASKED }; // ohne JSON-Form → inspect-Text
		expect(mask([new Map([['k', MASKED]]), { inner: Object.assign(Object.create({}), big) }])).toEqual([{}, { inner: expect.stringContaining('[secret:anthropic]') }]);

		const cyclic: Record<string, unknown> = { s: MASKED };
		cyclic.self = cyclic;
		const shared = { s: MASKED };
		expect(mask({ cyclic, a: shared, b: shared })).toEqual({
			cyclic: { s: '[secret:anthropic]', self: '[Circular]' },
			a: { s: '[secret:anthropic]' },
			b: { s: '[secret:anthropic]' } // mehrfach verwendet ist kein Zyklus
		});
		const err = new Error(`kaputt ${MASKED}`);
		(err as { cause?: unknown }).cause = err;
		expect(() => mask(err)).not.toThrow();
		expect(mask(err).message).toBe('kaputt [secret:anthropic]');
	});

	it('greift in Fehlermeldungen: Meldung, Stack, cause und code/hint — der Fehlertyp bleibt', () => {
		const plain = mask(new Error(`401 für Key ${MASKED}`, { cause: new Error(`Upstream: ${MASKED}`) }));
		expect(plain.message).toBe('401 für Key [secret:anthropic]');
		expect(plain.stack).not.toContain(MASKED);
		expect((plain.cause as Error).message).toBe('Upstream: [secret:anthropic]');
		const domain = mask(new DomainError('provider_failed', `Abgelehnt: ${MASKED}`, `Prüfe ${MASKED}`));
		expect(domain).toBeInstanceOf(DomainError);
		expect([domain.code, domain.message, domain.hint]).toEqual(['provider_failed', 'Abgelehnt: [secret:anthropic]', 'Prüfe [secret:anthropic]']);
	});

	it('greift in Log-Zeilen: console.* formatiert erst und maskiert dann (auch Objekte, Errors, mehrzeilige Werte)', () => {
		const out: string[] = [];
		const sink = (...args: unknown[]) => out.push(args.join('|'));
		const fake = { log: sink, info: sink, warn: sink, error: sink, debug: sink };
		maskConsole(fake);
		fake.error('Fehler:', new Error(`kaputt ${MASKED}`), { headers: { authorization: MASKED } });
		fake.log('%s und %d%%', MASKED, 5);
		fake.warn({ pem: '-----BEGIN TEST-----\nnot-a-real-key\n-----END TEST-----' });
		expect(out.join('\n')).not.toContain(MASKED);
		expect(out.join('\n')).not.toContain('not-a-real-key');
		expect(out[0]).toMatch(/^%s\|Fehler: Error: kaputt \[secret:anthropic\]/);
		expect(out[1]).toBe('%s|[secret:anthropic] und 5%');
	});
});

describe('initSecrets', () => {
	it('lädt gespeicherte Secrets für die Maskierung und meldet nicht entschlüsselbare ohne Wert', async () => {
		const db = setup();
		setSecret(db, 'ok', 'stored-before-restart', false, KEY);
		setSecret(db, 'fremd', 'stored-with-other-key', false, OTHER);
		vi.resetModules(); // wie ein Neustart: leere Maskierungsliste
		const fresh = await import('./secrets');
		expect(fresh.mask('stored-before-restart')).toBe('stored-before-restart');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		fresh.initSecrets(db, KEY);
		expect(fresh.mask('x stored-before-restart')).toBe('x [secret:ok]');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain('„fremd“');
		expect(warn.mock.calls[0][0]).not.toContain('stored-with-other-key');
		warn.mockRestore();
	});
});
