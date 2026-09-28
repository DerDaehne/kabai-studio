// Recovery ohne UI: `npm run reset-password` setzt das Owner-Passwort neu und beendet alle Sessions.
// Läuft direkt mit Node (Type-Stripping, kein Build) und auch neben dem laufenden Server (WAL + busy_timeout).
// Passwort: im Terminal verdeckt zweimal abgefragt; bei einer Pipe die erste Zeile von stdin.
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
			if (!muted) process.stdout.write(chunk); // verdeckte Eingabe: Echo unterdrücken
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
		if (password !== (await ask('Wiederholen: '))) throw new Error('Die Passwörter stimmen nicht überein.');
		return password;
	} finally {
		rl.close();
	}
}

try {
	const file = join(dataDir(), 'studio.db');
	if (!existsSync(file)) throw new Error(`Keine Datenbank unter ${file} (STUDIO_DATA_DIR prüfen).`);
	const db = openDb(file);
	const owner = (() => {
		try {
			return hasOwner(db);
		} catch {
			return false; // DB älter als die Auth-Migration
		}
	})();
	if (!owner) throw new Error('Noch kein Owner eingerichtet — Server starten und /setup aufrufen.');

	const password = await readPassword();
	const problem = passwordProblem(password);
	if (problem) throw new Error(problem);
	resetPassword(db, await hashPassword(password));
	db.close();
	console.log('Passwort gesetzt, alle Sessions beendet.');
} catch (err) {
	console.error(`reset-password: ${(err as Error).message}`);
	process.exitCode = 1;
}
