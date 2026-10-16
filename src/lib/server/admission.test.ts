import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import { DomainError, type Actor } from './domain/core';
import { pauseRun, resumeAll, resumeRun } from './domain/halt';
import { acceptTicket, returnTicket, startTicket } from './domain/intents';
import { liveState } from './live';
import { answerQuestion, requestHuman } from './domain/questions';
import * as runs from './domain/runs';
import { queueNextStep, queueUnblockedSuccessors } from './domain/steps';
import { startRunner, type Executor } from './runner';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'ADM', name: 'Admission' }).id;
	const column = (step: string) =>
		db.prepare('SELECT id FROM columns WHERE project_id = ? AND step = ?').get(projectId, step)!
			.id as number;
	const ticket = (step = 'implement') =>
		board.createTicket(db, user, projectId, { title: 'T', column_id: column(step) }).id;
	const profileId = runs.createProfile(db, user, {
		name: 'P',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const countRuns = (ticketId: number) =>
		(
			db.prepare('SELECT count(*) AS n FROM runs WHERE ticket_id = ?').get(ticketId) as {
				n: number;
			}
		).n;
	/** A run created behind the domain's back, the way an older version or a crash could leave one. */
	const insertRun = (ticketId: number, state: 'queued' | 'running' | 'paused', halted = 0) =>
		db
			.prepare(
				`INSERT INTO runs (ticket_id, column_id, agent_profile_id, trigger, state, halted, finished_at)
				SELECT t.id, t.column_id, ?, 'manual', ?, ?, CASE ? WHEN 'paused' THEN CURRENT_TIMESTAMP END
				FROM tickets t WHERE t.id = ? RETURNING id`
			)
			.get(profileId, state, halted, state, ticketId)!.id as number;
	const succeededRun = (ticketId: number, stepResult: 'done' | 'back' = 'done') => {
		const id = runs.createRun(db, system, { ticketId, profileId }).id;
		runs.startRun(db, system, id);
		runs.finishRun(db, system, id, { state: 'succeeded' });
		db.prepare('UPDATE runs SET step_result = ? WHERE id = ?').run(stepResult, id);
		return id;
	};
	return { db, projectId, column, ticket, profileId, countRuns, insertRun, succeededRun };
}
type World = ReturnType<typeof setup>;

const rejection = (fn: () => unknown): DomainError => {
	try {
		fn();
	} catch (err) {
		if (err instanceof DomainError) return err;
		throw err;
	}
	throw new Error('expected a DomainError');
};

/** What a human sees when a second run is refused; run numbers differ between the ways, the wording must not. */
const wording = (err: DomainError) => ({
	code: err.code,
	message: err.message.replace(/Run \d+/g, 'Run N').replace(/ADM-\d+/g, 'ADM-N'),
	hint: err.hint.replace(/\d+/g, 'N')
});

/**
 * A way to create a run for a ticket in a work step. `withRun`/`withQuestion` leave the ticket with another active
 * run or an open question; `attempt` tries the way and returns the run it created, or the refusal.
 */
type Refusal = 'run_pending' | 'open_question' | 'silent' | 'kept-answer';
type Way = {
	name: string;
	whenRunPending: Refusal;
	whenQuestionOpen: Refusal | 'not applicable';
	prepare: (w: World) => { ticketId: number; resumedFrom?: number };
	attempt: (w: World, ticketId: number, resumedFrom?: number) => number | DomainError | undefined;
};
const created = (w: World, ticketId: number, before: number) =>
	w.countRuns(ticketId) === before + 1
		? (w.db.prepare('SELECT max(id) AS id FROM runs WHERE ticket_id = ?').get(ticketId)!
				.id as number)
		: undefined;

let lastResult: unknown;
const attemptWith =
	(call: (w: World, ticketId: number, resumedFrom?: number) => unknown) =>
	(w: World, ticketId: number, resumedFrom?: number) => {
		const before = w.countRuns(ticketId);
		try {
			lastResult = call(w, ticketId, resumedFrom);
		} catch (err) {
			if (err instanceof DomainError) return err;
			throw err;
		}
		return created(w, ticketId, before);
	};

const plain = (w: World) => ({ ticketId: w.ticket() });
const pausedRun = (w: World) => {
	const ticketId = w.ticket();
	const id = runs.createRun(w.db, system, { ticketId, profileId: w.profileId }).id;
	runs.startRun(w.db, system, id);
	return { ticketId, id };
};

const WAYS: Way[] = [
	{
		name: 'startTicket (human, ticket already in a work step)',
		whenRunPending: 'run_pending',
		whenQuestionOpen: 'open_question',
		prepare: plain,
		attempt: attemptWith((w, ticketId) => startTicket(w.db, user, ticketId, w.profileId))
	},
	{
		name: 'returnTicket (human, ticket in acceptance)',
		whenRunPending: 'run_pending',
		whenQuestionOpen: 'open_question',
		prepare: (w) => ({ ticketId: w.ticket('acceptance') }),
		attempt: attemptWith((w, ticketId) => returnTicket(w.db, user, ticketId, 'Nachbessern'))
	},
	{
		name: 'chain: queueNextStep after a run finished its step',
		whenRunPending: 'silent',
		whenQuestionOpen: 'silent',
		prepare: (w) => {
			const ticketId = w.ticket();
			return { ticketId, resumedFrom: w.succeededRun(ticketId) };
		},
		attempt: attemptWith((w, _ticketId, finished) => {
			const next = queueNextStep(w.db, finished!);
			if (next === undefined) return;
			return next;
		})
	},
	{
		name: 'chain across a predecessor: queueUnblockedSuccessors',
		whenRunPending: 'silent',
		whenQuestionOpen: 'silent',
		prepare: (w) => {
			const successor = w.ticket();
			const predecessor = w.ticket('acceptance');
			board.linkRelation(w.db, user, predecessor, successor, 'blocks');
			board.moveTicket(w.db, user, predecessor, w.column('done'));
			const run = w.succeededRun(successor);
			w.db
				.prepare("UPDATE tickets SET moved_by = json_object('runId', ?) WHERE id = ?")
				.run(run, successor);
			return { ticketId: successor, resumedFrom: predecessor };
		},
		attempt: attemptWith((w, _ticketId, predecessor) =>
			queueUnblockedSuccessors(w.db, predecessor!)
		)
	},
	{
		name: 'answer to a question of a paused run',
		whenRunPending: 'kept-answer',
		whenQuestionOpen: 'not applicable',
		prepare: (w) => {
			const { ticketId, id } = pausedRun(w);
			const question = requestHuman(w.db, { kind: 'agent', runId: id }, ticketId, {
				question: 'Which one?'
			}).id;
			runs.finishRun(w.db, system, id, { state: 'paused' });
			return { ticketId, resumedFrom: question };
		},
		attempt: attemptWith((w, _ticketId, question) =>
			answerQuestion(w.db, user, question!, { text: 'This one' })
		)
	},
	{
		name: 'resume of a run the human paused',
		whenRunPending: 'run_pending',
		whenQuestionOpen: 'open_question',
		prepare: (w) => {
			const { ticketId, id } = pausedRun(w);
			pauseRun(w.db, user, id);
			return { ticketId, resumedFrom: id };
		},
		attempt: attemptWith((w, _ticketId, halted) => resumeRun(w.db, user, halted!))
	},
	{
		name: 'createRun itself',
		whenRunPending: 'run_pending',
		whenQuestionOpen: 'open_question',
		prepare: plain,
		attempt: attemptWith((w, ticketId) =>
			runs.createRun(w.db, system, { ticketId, profileId: w.profileId })
		)
	}
];

const hinder = {
	run: (w: World, ticketId: number) => w.insertRun(ticketId, 'queued'),
	question: (w: World, ticketId: number) =>
		requestHuman(w.db, user, ticketId, { question: 'Wait for me?' })
};

const commentsOf = (w: World, ticketId: number) =>
	w.db
		.prepare('SELECT author_kind, body FROM comments WHERE ticket_id = ? ORDER BY id')
		.all(ticketId);

function expectOutcome(
	w: World,
	outcome: Refusal,
	ticketId: number,
	result: unknown,
	runsBefore: number
) {
	expect(w.countRuns(ticketId)).toBe(runsBefore);
	if (outcome === 'silent' || outcome === 'kept-answer') expect(result).toBeUndefined();
	else expect(result).toMatchObject({ code: outcome, hint: expect.stringMatching(/\S/) });
}

describe('every way to create a run is admitted in createRun', () => {
	describe.each(WAYS)('$name', (way) => {
		it('creates exactly one run when nothing is in the way', () => {
			const w = setup();
			const { ticketId, resumedFrom } = way.prepare(w);
			const before = w.countRuns(ticketId);
			const result = way.attempt(w, ticketId, resumedFrom);
			expect(typeof result).toBe('number');
			expect(w.countRuns(ticketId)).toBe(before + 1);
		});

		it('creates no run while another run of the ticket is active or waiting', () => {
			const w = setup();
			const { ticketId, resumedFrom } = way.prepare(w);
			const other = hinder.run(w, ticketId);
			const before = w.countRuns(ticketId);
			const result = way.attempt(w, ticketId, resumedFrom);
			expectOutcome(w, way.whenRunPending, ticketId, result, before);
			if (way.whenRunPending === 'kept-answer') {
				const stored = w.db
					.prepare('SELECT answer FROM questions WHERE ticket_id = ?')
					.get(ticketId);
				expect(stored).toEqual({ answer: JSON.stringify({ text: 'This one' }) });
				expect(commentsOf(w, ticketId).at(-1)).toMatchObject({
					author_kind: 'system',
					body: expect.stringContaining('Ausweg')
				});
				expect(commentsOf(w, ticketId).at(-1)!.body).toContain(`Run ${other}`);
				expect(lastResult).toEqual({ resumesRun: false });
				expect(commentsOf(w, ticketId).at(-1)!.body).not.toContain('Starte einen Run');
				expect(commentsOf(w, ticketId).at(-1)!.body).toContain('brich ihn in der Run-Akte ab');
			}
		});

		it('creates no run while the ticket has an open question', () => {
			if (way.whenQuestionOpen === 'not applicable') return;
			const w = setup();
			const { ticketId, resumedFrom } = way.prepare(w);
			hinder.question(w, ticketId);
			const before = w.countRuns(ticketId);
			const result = way.attempt(w, ticketId, resumedFrom);
			expectOutcome(w, way.whenQuestionOpen, ticketId, result, before);
		});
	});

	it('words a refusal the same way on every way that tells the human', () => {
		const hindrances = [
			{ code: 'run_pending', hinder: hinder.run, tells: (way: Way) => way.whenRunPending },
			{ code: 'open_question', hinder: hinder.question, tells: (way: Way) => way.whenQuestionOpen }
		] as const;
		for (const { code, hinder: hinderWith, tells } of hindrances) {
			const seen = WAYS.filter((way) => tells(way) === code).map((way) => {
				const w = setup();
				const { ticketId, resumedFrom } = way.prepare(w);
				hinderWith(w, ticketId);
				const refusal = way.attempt(w, ticketId, resumedFrom);
				if (!(refusal instanceof DomainError)) throw new Error(`${way.name} did not refuse`);
				return JSON.stringify(wording(refusal));
			});
			expect(seen.length).toBeGreaterThanOrEqual(4);
			expect(new Set(seen).size).toBe(1);
		}
	});

	it('lets a run continue its own paused run, which does not stand in its own way', () => {
		const w = setup();
		const { ticketId, id } = pausedRun(w);
		runs.finishRun(w.db, system, id, { state: 'paused' });
		w.db.prepare('UPDATE runs SET halted = 1 WHERE id = ?').run(id);
		const next = runs.createRun(w.db, system, {
			ticketId,
			profileId: w.profileId,
			resumedFromRunId: id
		}).id;
		expect(w.countRuns(ticketId)).toBe(2);
		expect(
			w.db.prepare('SELECT resumed_from_run_id AS r FROM runs WHERE id = ?').get(next)
		).toEqual({
			r: id
		});
	});
});

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Runs the queued run of the ticket in a runner whose executor parks it at once for the quota. */
async function runParkedForQuota(w: World, ticketId: number) {
	const hold = new Promise<never>(() => {});
	let parked = false;
	const executor: Executor = {
		execute: async () => {
			if (parked) return hold;
			parked = true;
			return { state: 'paused', resume: { reason: 'quota', handoffSeq: 1 } };
		}
	};
	stops.push(startRunner(w.db, { builtin: executor }).stop);
	await flush();
	await flush();
	return w.db
		.prepare('SELECT id, state, error FROM runs WHERE ticket_id = ? ORDER BY id')
		.all(ticketId) as { id: number; state: string; error: string | null }[];
}

describe('the runner continuing a parked run', () => {
	it('queues exactly one continuation when nothing is in the way', async () => {
		const w = setup();
		const ticketId = w.ticket();
		runs.createRun(w.db, system, { ticketId, profileId: w.profileId });
		const all = await runParkedForQuota(w, ticketId);
		expect(all.map((r) => r.state)).toEqual(['paused', 'running']);
	});

	it('fails the run with the refusal in plain sight when the ticket has an open question', async () => {
		const w = setup();
		const ticketId = w.ticket();
		runs.createRun(w.db, system, { ticketId, profileId: w.profileId });
		hinder.question(w, ticketId);
		const all = await runParkedForQuota(w, ticketId);
		expect(all).toEqual([
			{ id: expect.any(Number), state: 'failed', error: expect.stringContaining('open_question') }
		]);
	});

	it('fails the run with the refusal in plain sight when another run of the ticket waits', async () => {
		const w = setup();
		const ticketId = w.ticket();
		const first = runs.createRun(w.db, system, { ticketId, profileId: w.profileId }).id;
		runs.startRun(w.db, system, first);
		runs.finishRun(w.db, system, first, { state: 'paused' });
		w.db.prepare('UPDATE runs SET halted = 1 WHERE id = ?').run(first);
		w.insertRun(ticketId, 'queued');
		const all = await runParkedForQuota(w, ticketId);
		const parked = all.find((r) => r.id !== first && r.state !== 'queued')!;
		expect(parked).toMatchObject({
			state: 'failed',
			error: expect.stringContaining('run_pending')
		});
		expect(w.countRuns(ticketId)).toBe(2);
	});
});

describe('a run the human paused', () => {
	/** A halted run on a ticket that then moves to `step`. */
	function haltedThenMovedTo(step: string) {
		const w = setup();
		const { ticketId, id } = pausedRun(w);
		pauseRun(w.db, user, id);
		board.moveTicket(w.db, user, ticketId, w.column(step));
		return { w, ticketId, halted: id };
	}

	it('stands in the way while the ticket is in a work step, with :fortsetzen as the way out', () => {
		const w = setup();
		const { ticketId, id } = pausedRun(w);
		pauseRun(w.db, user, id);
		expect(rejection(() => startTicket(w.db, user, ticketId, w.profileId))).toMatchObject({
			code: 'run_pending',
			hint: expect.stringContaining(`:fortsetzen ${id}`)
		});
		expect(
			rejection(() => runs.createRun(w.db, system, { ticketId, profileId: w.profileId })).code
		).toBe('run_pending');
	});

	it('lets the human return a ticket moved to acceptance', () => {
		const { w, ticketId } = haltedThenMovedTo('acceptance');
		const { runId } = returnTicket(w.db, user, ticketId, 'Nochmal');
		expect(w.countRuns(ticketId)).toBe(2);
		expect(w.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId)).toEqual({
			state: 'queued'
		});
	});

	it('lets the human start a ticket moved to the backlog', () => {
		const { w, ticketId } = haltedThenMovedTo('backlog');
		startTicket(w.db, user, ticketId, w.profileId);
		expect(w.countRuns(ticketId)).toBe(2);
	});

	it('is no longer offered for resuming once the human started the ticket afresh', () => {
		const { w, ticketId, halted } = haltedThenMovedTo('acceptance');
		returnTicket(w.db, user, ticketId, 'Nochmal');
		expect(w.db.prepare('SELECT halted FROM runs WHERE id = ?').get(halted)).toEqual({ halted: 0 });
	});

	const droppedRunComment = (w: World, ticketId: number, halted: number) =>
		w.db
			.prepare(
				"SELECT body FROM comments WHERE ticket_id = ? AND author_kind = 'system' AND run_id = ?"
			)
			.all(ticketId, halted) as { body: string }[];

	it('is explained on the ticket when starting afresh leaves it behind', () => {
		const { w, ticketId, halted } = haltedThenMovedTo('backlog');
		startTicket(w.db, user, ticketId, w.profileId);
		expect(droppedRunComment(w, ticketId, halted)).toEqual([
			{
				body: expect.stringMatching(
					new RegExp(`^Run ${halted} \\(angehalten\\) wird nicht fortgesetzt.*neu gestartet`)
				)
			}
		]);
	});

	it('is explained on the ticket when returning leaves it behind', () => {
		const { w, ticketId, halted } = haltedThenMovedTo('acceptance');
		returnTicket(w.db, user, ticketId, 'Nochmal');
		expect(droppedRunComment(w, ticketId, halted)).toHaveLength(1);
	});

	it('leaves no stale entry in the live state or in resume-all once the ticket is accepted', () => {
		const { w, ticketId, halted } = haltedThenMovedTo('acceptance');
		expect(liveState(w.db).runs.map((r) => r.id)).toContain(halted);
		acceptTicket(w.db, user, ticketId);
		expect(liveState(w.db).runs.map((r) => r.id)).not.toContain(halted);
		expect(resumeAll(w.db, user).skipped).toEqual([]);
		expect(droppedRunComment(w, ticketId, halted)).toEqual([
			{ body: expect.stringContaining('abgenommen') }
		]);
	});

	it('stays resumable when the human only moves the ticket to the backlog and back', () => {
		const { w, ticketId, halted } = haltedThenMovedTo('backlog');
		board.moveTicket(w.db, user, ticketId, w.column('implement'));
		expect(w.db.prepare('SELECT halted FROM runs WHERE id = ?').get(halted)).toEqual({ halted: 1 });
		expect(droppedRunComment(w, ticketId, halted)).toEqual([]);
		expect(typeof resumeRun(w.db, user, halted).id).toBe('number');
	});

	it('keeps its halt when the start is refused', () => {
		const { w, ticketId, halted } = haltedThenMovedTo('backlog');
		requestHuman(w.db, user, ticketId, { question: 'Wait?' });
		expect(rejection(() => startTicket(w.db, user, ticketId, w.profileId)).code).toBe(
			'open_question'
		);
		expect(w.db.prepare('SELECT halted FROM runs WHERE id = ?').get(halted)).toEqual({ halted: 1 });
	});
});
