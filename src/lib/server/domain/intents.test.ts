import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import * as board from './board';
import { DomainError, type Actor } from './core';
import { pauseRun, resumeAll, resumeRun } from './halt';
import { acceptTicket, returnTicket, startTicket } from './intents';
import { requestHuman } from './questions';
import * as runs from './runs';
import type { Step, Variant } from './variants';

const user: Actor = { kind: 'user' };
const agent: Actor = { kind: 'agent', runId: 1 };

function setup(variant: Variant = 'software') {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'INT', name: 'Absichten' }, variant).id;
	const columnOf = (step: Step) => board.columns(db, projectId).find((c) => c.step === step)!.id;
	/** Tickets do not start in done, so a done ticket is accepted on the way. */
	const ticket = (step: Step = 'backlog') => {
		const start = step === 'done' ? 'acceptance' : step;
		const { id } = board.createTicket(db, user, projectId, {
			title: 'T',
			column_id: columnOf(start)
		});
		if (step === 'done') acceptTicket(db, user, id);
		return id;
	};
	const profile = (name: string) =>
		runs.createProfile(db, user, {
			name,
			executor: 'builtin',
			provider: 'openai-compatible',
			model: 'm'
		}).id;
	const stepOf = (id: number) => board.ticket(db, id).column_step;
	const runsOf = (id: number) =>
		db
			.prepare(
				'SELECT r.state, r.trigger, r.priority, r.agent_profile_id AS profileId, c.step FROM runs r JOIN columns c ON c.id = r.column_id WHERE r.ticket_id = ? ORDER BY r.id'
			)
			.all(id);
	return { db, projectId, columnOf, ticket, profile, stepOf, runsOf };
}

function caught(fn: () => unknown): DomainError {
	try {
		fn();
	} catch (err) {
		if (err instanceof DomainError) return err;
		throw err;
	}
	throw new Error('expected a DomainError');
}

describe('startTicket („los“)', () => {
	it.each([
		['software', 'refine'],
		['knowledge', 'research'],
		['direct', 'implement']
	] as const)(
		'in %s moves a backlog ticket into %s and queues its run ahead of background work',
		(variant, firstWorkStep) => {
			const s = setup(variant);
			const profileId = s.profile('Lokal');
			const id = s.ticket();

			const started = startTicket(s.db, user, id, profileId);

			expect(started).toEqual({ runId: expect.any(Number), predecessors: [] });
			expect(s.stepOf(id)).toBe(firstWorkStep);
			expect(s.runsOf(id)).toEqual([
				{ state: 'queued', trigger: 'manual', priority: 'human', profileId, step: firstWorkStep }
			]);
		}
	);

	it('only queues the run for a ticket already in a work step, with the profile the project used last', () => {
		const s = setup();
		s.profile('Alpha');
		const zeta = s.profile('Zeta');
		const earlier = s.ticket('implement');
		runs.finishRun(
			s.db,
			user,
			runs.createRun(s.db, user, { ticketId: earlier, profileId: zeta }).id,
			{
				state: 'cancelled'
			}
		);
		const id = s.ticket('critique');

		startTicket(s.db, user, id);

		expect(s.stepOf(id)).toBe('critique');
		expect(s.runsOf(id)).toEqual([expect.objectContaining({ step: 'critique', profileId: zeta })]);
	});

	it('starts a blocked ticket the human chose to start and names its open predecessors', () => {
		const s = setup();
		const profileId = s.profile('Lokal');
		const [predecessor, id] = [s.ticket(), s.ticket()];
		board.linkRelation(s.db, user, predecessor, id, 'blocks');

		const { predecessors } = startTicket(s.db, user, id, profileId);

		expect(predecessors).toEqual([
			{ id: predecessor, ref: 'INT-1', title: 'T', column: 'Backlog' }
		]);
		expect(s.stepOf(id)).toBe('refine');
	});

	it('refuses a second run, a ticket with an open question, a ticket in acceptance and an agent, and changes nothing', () => {
		const s = setup();
		const profileId = s.profile('Lokal');
		const running = s.ticket('implement');
		startTicket(s.db, user, running, profileId);
		const asking = s.ticket();
		requestHuman(s.db, user, asking, { question: 'Welches Format?' });
		const accepted = s.ticket('acceptance');

		expect(caught(() => startTicket(s.db, user, running, profileId)).code).toBe('run_pending');
		expect(caught(() => startTicket(s.db, user, asking, profileId))).toMatchObject({
			code: 'open_question',
			hint: expect.stringContaining('Beantworte')
		});
		expect(caught(() => startTicket(s.db, user, accepted, profileId))).toMatchObject({
			code: 'not_in_work',
			hint: expect.stringContaining('acceptTicket')
		});
		expect(caught(() => startTicket(s.db, agent, s.ticket(), profileId)).code).toBe(
			'requires_human'
		);
		expect(s.stepOf(asking)).toBe('backlog');
		expect(s.runsOf(running)).toHaveLength(1);
	});

	it('refuses a second run while the human paused one, points to :fortsetzen, and resuming all leaves one run', () => {
		const s = setup();
		const id = s.ticket('implement');
		const first = startTicket(s.db, user, id, s.profile('P')).runId;
		runs.startRun(s.db, user, first);
		pauseRun(s.db, user, first);

		const refusal = caught(() => startTicket(s.db, user, id));
		resumeAll(s.db, user);

		expect(refusal).toMatchObject({
			code: 'run_pending',
			hint: `Setz ihn fort (:fortsetzen ${first}) statt einen zweiten zu starten.`
		});
		expect(s.runsOf(id).filter((r) => r.state === 'queued')).toEqual([
			expect.objectContaining({ trigger: 'resume' })
		]);
	});

	it('resumes no halted run while another run of its ticket waits', () => {
		const s = setup();
		const id = s.ticket('implement');
		const profileId = s.profile('P');
		const halted = startTicket(s.db, user, id, profileId).runId;
		runs.startRun(s.db, user, halted);
		pauseRun(s.db, user, halted);
		const other = runs.createRun(s.db, user, { ticketId: id, profileId }).id;

		expect(caught(() => resumeRun(s.db, user, halted))).toMatchObject({
			code: 'run_pending',
			message: expect.stringContaining(`Run ${other}`)
		});
		expect(resumeAll(s.db, user)).toMatchObject({
			resumed: [],
			skipped: [expect.objectContaining({ runId: halted, code: 'run_pending' })]
		});
	});

	it('asks for a profile when none exists yet', () => {
		const s = setup();
		const id = s.ticket();
		expect(caught(() => startTicket(s.db, user, id))).toMatchObject({
			code: 'no_profile',
			hint: expect.stringContaining('Profile')
		});
		expect(s.stepOf(id)).toBe('backlog');
	});
});

describe('acceptTicket („abnehmen“)', () => {
	it('moves a ticket from acceptance to done', () => {
		const s = setup();
		const id = s.ticket('acceptance');
		acceptTicket(s.db, user, id);
		expect(s.stepOf(id)).toBe('done');
	});

	it.each([
		['open_tasks', (s: ReturnType<typeof setup>, id: number) => board.addTask(s.db, user, id, 'A')],
		[
			'open_children',
			(s: ReturnType<typeof setup>, id: number) =>
				board.linkRelation(s.db, user, id, s.ticket(), 'parent_of')
		],
		[
			'docs_required',
			(s: ReturnType<typeof setup>, id: number) =>
				board.updateTicket(s.db, user, id, { docs_required: 1 })
		]
	] as const)('refuses with %s and a way out, and the ticket stays', (code, block) => {
		const s = setup();
		const id = s.ticket('acceptance');
		block(s, id);
		expect(caught(() => acceptTicket(s.db, user, id))).toMatchObject({
			code,
			hint: expect.any(String)
		});
		expect(s.stepOf(id)).toBe('acceptance');
	});

	it('refuses a ticket outside acceptance and an agent', () => {
		const s = setup();
		const working = s.ticket('implement');
		expect(caught(() => acceptTicket(s.db, user, working))).toMatchObject({
			code: 'not_in_acceptance',
			hint: expect.stringContaining('Abnahme')
		});
		expect(caught(() => acceptTicket(s.db, agent, s.ticket('acceptance'))).code).toBe(
			'requires_human'
		);
	});
});

describe('returnTicket („zurückgeben“)', () => {
	it.each([
		['software', 'acceptance', 'implement'],
		['software', 'done', 'implement'],
		['knowledge', 'acceptance', 'draft'],
		['direct', 'done', 'implement']
	] as const)(
		'in %s sends a ticket from %s back to %s with the comment, clears the approval and runs the chain again',
		(variant, from, to) => {
			const s = setup(variant);
			const profileId = s.profile('Lokal');
			const id = s.ticket(from);
			board.approveReview(s.db, user, id);

			returnTicket(s.db, user, id, 'Die Kopfzeile fehlt.');

			expect(s.stepOf(id)).toBe(to);
			expect(s.db.prepare('SELECT review_approved_at FROM tickets WHERE id = ?').get(id)).toEqual({
				review_approved_at: null
			});
			expect(
				s.db.prepare('SELECT author_kind, body FROM comments WHERE ticket_id = ?').all(id)
			).toEqual([{ author_kind: 'user', body: 'Die Kopfzeile fehlt.' }]);
			expect(s.runsOf(id)).toEqual([
				{ state: 'queued', trigger: 'manual', priority: 'human', profileId, step: to }
			]);
		}
	);

	it('refuses a return without a comment, from a work step or by an agent, with a way out, and changes nothing', () => {
		const s = setup();
		s.profile('Lokal');
		const id = s.ticket('acceptance');
		expect(caught(() => returnTicket(s.db, user, id, '  '))).toMatchObject({
			code: 'comment_required',
			hint: expect.stringContaining('Schreib')
		});
		expect(caught(() => returnTicket(s.db, user, s.ticket('implement'), 'x')).code).toBe(
			'not_returnable'
		);
		expect(caught(() => returnTicket(s.db, agent, id, 'x')).code).toBe('requires_human');
		expect(s.stepOf(id)).toBe('acceptance');
		expect(s.runsOf(id)).toEqual([]);
	});
});

describe('createRun outside the work phase', () => {
	it.each([
		['backlog', 'startTicket'],
		['acceptance', 'acceptTicket'],
		['done', 'returnTicket']
	] as const)(
		'refuses a ticket in %s with not_in_work and names %s as the way out',
		(step, way) => {
			const s = setup();
			const profileId = s.profile('Lokal');
			const id = s.ticket(step);
			expect(caught(() => runs.createRun(s.db, user, { ticketId: id, profileId }))).toMatchObject({
				code: 'not_in_work',
				hint: expect.stringContaining(way)
			});
			expect(s.runsOf(id)).toEqual([]);
		}
	);
});
