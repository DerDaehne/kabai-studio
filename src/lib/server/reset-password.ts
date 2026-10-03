// Recovery without UI: `npm run reset-password` sets a new owner password and ends all sessions.
// Runs directly under Node (type stripping, no build), also next to the running server (WAL + busy_timeout).
// Password: asked twice with hidden input in a terminal; from a pipe, the first line of stdin.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { hasOwner, hashPassword, passwordProblem, resetPassword } from './auth.ts';
import { dataDir, openDb } from './db.ts';

async function readPassword(): Promise<string> {
	if (!process.stdin.isTTY) {
		let input = '';
		for await (const chunk of process.stdin) input += chunk;
		return input.split(/\r?\n/)[0];
	}
	let muted = false;
	const output = new Writable({
		write(chunk, _enc, done) {
			if (!muted) process.stdout.write(chunk); // hidden input: suppress the echo
			done();
		}
	});
	const rl = createInterface({ input: process.stdin, output, terminal: true });
	const ask = async (prompt: string) => {
		process.stdout.write(prompt);
		muted = true;
		const answer = await rl.question('');
		muted = false;
		process.stdout.write('\n');
		return answer;
	};
	try {
		const password = await ask('Neues Passwort: ');
		if (password !== (await ask('Wiederholen: ')))
			throw new Error('Die Passwörter stimmen nicht überein — bitte erneut ausführen.');
		return password;
	} finally {
		rl.close();
	}
}

try {
	const file = join(dataDir(), 'studio.db');
	if (!existsSync(file))
		throw new Error(
			`Keine Datenbank unter ${file}. STUDIO_DATA_DIR auf das Datenverzeichnis des Servers setzen (oder den Server einmal starten) und erneut ausführen.`
		);
	const db = openDb(file);
	const owner = (() => {
		try {
			return hasOwner(db);
		} catch {
			return false; // DB older than the auth migration
		}
	})();
	if (!owner)
		throw new Error(
			'Noch kein Owner eingerichtet — nichts zurückzusetzen. Server starten und den Einrichtungslink aus der Konsole öffnen.'
		);

	const password = await readPassword();
	const problem = passwordProblem(password);
	if (problem) throw new Error(`${problem} Bitte erneut ausführen.`);
	resetPassword(db, await hashPassword(password));
	db.close();
	console.log(
		'Passwort gesetzt, alle Sessions beendet. Jetzt mit dem neuen Passwort unter /login anmelden.'
	);
} catch (err) {
	// SQLITE_BUSY (errcode 5): still locked despite busy_timeout — plain text instead of the raw SQLite message.
	const locked = (err as NodeJS.ErrnoException & { errcode?: number }).errcode === 5;
	console.error(
		locked
			? 'reset-password: Studio läuft gerade und schreibt; erneut versuchen.'
			: `reset-password: ${(err as Error).message}`
	);
	process.exitCode = 1;
}
