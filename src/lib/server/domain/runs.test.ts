import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import { subscribe, type StudioEvent } from '../events';
import { setSecret } from '../secrets';
import * as board from './board';
import { DomainError, type Actor } from './core';
import * as runs from './runs';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };
const LOCAL = {
	name: 'Lokal',
	executor: 'builtin',
	provider: 'openai-compatible',
	model: 'm'
} as const;
const SECRET_KEY = randomBytes(32); // eigener Schlüssel, damit der Test kein secret.key im Datenverzeichnis anlegt

const tmp = mkdtempSync(join(tmpdir(), 'studio-runs-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function setup(db = openDb(':memory:')) {
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const ticketId = board.createTicket(db, user, projectId, { title: 'T' }).id;
	const profileId = runs.createProfile(db, user, LOCAL).id;
	const queued = () => runs.createRun(db, system, { ticketId, profileId }).id;
	const running = () => {
		const id = queued();
		runs.startRun(db, system, id);
		return id;
	};
	const row = (id: number) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id)!;
	return { db, projectId, ticketId, profileId, queued, running, row };
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

const seqs = (db: ReturnType<typeof openDb>, runId: number) =>
	db
		.prepare('SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq')
		.all(runId)
		.map((r) => r.seq);

describe('Zustandsübergänge', () => {
	it('durchläuft queued → running → waiting_approval → running → succeeded', () => {
		const { db, ticketId, queued, row } = setup();
		const id = queued();
		const backlog = db
			.prepare('SELECT column_id FROM tickets WHERE id = ?')
			.get(ticketId)?.column_id;
		expect(row(id)).toMatchObject({
			state: 'queued',
			trigger: 'manual',
			column_id: backlog,
			token_hash: null,
			started_at: null
		});
		runs.startRun(db, system, id);
		expect(row(id).started_at).not.toBeNull();
		runs.setRunState(db, system, id, 'waiting_approval');
		runs.setRunState(db, system, id, 'running');
		runs.finishRun(db, system, id, { state: 'succeeded' });
		expect(row(id)).toMatchObject({ state: 'succeeded', token_hash: null });
		expect(row(id).finished_at).not.toBeNull();
	});

	it('weist ungültige Übergänge ab und nennt aktuellen Zustand und erlaubte Folgezustände', () => {
		const { db, queued, row } = setup();
		const id = queued();
		const early = caught(() => runs.finishRun(db, system, id, { state: 'succeeded' }));
		expect(early.code).toBe('invalid_run_transition');
		expect(early.message).toBe(
			'Run 1 ist „queued“ und kann mit finishRun nicht nach „succeeded“ wechseln. Erlaubt: running (startRun), cancelled (finishRun).'
		);
		// running ist ein erlaubter Folgezustand, aber nur startRun erzeugt dabei das Token
		expect(caught(() => runs.setRunState(db, system, id, 'running')).message).toContain(
			'kann mit setRunState nicht nach „running“ wechseln. Erlaubt: running (startRun)'
		);
		expect(row(id).state).toBe('queued');

		runs.startRun(db, system, id);
		expect(caught(() => runs.startRun(db, system, id)).message).toBe(
			'Run 1 ist „running“ und kann mit startRun nicht nach „running“ wechseln. Erlaubt: waiting_approval (setRunState), paused (finishRun), succeeded (finishRun), failed (finishRun), cancelled (finishRun).'
		);
		runs.setRunState(db, system, id, 'waiting_approval');
		expect(caught(() => runs.finishRun(db, system, id, { state: 'succeeded' })).message).toContain(
			'Erlaubt: running (setRunState), failed (finishRun), cancelled (finishRun).'
		);

		runs.finishRun(db, user, id, { state: 'cancelled' });
		const late = caught(() => runs.setRunState(db, system, id, 'running'));
		expect(late.message).toBe(
			'Run 1 ist bereits beendet („cancelled“) und kann nicht nach „running“ wechseln.'
		);
		expect(late.hint).toContain('createRun');
		expect(row(id).state).toBe('cancelled');

		runs.finishRun(db, user, queued(), { state: 'cancelled' }); // Abbruch vor dem Start
		expect(caught(() => runs.startRun(db, system, 99)).code).toBe('not_found');
	});

	it('paused beendet den Run; fortgesetzt wird nur ein pausierter Run desselben Tickets', () => {
		const { db, projectId, ticketId, profileId, running, row } = setup();
		const paused = running();
		runs.finishRun(db, system, paused, { state: 'paused' });
		expect(caught(() => runs.setRunState(db, system, paused, 'running')).code).toBe(
			'invalid_run_transition'
		);

		const next = runs.createRun(db, system, {
			ticketId,
			profileId,
			trigger: 'on_enter',
			resumedFromRunId: paused
		}).id;
		expect(row(next)).toMatchObject({
			state: 'queued',
			trigger: 'resume',
			resumed_from_run_id: paused
		});

		const done = running();
		runs.finishRun(db, system, done, { state: 'succeeded' });
		const err = caught(() =>
			runs.createRun(db, system, { ticketId, profileId, resumedFromRunId: done })
		);
		expect(err.code).toBe('invalid_resume');
		expect(err.message).toBe(
			'Fortsetzen geht nur mit einem pausierten Run von STU-1; Run 3 ist „succeeded“.'
		);
		const other = board.createTicket(db, user, projectId, { title: 'Anderes' }).id;
		expect(
			caught(() =>
				runs.createRun(db, system, { ticketId: other, profileId, resumedFromRunId: paused })
			).message
		).toContain('gehört zu einem anderen Ticket');
	});

	it('createRun prüft Ticket und Profil', () => {
		const { db, ticketId, profileId } = setup();
		expect(caught(() => runs.createRun(db, system, { ticketId, profileId: 99 })).code).toBe(
			'not_found'
		);
		expect(caught(() => runs.createRun(db, system, { ticketId: 99, profileId })).code).toBe(
			'not_found'
		);
		expect(db.prepare('SELECT count(*) AS n FROM runs').get()?.n).toBe(0);
	});
});

describe('Run-Token', () => {
	it('startRun gibt das Token einmal im Klartext zurück, gespeichert wird nur der SHA-256-Hash', () => {
		const { db, queued, row } = setup();
		const id = queued();
		const { token } = runs.startRun(db, system, id);
		expect(token).toMatch(/^[\w-]{43}$/);
		expect(row(id).token_hash).toBe(createHash('sha256').update(token).digest('hex'));
		const tables = db
			.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
			.all()
			.map((r) => r.name as string);
		for (const t of tables)
			expect(JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).not.toContain(token);
		expect(runs.startRun(db, system, queued()).token).not.toBe(token);
	});

	it('gilt, solange der Run läuft, und verfällt mit dem Ende', () => {
		const { db, projectId, ticketId, queued, row } = setup();
		const id = queued();
		const { token } = runs.startRun(db, system, id);
		expect(runs.runForToken(db, token)).toEqual({ runId: id, ticketId, projectId });
		runs.setRunState(db, system, id, 'waiting_approval');
		expect(runs.runForToken(db, token)?.runId).toBe(id);
		runs.finishRun(db, system, id, { state: 'failed', error: 'Modell nicht erreichbar' });
		expect(runs.runForToken(db, token)).toBeUndefined();
		expect(row(id)).toMatchObject({ token_hash: null, error: 'Modell nicht erreichbar' });
		expect(runs.runForToken(db, 'geraten')).toBeUndefined();
	});
});

describe('appendEvent', () => {
	it('vergibt seq lückenlos pro Run, auch bei schneller Folge über zwei Verbindungen und mit abgewiesenen Events dazwischen', () => {
		const file = join(tmp, 'seq.db');
		const { db, running } = setup(openDb(file));
		const other = openDb(file); // zweite Verbindung wie ein zweiter Schreiber
		const [a, b] = [running(), running()];
		const expected = { [a]: 0, [b]: 0 };
		for (let i = 0; i < 300; i++) {
			const conn = i % 2 ? db : other;
			const runId = i % 3 ? a : b;
			if (i % 50 === 7) {
				expect(() => runs.appendEvent(conn, system, runId, { type: 'chat' as never })).toThrow(
					/CHECK/
				); // abgewiesen → kein seq verbraucht
				continue;
			}
			const { seq } = runs.appendEvent(conn, system, runId, {
				type: 'message',
				payload: { i },
				key: `k${i}`
			});
			expect(seq).toBe(++expected[runId]);
		}
		const count = (id: number) => expected[id];
		expect(seqs(db, a)).toEqual(Array.from({ length: count(a) }, (_, i) => i + 1));
		expect(seqs(db, b)).toEqual(Array.from({ length: count(b) }, (_, i) => i + 1));
	});

	it('ist retry-sicher: derselbe Aufruf noch einmal erzeugt kein Duplikat, kein Bus-Event und keinen doppelten Verbrauch', () => {
		const { db, running, row } = setup();
		const id = running();
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));
		const call = {
			type: 'tool_call',
			payload: { tool: 'complete_task', args: { id: 3 } },
			key: 'call-1',
			usage: { tokensIn: 10 }
		} as const;
		expect(runs.appendEvent(db, system, id, call)).toEqual({ seq: 1, duplicate: false });
		expect(runs.appendEvent(db, system, id, call)).toEqual({ seq: 1, duplicate: true }); // z. B. nach Timeout wiederholt
		expect(
			runs.appendEvent(db, system, id, { type: 'tool_result', payload: { ok: true } })
		).toEqual({ seq: 2, duplicate: false });

		const conflict = caught(() =>
			runs.appendEvent(db, system, id, { ...call, payload: { tool: 'other' } })
		);
		expect(conflict.code).toBe('idempotency_conflict');
		expect(conflict.message).toBe(
			'Run 1 hat unter dem Schlüssel „call-1“ schon ein anderes Event (seq 1).'
		);

		runs.finishRun(db, system, id, { state: 'succeeded' });
		expect(runs.appendEvent(db, system, id, call)).toEqual({ seq: 1, duplicate: true }); // Retry über das Run-Ende hinweg
		off();
		expect(seqs(db, id)).toEqual([1, 2]);
		expect(events.filter((e) => e.type === 'run.event').map((e) => e.seq)).toEqual([1, 2]);
		expect(row(id).tokens_in).toBe(10);
	});

	it('maskiert bekannte Secret-Werte im Payload vor dem Speichern und Emittieren; Idempotenz bleibt korrekt (#819)', () => {
		const { db, running } = setup();
		const id = running();
		const SECRET = 'sk-test-appendevent-secret-123';
		setSecret(db, 'appendevent-test', SECRET, false, SECRET_KEY);

		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));
		const { seq } = runs.appendEvent(db, system, id, {
			type: 'tool_result',
			payload: { output: `token=${SECRET}` },
			key: 'evt-1'
		});
		off();

		const stored = db
			.prepare('SELECT payload FROM run_events WHERE run_id = ? AND seq = ?')
			.get(id, seq) as { payload: string };
		expect(stored.payload).not.toContain(SECRET);
		expect(stored.payload).toContain('[secret:appendevent-test]');
		expect(events.find((e) => e.type === 'run.event')).toMatchObject({
			payload: { output: 'token=[secret:appendevent-test]' }
		});

		// Wiederholter Aufruf mit gleichem Schlüssel bleibt idempotent — Vergleich läuft auf dem maskierten Payload.
		expect(
			runs.appendEvent(db, system, id, {
				type: 'tool_result',
				payload: { output: `token=${SECRET}` },
				key: 'evt-1'
			})
		).toEqual({ seq, duplicate: true });
	});

	it('nimmt Events nur von laufenden Runs an', () => {
		const { db, queued, running } = setup();
		const err = caught(() => runs.appendEvent(db, system, queued(), { type: 'log' }));
		expect(err.code).toBe('run_not_active');
		expect(err.hint).toContain('startRun');
		const id = running();
		runs.setRunState(db, system, id, 'waiting_approval');
		runs.appendEvent(db, system, id, { type: 'permission_decision', payload: { allow: true } });
		runs.finishRun(db, system, id, { state: 'cancelled' });
		expect(caught(() => runs.appendEvent(db, system, id, { type: 'log' })).message).toBe(
			'Run 2 ist „cancelled“ — Events nimmt nur ein laufender Run an.'
		);
	});
});

describe('Event-Bus', () => {
	it('jeder Run-Schritt und jedes Event erscheint nach dem COMMIT auf dem Bus, abgewiesene nicht', () => {
		const { db, projectId, ticketId, profileId } = setup();
		const events: StudioEvent[] = [];
		const inTx: boolean[] = [];
		const off = subscribe((e) => {
			events.push(e);
			inTx.push(db.isTransaction);
		});
		const id = runs.createRun(db, user, { ticketId, profileId }).id;
		runs.startRun(db, system, id);
		for (const text of ['a', 'b', 'c'])
			runs.appendEvent(db, system, id, { type: 'message', payload: { text } });
		expect(() => runs.appendEvent(db, system, id, { type: 'unbekannt' as never })).toThrow();
		runs.setRunState(db, system, id, 'waiting_approval');
		runs.setRunState(db, system, id, 'running');
		runs.finishRun(db, system, id, {
			state: 'succeeded',
			usage: { tokensIn: 5, tokensOut: 2, cost: 0.01 }
		});
		off();

		expect(
			events.map((e) => (e.type === 'run.state_changed' ? `${e.from}→${e.to}` : e.type))
		).toEqual([
			'run.created',
			'queued→running',
			'ticket.updated',
			'run.event',
			'run.event',
			'run.event',
			'running→waiting_approval',
			'waiting_approval→running',
			'running→succeeded'
		]);
		expect(
			events.every(
				(e) => e.projectId === projectId && e.ticketId === ticketId && e.runId === id && e.actor
			)
		).toBe(true);
		expect(inTx.every((t) => t === false)).toBe(true);
		expect(
			events.filter((e) => e.type === 'run.event').map((e) => [e.seq, e.eventType, e.payload])
		).toEqual([
			[1, 'message', { text: 'a' }],
			[2, 'message', { text: 'b' }],
			[3, 'message', { text: 'c' }]
		]);
		expect(events.at(-1)).toMatchObject({ tokensIn: 5, tokensOut: 2, cost: 0.01 });
	});
});

describe('finishRun', () => {
	it('summiert den Verbrauch aus den Events und dem Abschluss', () => {
		const { db, running, row } = setup();
		const id = running();
		runs.appendEvent(db, system, id, {
			type: 'message',
			usage: { tokensIn: 100, tokensOut: 20, cost: 0.5 }
		});
		runs.appendEvent(db, system, id, { type: 'tool_call', usage: { tokensIn: 50, tokensOut: 5 } });
		const totals = runs.finishRun(db, system, id, {
			state: 'succeeded',
			usage: { tokensIn: 1, tokensOut: 1, cost: 0.25 }
		});
		expect(totals).toEqual({ tokensIn: 151, tokensOut: 26, cost: 0.75 });
		expect(row(id)).toMatchObject({ tokens_in: 151, tokens_out: 26, cost: 0.75 });
	});

	it('failed braucht einen Fehlertext (DomainError statt rohem CHECK-Fehler)', () => {
		const { db, running, row } = setup();
		const id = running();
		for (const end of [{ state: 'failed' }, { state: 'failed', error: '  ' }] as never[]) {
			const err = caught(() => runs.finishRun(db, system, id, end));
			expect(err.code).toBe('error_required');
			expect(err.message).toBe('Run 1 als „failed“ beenden geht nur mit Fehlertext.');
			expect(err.hint).toContain('error');
		}
		expect(row(id).state).toBe('running');
	});

	it('maskiert bekannte Secret-Werte im Fehlertext vor dem Speichern (#824)', () => {
		const { db, running, row } = setup();
		const id = running();
		const SECRET = 'sk-test-finishrun-secret-456';
		setSecret(db, 'finishrun-test', SECRET, false, SECRET_KEY);

		runs.finishRun(db, system, id, {
			state: 'failed',
			error: `Provider-Fehler: Key ${SECRET} abgelehnt`
		});

		expect(row(id).error).toBe('Provider-Fehler: Key [secret:finishrun-test] abgelehnt');
		expect(row(id).error).not.toContain(SECRET);
	});
});

describe('Agent-Profile', () => {
	it('legt an, liest, ändert und löscht', () => {
		const { db, profileId } = setup();
		const id = runs.createProfile(db, user, {
			name: 'Claude',
			executor: 'builtin',
			provider: 'anthropic',
			model: 'x',
			api_key_ref: 'secret:anthropic',
			params: { temperature: 0.2 }
		}).id;
		expect(runs.getProfile(db, id)).toMatchObject({
			name: 'Claude',
			args: [],
			params: { temperature: 0.2 },
			permission_policy: {},
			api_key_ref: 'secret:anthropic'
		});
		runs.updateProfile(db, user, id, { model: 'y', api_key_ref: '${ANTHROPIC_API_KEY}' });
		expect(runs.getProfile(db, id)).toMatchObject({
			model: 'y',
			api_key_ref: '${ANTHROPIC_API_KEY}'
		});
		expect(runs.listProfiles(db).map((p) => p.id)).toEqual([id, profileId]); // nach Name
		runs.deleteProfile(db, user, id);
		expect(caught(() => runs.getProfile(db, id)).code).toBe('not_found');
		runs.createProfile(db, system, {
			name: 'Agent',
			executor: 'acp',
			command: 'agent',
			args: ['--acp']
		}); // Onboarding legt Defaults als system an
	});

	it('weist einen Klartext-Key ab, ohne ihn in der Meldung zu wiederholen', () => {
		const { db, profileId } = setup();
		for (const ref of ['sk-geheim-123', 'secret:', 'secret:mit leerzeichen', '${NICHT-ERLAUBT}']) {
			const err = caught(() => runs.updateProfile(db, user, profileId, { api_key_ref: ref }));
			expect(err.code).toBe('invalid_secret_ref');
			expect(err.message + err.hint).not.toContain('geheim');
		}
		expect(runs.getProfile(db, profileId).api_key_ref).toBeNull();
	});

	it('prüft Pflichtfelder je Executor, eindeutige Namen und unbekannte Felder', () => {
		const { db, profileId } = setup();
		expect(
			caught(() => runs.createProfile(db, user, { name: 'X', executor: 'builtin', provider: 'p' }))
				.message
		).toBe('Ein builtin-Profil braucht model.');
		expect(caught(() => runs.updateProfile(db, user, profileId, { executor: 'acp' })).message).toBe(
			'Ein acp-Profil braucht command.'
		);
		expect(caught(() => runs.createProfile(db, user, LOCAL)).code).toBe('name_taken');
		runs.updateProfile(db, user, profileId, { name: 'Lokal' }); // eigener Name ist kein Konflikt
		expect(
			caught(() => runs.updateProfile(db, user, profileId, { api_key: 'x' } as never)).code
		).toBe('unknown_field');
	});

	it('ein Agent darf Profile weder anlegen noch ändern noch löschen', () => {
		const { db, profileId } = setup();
		const agent: Actor = { kind: 'agent', runId: 1 };
		expect(caught(() => runs.createProfile(db, agent, { ...LOCAL, name: 'Meins' })).code).toBe(
			'requires_human'
		);
		expect(
			caught(() =>
				runs.updateProfile(db, agent, profileId, { permission_policy: { shell: 'allow' } })
			).code
		).toBe('requires_human');
		expect(caught(() => runs.deleteProfile(db, agent, profileId)).code).toBe('requires_human');
		expect(runs.getProfile(db, profileId).permission_policy).toEqual({});
	});

	it('Löschen nur ohne aktive Runs (queued, running, waiting_approval); beendete Runs behalten ihren Verlauf', () => {
		const { db, profileId, queued, running, row } = setup();
		const [waiting, active, approval] = [queued(), running(), running()];
		runs.setRunState(db, system, approval, 'waiting_approval');
		const err = caught(() => runs.deleteProfile(db, user, profileId));
		expect(err.code).toBe('profile_in_use');
		expect(err.message).toBe('Profil „Lokal“ wird von aktiven Runs genutzt: 1, 2, 3.');
		runs.finishRun(db, system, active, { state: 'succeeded' });
		runs.finishRun(db, user, approval, { state: 'cancelled' });
		// ein wartender Run sperrt allein: ohne Profil könnte der Runner ihn nicht mehr starten
		expect(caught(() => runs.deleteProfile(db, user, profileId)).message).toBe(
			'Profil „Lokal“ wird von aktiven Runs genutzt: 1.'
		);
		runs.finishRun(db, user, waiting, { state: 'cancelled' });
		runs.deleteProfile(db, user, profileId);
		expect(row(active)).toMatchObject({ state: 'succeeded', agent_profile_id: null });
	});
});

describe('Kommentare', () => {
	it('ein Agent-Kommentar trägt die Run-ID, ein Menschen-Kommentar keine', () => {
		const { db, ticketId, running } = setup();
		const id = running();
		board.addComment(db, { kind: 'agent', runId: id }, ticketId, 'erledigt');
		board.addComment(db, user, ticketId, 'danke');
		expect(db.prepare('SELECT author, run_id FROM comments ORDER BY id').all()).toEqual([
			{ author: 'agent (Run 1)', run_id: id },
			{ author: 'user', run_id: null }
		]);
	});
});

describe('assignee', () => {
	it('makes a starting run the assignee of its ticket, whether started directly or claimed by the runner', () => {
		const { db, ticketId, queued, profileId } = setup();
		const assignee = () =>
			db.prepare('SELECT assignee FROM tickets WHERE id = ?').get(ticketId)?.assignee;
		const first = queued();
		expect(assignee()).toBeNull();
		runs.startRun(db, system, first);
		expect(assignee()).toBe(`agent (Run ${first})`);

		const second = runs.createRun(db, system, { ticketId, profileId }).id;
		expect(runs.claimRun(db, system, { global: 4, pools: { local: 2 } })?.id).toBe(second);
		expect(assignee()).toBe(`agent (Run ${second})`);
	});
});
