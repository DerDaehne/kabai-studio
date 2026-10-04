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
const SECRET_KEY = randomBytes(32); // a key of its own, so the test creates no secret.key in the data directory

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

describe('state transitions', () => {
	it('goes through queued → running → waiting_approval → running → succeeded', () => {
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

	it('rejects invalid transitions and names the current state and the allowed next states', () => {
		const { db, queued, row } = setup();
		const id = queued();
		const early = caught(() => runs.finishRun(db, system, id, { state: 'succeeded' }));
		expect(early.code).toBe('invalid_run_transition');
		expect(early.message).toBe(
			'Run 1 ist „queued“ und kann mit finishRun nicht nach „succeeded“ wechseln. Erlaubt: running (startRun), cancelled (finishRun).'
		);
		// running is an allowed next state, but only startRun creates the token on the way
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
			'Erlaubt: running (setRunState), paused (finishRun), failed (finishRun), cancelled (finishRun).'
		);

		runs.finishRun(db, user, id, { state: 'cancelled' });
		const late = caught(() => runs.setRunState(db, system, id, 'running'));
		expect(late.message).toBe(
			'Run 1 ist bereits beendet („cancelled“) und kann nicht nach „running“ wechseln.'
		);
		expect(late.hint).toContain('createRun');
		expect(row(id).state).toBe('cancelled');

		runs.finishRun(db, user, queued(), { state: 'cancelled' }); // cancelled before the start
		expect(caught(() => runs.startRun(db, system, 99)).code).toBe('not_found');
	});

	it('ends the run on paused and resumes only a paused run of the same ticket', () => {
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

	it('checks ticket and profile in createRun', () => {
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

describe('run token', () => {
	it('returns the token once in plain text from startRun and stores only its SHA-256 hash', () => {
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

	it('is valid while the run is active and expires with its end', () => {
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
	it('assigns seq without gaps per run, even in quick succession over two connections and with rejected events in between', () => {
		const file = join(tmp, 'seq.db');
		const { db, running } = setup(openDb(file));
		const other = openDb(file); // a second connection like a second writer
		const [a, b] = [running(), running()];
		const expected = { [a]: 0, [b]: 0 };
		for (let i = 0; i < 300; i++) {
			const conn = i % 2 ? db : other;
			const runId = i % 3 ? a : b;
			if (i % 50 === 7) {
				expect(() => runs.appendEvent(conn, system, runId, { type: 'chat' as never })).toThrow(
					/CHECK/
				); // rejected → no seq used up
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

	it('is retry-safe: the same call again creates no duplicate, no bus event and no double usage', () => {
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
		expect(runs.appendEvent(db, system, id, call)).toEqual({ seq: 1, duplicate: true }); // e.g. repeated after a timeout
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
		expect(runs.appendEvent(db, system, id, call)).toEqual({ seq: 1, duplicate: true }); // a retry after the run has ended
		off();
		expect(seqs(db, id)).toEqual([1, 2]);
		expect(events.filter((e) => e.type === 'run.event').map((e) => e.seq)).toEqual([1, 2]);
		expect(row(id).tokens_in).toBe(10);
	});

	it('masks known secret values in the payload before storing and emitting, and stays idempotent', () => {
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

		// A repeated call with the same key stays idempotent, because the comparison runs on the masked payload.
		expect(
			runs.appendEvent(db, system, id, {
				type: 'tool_result',
				payload: { output: `token=${SECRET}` },
				key: 'evt-1'
			})
		).toEqual({ seq, duplicate: true });
	});

	it('accepts events only from active runs', () => {
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

describe('event bus', () => {
	it('publishes every run step and event on the bus after COMMIT, and rejected ones not at all', () => {
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

	it('names the key of a run event on the bus, so a live trace pairs a tool result with its call', () => {
		const { db, running } = setup();
		const id = running();
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));
		runs.appendEvent(db, system, id, { type: 'tool_result', key: 'call-1:result', payload: {} });
		runs.appendEvent(db, system, id, { type: 'log', payload: {} });
		off();
		expect(events.map((e) => e.key)).toEqual(['call-1:result', undefined]);
	});
});

describe('finishRun', () => {
	it('sums the usage of the events and the finish', () => {
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

	it('requires an error text for failed (a DomainError instead of a raw CHECK error)', () => {
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

	it('masks known secret values in the error text before storing it', () => {
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

describe('agent profiles', () => {
	it('creates, reads, updates and deletes', () => {
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
		expect(runs.listProfiles(db).map((p) => p.id)).toEqual([id, profileId]); // by name
		runs.deleteProfile(db, user, id);
		expect(caught(() => runs.getProfile(db, id)).code).toBe('not_found');
		runs.createProfile(db, system, {
			name: 'Agent',
			executor: 'acp',
			command: 'agent',
			args: ['--acp']
		}); // onboarding creates the defaults as system
	});

	it('rejects a plain-text key without repeating it in the message', () => {
		const { db, profileId } = setup();
		for (const ref of ['sk-geheim-123', 'secret:', 'secret:mit leerzeichen', '${NICHT-ERLAUBT}']) {
			const err = caught(() => runs.updateProfile(db, user, profileId, { api_key_ref: ref }));
			expect(err.code).toBe('invalid_secret_ref');
			expect(err.message + err.hint).not.toContain('geheim');
		}
		expect(runs.getProfile(db, profileId).api_key_ref).toBeNull();
	});

	it('checks required fields per executor, unique names and unknown fields', () => {
		const { db, profileId } = setup();
		expect(
			caught(() => runs.createProfile(db, user, { name: 'X', executor: 'builtin', provider: 'p' }))
				.message
		).toBe('Ein builtin-Profil braucht model.');
		expect(caught(() => runs.updateProfile(db, user, profileId, { executor: 'acp' })).message).toBe(
			'Ein acp-Profil braucht command.'
		);
		expect(caught(() => runs.createProfile(db, user, LOCAL)).code).toBe('name_taken');
		runs.updateProfile(db, user, profileId, { name: 'Lokal' }); // its own name is no conflict
		expect(
			caught(() => runs.updateProfile(db, user, profileId, { api_key: 'x' } as never)).code
		).toBe('unknown_field');
	});

	it('lets no agent create, update or delete profiles', () => {
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

	it('deletes only without active runs (queued, running, waiting_approval), and ended runs keep their history', () => {
		const { db, profileId, queued, running, row } = setup();
		const [waiting, active, approval] = [queued(), running(), running()];
		runs.setRunState(db, system, approval, 'waiting_approval');
		const err = caught(() => runs.deleteProfile(db, user, profileId));
		expect(err.code).toBe('profile_in_use');
		expect(err.message).toBe('Profil „Lokal“ wird von aktiven Runs genutzt: 1, 2, 3.');
		runs.finishRun(db, system, active, { state: 'succeeded' });
		runs.finishRun(db, user, approval, { state: 'cancelled' });
		// a queued run alone blocks it: without a profile the runner could not start it any more
		expect(caught(() => runs.deleteProfile(db, user, profileId)).message).toBe(
			'Profil „Lokal“ wird von aktiven Runs genutzt: 1.'
		);
		runs.finishRun(db, user, waiting, { state: 'cancelled' });
		runs.deleteProfile(db, user, profileId);
		expect(row(active)).toMatchObject({ state: 'succeeded', agent_profile_id: null });
	});
});

describe('comments', () => {
	it('gives an agent comment the run id and a human comment none', () => {
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
