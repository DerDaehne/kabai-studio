import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import { subscribe, type StudioEvent } from '../events';
import * as board from './board';
import { DomainError, tx, type Actor } from './core';
import * as notes from './notes';
import * as questions from './questions';
import * as runs from './runs';
import { ROLES, type Step } from './variants';

const user: Actor = { kind: 'user' };
const dev: Actor = { kind: 'agent', runId: 1 };
const reviewer: Actor = { kind: 'agent', runId: 2 };

/** Agent actors act in real runs (comments.run_id has a FK), so this creates runs 1 and 2 in a separate project. */
function withRuns(db: DatabaseSync) {
	const p = board.createProject(db, user, { key: 'RUN', name: 'Runs' }).id;
	const ticketId = board.createTicket(db, user, p, { title: 'Runs' }).id;
	const profileId = runs.createProfile(db, user, {
		name: 'Test',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	for (let i = 0; i < 2; i++) runs.createRun(db, user, { ticketId, profileId });
}

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	withRuns(db);
	const { id: projectId } = board.createProject(db, user, { key: 'STU', name: 'Studio' });
	const rows = db.prepare('SELECT step, id FROM columns WHERE project_id = ?').all(projectId);
	const col = Object.fromEntries(rows.map((r) => [r.step, r.id])) as Record<Step, number>;
	const ticket = (fields: Partial<board.TicketFields> = {}) =>
		board.createTicket(db, user, projectId, { title: 'T', ...fields }).id;
	/** Sets the initial state directly, bypassing the rules. */
	const place = (id: number, step: Step) =>
		db.prepare('UPDATE tickets SET column_id = ? WHERE id = ?').run(col[step], id);
	const columnOf = (id: number) =>
		db
			.prepare('SELECT c.step FROM tickets t JOIN columns c ON c.id = t.column_id WHERE t.id = ?')
			.get(id)?.step;
	return { db, projectId, col, ticket, place, columnOf };
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

describe('createProject / createTicket', () => {
	const stepsOf = (db: DatabaseSync, projectId: number) =>
		db
			.prepare('SELECT step, phase, name FROM columns WHERE project_id = ? ORDER BY position')
			.all(projectId)
			.map((c) => `${c.step}:${c.phase}:${c.name}`);

	it('creates the software variant by default: one column per step with its phase and label', () => {
		const { db, projectId } = setup();
		expect(stepsOf(db, projectId)).toEqual([
			'backlog:open:Backlog',
			'refine:work:Präzisieren',
			'plan:work:Planen',
			'implement:work:Umsetzen',
			'critique:work:Kritik',
			'acceptance:acceptance:Abnahme',
			'done:done:Fertig'
		]);
		expect(db.prepare('SELECT variant FROM projects WHERE id = ?').get(projectId)).toEqual({
			variant: 'software'
		});
	});

	it('creates the knowledge variant: research, draft and critique as work steps', () => {
		const { db } = setup();
		const id = board.createProject(db, user, { key: 'WIS', name: 'Wissen' }, 'knowledge').id;
		expect(stepsOf(db, id)).toEqual([
			'backlog:open:Backlog',
			'research:work:Recherchieren',
			'draft:work:Entwerfen',
			'critique:work:Kritik',
			'acceptance:acceptance:Abnahme',
			'done:done:Fertig'
		]);
		expect(db.prepare('SELECT variant FROM projects WHERE id = ?').get(id)).toEqual({
			variant: 'knowledge'
		});
	});

	it('creates the direct variant: implement and critique as the only work steps', () => {
		const { db } = setup();
		const id = board.createProject(db, user, { key: 'DIR', name: 'Direkt' }, 'direct').id;
		expect(stepsOf(db, id)).toEqual([
			'backlog:open:Backlog',
			'implement:work:Umsetzen',
			'critique:work:Kritik',
			'acceptance:acceptance:Abnahme',
			'done:done:Fertig'
		]);
		expect(db.prepare('SELECT variant FROM projects WHERE id = ?').get(id)).toEqual({
			variant: 'direct'
		});
	});

	it('lets the database refuse a second column for the same step and an unknown step', () => {
		const { db, projectId } = setup();
		expect(() =>
			db
				.prepare("INSERT INTO columns (project_id, step, name) VALUES (?, 'critique', 'Prüfung')")
				.run(projectId)
		).toThrow(/UNIQUE/);
		expect(() =>
			db
				.prepare("INSERT INTO columns (project_id, step, name) VALUES (?, 'triage', 'Triage')")
				.run(projectId)
		).toThrow(/CHECK/);
	});

	it('numbers tickets consecutively per project and never twice, even after a deletion', () => {
		const { db, projectId, ticket, columnOf } = setup();
		const other = board.createProject(db, user, { key: 'OTH', name: 'Anderes' }).id;
		const a = ticket();
		const b = ticket();
		board.deleteTicket(db, user, b);
		const c = board.createTicket(db, user, projectId, { title: 'C' });
		expect(board.createTicket(db, user, other, { title: 'X' }).number).toBe(1);
		const numbers = db
			.prepare('SELECT number FROM tickets WHERE project_id = ? ORDER BY number')
			.all(projectId);
		expect(numbers.map((r) => r.number)).toEqual([1, 3]);
		expect(c.number).toBe(3);
		expect(columnOf(a)).toBe('backlog'); // default: the first normal column
	});

	it('creates tickets never in done, in every other step also as agent', () => {
		const { db, projectId, col } = setup();
		expect(
			caught(() => board.createTicket(db, user, projectId, { title: 'X', column_id: col.done }))
				.code
		).toBe('invalid_column');
		board.createTicket(db, dev, projectId, { title: 'Abnahme', column_id: col.acceptance });
		expect(
			db.prepare('SELECT count(*) AS n FROM tickets WHERE project_id = ?').get(projectId)?.n
		).toBe(1);
	});

	it('refuses a key another project already has, names that project and creates nothing', () => {
		const { db } = setup();
		const projects = () => db.prepare('SELECT count(*) AS n FROM projects').get()?.n;
		const before = projects();
		const err = caught(() => board.createProject(db, user, { key: 'STU', name: 'Neu' }));
		expect(err.code).toBe('key_taken');
		expect(err.message).toBe('Den Key „STU“ hat schon das Projekt „Studio“.');
		expect(err.hint).toContain('anderen Key');
		expect(projects()).toBe(before);
	});

	it('refuses a name another project already has, whatever its case, and names that project', () => {
		const { db } = setup();
		const err = caught(() => board.createProject(db, user, { key: 'NEU', name: 'studio' }));
		expect(err.code).toBe('name_taken');
		expect(err.message).toBe('Ein Projekt „Studio“ gibt es schon (STU).');
		expect(err.hint).toContain('anderen Namen');
	});

	it('refuses a key that is not capital letters and digits starting with a letter', () => {
		const { db } = setup();
		for (const key of ['', 'web', '1WEB', 'WE-B', 'WÜB']) {
			const err = caught(() => board.createProject(db, user, { key, name: `Projekt ${key}` }));
			expect(err.code, key).toBe('invalid_key');
			expect(err.hint).toContain('WEB-1');
		}
	});

	it('refuses a project without a name', () => {
		const { db } = setup();
		const err = caught(() => board.createProject(db, user, { key: 'NEU', name: '  ' }));
		expect(err.code).toBe('empty_name');
	});

	it('sets only the allowed fields in updateTicket', () => {
		const { db, ticket, col } = setup();
		const id = ticket();
		board.updateTicket(db, dev, id, { title: 'Neu', docs_required: 1 });
		expect(db.prepare('SELECT title, docs_required FROM tickets WHERE id = ?').get(id)).toEqual({
			title: 'Neu',
			docs_required: 1
		});
		const err = caught(() => board.updateTicket(db, dev, id, { column_id: col.done } as never));
		expect(err.code).toBe('unknown_field');
		expect(err.hint).toContain('moveTicket');
	});

	it('always gives epics docs_required: forced on create, an explicit 0 is refused on create and update', () => {
		const { db, projectId, ticket } = setup();
		const epic = board.createTicket(db, user, projectId, { title: 'Epic', type: 'epic' }).id;
		expect(db.prepare('SELECT docs_required FROM tickets WHERE id = ?').get(epic)).toEqual({
			docs_required: 1
		});
		expect(
			caught(() =>
				board.createTicket(db, user, projectId, { title: 'X', type: 'epic', docs_required: 0 })
			).code
		).toBe('epic_docs_required');

		const plain = ticket();
		board.updateTicket(db, user, plain, { type: 'epic' });
		expect(db.prepare('SELECT docs_required FROM tickets WHERE id = ?').get(plain)).toEqual({
			docs_required: 1
		});
		const err = caught(() => board.updateTicket(db, user, plain, { docs_required: 0 }));
		expect(err.code).toBe('epic_docs_required');
		expect(err.message).toContain('STU-'); // the message names the ticket ref
	});

	describe('default role prompts', () => {
		// The test names keep the former column names, so the snapshots prove the texts moved into the code unchanged.
		const ROLE_OF_FORMER_COLUMN: Record<string, Step> = {
			Refine: 'refine',
			Ready: 'plan',
			'In Arbeit': 'implement',
			Review: 'critique'
		};
		const role = (step: Step) => ROLES[step] ?? '';

		it('gives refine, plan, implement and critique a role and backlog, acceptance and done none', () => {
			expect(Object.keys(ROLES).sort()).toEqual(['critique', 'implement', 'plan', 'refine']);
		});

		it.each(Object.keys(ROLE_OF_FORMER_COLUMN))(
			'the %s role says what to do, what to deliver and when to stop, in that order',
			(name) => {
				const prompt = role(ROLE_OF_FORMER_COLUMN[name]);
				expect(prompt).toMatchSnapshot();
				const parts = ['Do: ', 'Deliver: ', 'Stop: '].map((label) => prompt.indexOf(label));
				expect(parts.every((at) => at >= 0)).toBe(true);
				expect(parts).toEqual([...parts].sort((a, b) => a - b));
			}
		);

		it('lets Refine propose scope and criteria itself and ask the human only for a genuine product decision', () => {
			const refine = role('refine');
			expect(refine).toContain('propose the scope');
			expect(refine).toContain('yourself');
			expect(refine).toContain('Ask the human only for a genuine product decision');
		});

		it('keeps Ready from refining: it picks the ticket up and moves it on', () => {
			expect(role('plan')).toContain('do not refine');
		});

		it('has In Arbeit carry out the task and deliver the result as an unverified comment, without demanding a test it cannot run', () => {
			const inProgress = role('implement');
			expect(inProgress).toContain('carry out the task');
			expect(inProgress).toContain('fenced block');
			expect(inProgress).toContain('"Unverified: not compiled, run or tested."');
			expect(inProgress).toContain('tick each task the result fulfils');
			expect(inProgress).not.toMatch(/failing test/i);
		});

		// Role prompts reach agents of every project, so they stay generic: no ticket or comment numbers, note slugs,
		// product or tool names or paths, and ASCII English only.
		const FORBIDDEN_PATTERNS: RegExp[] = [
			/#\d/, // ticket or comment number
			/\b(adr|arch|concept)-[a-z]+(-[a-z]+)*\b/i, // note slug prefixes
			/\b(kabai|studio|svelte|sveltekit|sqlite|claude|anthropic|mcp|github|codeberg|vite)\b/i, // product/tool names
			/[^\x00-\x7F]/, // non-ASCII
			/\//, // a path
			/\\/ // a path
		];

		it('keeps every role prompt generic: no ticket numbers, slugs, product or tool names, ASCII English only', () => {
			const prompts = Object.values(ROLES);
			expect(prompts.length).toBeGreaterThan(0);
			for (const text of prompts)
				for (const pattern of FORBIDDEN_PATTERNS) expect(text).not.toMatch(pattern);
		});
	});

	it('does not report docs_required as a changed field when an unrelated epic field is updated', () => {
		const { db, projectId } = setup();
		const epic = board.createTicket(db, user, projectId, { title: 'Epic', type: 'epic' }).id; // docs_required already 1
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));
		board.updateTicket(db, user, epic, { title: 'Anderer Titel' });
		off();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: 'ticket.updated', fields: ['title'] }); // no docs_required in fields although the epic carries it

		const events2: StudioEvent[] = [];
		const off2 = subscribe((e) => events2.push(e));
		board.updateTicket(db, user, epic, {}); // an empty update on an epic stays a no-op without an event
		off2();
		expect(events2).toEqual([]);
	});
});

describe('moveTicket', () => {
	it('lets the human move into any column of the variant, skipping steps in both directions', () => {
		const { db, ticket, col, columnOf } = setup();
		const id = ticket();
		board.moveTicket(db, user, id, col.critique);
		expect(columnOf(id)).toBe('critique');
		board.moveTicket(db, user, id, col.backlog);
		expect(columnOf(id)).toBe('backlog');
		board.moveTicket(db, user, id, col.done);
		expect(columnOf(id)).toBe('done');
		board.moveTicket(db, user, id, col.refine); // reopening is the human's call
		expect(columnOf(id)).toBe('refine');
	});

	it('lets an agent step only to a neighbouring step and names the reachable ones when it tries more', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket();
		place(id, 'plan');
		const err = caught(() => board.moveTicket(db, dev, id, col.critique));
		expect(err.code).toBe('transition_not_allowed');
		expect(err.message).toBe(
			'STU-1 darf nicht von „Planen“ nach „Kritik“ wechseln. Erreichbar für dich: „Präzisieren“, „Umsetzen“.'
		);
		expect(err.hint).toContain('allowedMoves');
		board.moveTicket(db, dev, id, col.implement);
		board.moveTicket(db, dev, id, col.critique);
		board.moveTicket(db, dev, id, col.acceptance);
		expect(columnOf(id)).toBe('acceptance');
	});

	it('never lets an agent complete a ticket: done stays the human step, with the reachable step in the error', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket();
		place(id, 'acceptance');
		const err = caught(() => board.moveTicket(db, dev, id, col.done));
		expect(err.code).toBe('requires_human');
		expect(err.message).toBe(
			'Nur ein Mensch darf STU-1 von „Abnahme“ nach „Fertig“ verschieben. Erreichbar für dich: „Kritik“.'
		);
		expect(err.hint).toContain('Abschließen');
		expect(columnOf(id)).toBe('acceptance');
	});

	it('lets only the human move a ticket out of done (reopen)', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket();
		place(id, 'done');
		expect(board.allowedMoves(db, id, dev)).toEqual([]);
		const err = caught(() => board.moveTicket(db, dev, id, col.acceptance));
		expect(err.code).toBe('requires_human');
		expect(err.message).toContain('Erreichbar für dich: keine.');
		expect(err.hint).toContain('Folgeticket');
		board.moveTicket(db, user, id, col.acceptance);
		expect(columnOf(id)).toBe('acceptance');
	});

	it('rejects a move into done while tasks are open, from any column', () => {
		const { db, ticket, col, columnOf } = setup();
		const id = ticket(); // in the backlog: the human may jump straight to done, the check still applies
		const { id: task } = board.addTask(db, dev, id, 'Tests grün');
		const err = caught(() => board.moveTicket(db, user, id, col.done));
		expect(err.code).toBe('open_tasks');
		expect(err.message).toBe('STU-1 hat 1 offene Tasks: „Tests grün“.');
		board.completeTask(db, dev, task);
		board.moveTicket(db, user, id, col.done);
		expect(columnOf(id)).toBe('done');
	});

	it('rejects moving an epic to done while a child is open', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const epic = ticket({ type: 'epic' });
		const { id: noteId } = notes.createNote(db, user, { slug: 'epic-doku', title: 'N', body: '' });
		notes.linkTicket(db, user, noteId, epic, 'documents'); // epics are always docs_required — a note is linked first so that only open_children applies
		const child = ticket();
		board.linkRelation(db, user, epic, child, 'parent_of');
		place(epic, 'acceptance');
		const err = caught(() => board.moveTicket(db, user, epic, col.done));
		expect(err.code).toBe('open_children');
		expect(err.message).toBe('STU-1 hat nicht abgeschlossene Kind-Tickets: STU-2.');
		place(child, 'done');
		board.moveTicket(db, user, epic, col.done);
		expect(columnOf(epic)).toBe('done');
	});

	it('rejects done without the docs_required note and allows it once a note is linked', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket({ docs_required: 1 });
		place(id, 'acceptance');
		const err = caught(() => board.moveTicket(db, user, id, col.done));
		expect(err.code).toBe('docs_required');
		expect(err.hint).toContain('createNote');

		const { id: noteId } = notes.createNote(db, user, { slug: 'n-1', title: 'N', body: '' });
		notes.linkTicket(db, user, noteId, id, 'documents');
		board.moveTicket(db, user, id, col.done);
		expect(columnOf(id)).toBe('done');
	});

	it('does not accept an archived note as docs_required evidence', () => {
		const { db, ticket, place, col } = setup();
		const id = ticket({ docs_required: 1 });
		const { id: noteId } = notes.createNote(db, user, { slug: 'n-2', title: 'N', body: '' });
		notes.linkTicket(db, user, noteId, id, 'documents');
		notes.archiveNote(db, user, noteId);
		place(id, 'acceptance');
		expect(caught(() => board.moveTicket(db, user, id, col.done)).code).toBe('docs_required');
	});
});

describe('linkRelation', () => {
	it('rejects cycles in parent_of and blocks as well as self relations', () => {
		const { db, ticket } = setup();
		const [a, b, c] = [ticket(), ticket(), ticket()];
		board.linkRelation(db, user, a, b, 'blocks');
		board.linkRelation(db, user, b, c, 'blocks');
		const err = caught(() => board.linkRelation(db, user, c, a, 'blocks'));
		expect(err.code).toBe('cycle');
		expect(err.message).toBe(
			'STU-3 blocks STU-1 ergäbe einen Zyklus: STU-1 führt über blocks schon zu STU-3.'
		);

		board.linkRelation(db, user, a, b, 'parent_of');
		expect(caught(() => board.linkRelation(db, user, b, a, 'parent_of')).code).toBe('cycle');
		expect(caught(() => board.linkRelation(db, user, a, a, 'relates_to')).code).toBe(
			'self_relation'
		);

		board.linkRelation(db, user, c, a, 'relates_to'); // relates_to has no notion of cycles
		board.linkRelation(db, user, a, b, 'blocks'); // idempotent
		expect(db.prepare('SELECT count(*) AS n FROM ticket_relations').get()?.n).toBe(4);
	});
});

describe('allowedMoves', () => {
	it('lists every other column for the human and only the neighbouring steps short of done for an agent', () => {
		const { db, ticket, place } = setup();
		const id = ticket();
		place(id, 'acceptance');
		board.addTask(db, dev, id, 'offen');
		const view = (actor: Actor) =>
			board
				.allowedMoves(db, id, actor)
				.map((m) => [m.name, m.phase, m.blockers.map((b) => b.code)]);
		expect(view(dev)).toEqual([['Kritik', 'work', []]]);
		expect(view(user)).toEqual([
			['Backlog', 'open', []],
			['Präzisieren', 'work', []],
			['Planen', 'work', []],
			['Umsetzen', 'work', []],
			['Kritik', 'work', []],
			['Fertig', 'done', ['open_tasks']]
		]);
		expect(board.allowedMoves(db, id, user)[5].blockers[0].hint).toContain('completeTask');
		place(id, 'implement');
		expect(view(dev).map(([name]) => name)).toEqual(['Planen', 'Kritik']);
		place(id, 'backlog');
		expect(view(dev).map(([name]) => name)).toEqual(['Präzisieren']);
	});
});

describe('review approval', () => {
	it('rejects self-approval and allows another agent and the human to approve', () => {
		const { db, ticket, place, col } = setup();
		const id = ticket();
		place(id, 'implement');
		board.moveTicket(db, dev, id, col.critique);
		const err = caught(() => board.approveReview(db, dev, id));
		expect(err.code).toBe('self_approval');
		expect(err.hint).toContain('anderer Agent');
		board.approveReview(db, reviewer, id);
		const row = db
			.prepare('SELECT review_approved_at, review_approved_by FROM tickets WHERE id = ?')
			.get(id);
		expect(row?.review_approved_at).not.toBeNull();
		expect(JSON.parse(row?.review_approved_by as string)).toEqual(reviewer);

		board.moveTicket(db, user, id, col.implement);
		board.moveTicket(db, user, id, col.critique);
		board.approveReview(db, user, id); // the human may always approve
	});

	it('lets an agent approve only in the critique step, whatever the column is called, the human in any column', () => {
		const { db, ticket, place, col } = setup();
		const id = ticket();
		const err = caught(() => board.approveReview(db, reviewer, id));
		expect(err.code).toBe('not_in_review');
		expect(err.message).toContain('STU-1');
		expect(err.message).toContain('„Backlog“');
		expect(
			db.prepare('SELECT review_approved_at AS at FROM tickets WHERE id = ?').get(id)?.at
		).toBeNull();
		board.approveReview(db, user, id);

		db.prepare("UPDATE columns SET name = 'Prüfung' WHERE id = ?").run(col.critique);
		place(id, 'critique');
		board.approveReview(db, reviewer, id);
	});

	it('clears the approval when moved back to implement and keeps it when moved on to acceptance and done', () => {
		const { db, ticket, place, col } = setup();
		const approved = (id: number) =>
			db.prepare('SELECT review_approved_at AS at FROM tickets WHERE id = ?').get(id)?.at !== null;
		const id = ticket();
		place(id, 'critique');
		board.approveReview(db, reviewer, id);
		board.moveTicket(db, reviewer, id, col.implement);
		expect(approved(id)).toBe(false);

		board.moveTicket(db, dev, id, col.critique);
		board.approveReview(db, reviewer, id);
		board.moveTicket(db, reviewer, id, col.acceptance);
		expect(approved(id)).toBe(true);
		board.moveTicket(db, user, id, col.done);
		expect(approved(id)).toBe(true);
	});

	it('clears the approval when the human reopens a done ticket into earlier work', () => {
		const { db, ticket, place, col } = setup();
		const approved = (id: number) =>
			db.prepare('SELECT review_approved_at AS at FROM tickets WHERE id = ?').get(id)?.at !== null;
		const id = ticket();
		place(id, 'critique');
		board.approveReview(db, reviewer, id);
		board.moveTicket(db, user, id, col.done);
		expect(approved(id)).toBe(true);
		board.moveTicket(db, user, id, col.implement);
		expect(approved(id)).toBe(false);
	});

	it('keeps a predecessor approved in critique unblocking its successor after it moves on to acceptance (review_ok)', () => {
		const { db, projectId, ticket, place, col } = setup();
		const [a, b] = [ticket(), ticket()];
		board.linkRelation(db, user, a, b, 'blocks');
		board.setBlocksSatisfiedAt(db, user, projectId, 'review_ok');
		place(a, 'critique');
		board.approveReview(db, reviewer, a);
		board.moveTicket(db, reviewer, a, col.acceptance);
		expect(board.workableTickets(db, projectId, col.backlog).map((r) => r.ref)).toEqual(['STU-2']);
	});
});

describe('workableTickets', () => {
	const refs = (rows: { ref: string }[]) => rows.map((r) => r.ref);

	it('hides tickets with unfinished blocks predecessors', () => {
		const { db, projectId, ticket, place, col } = setup();
		const [a, b] = [ticket(), ticket()];
		const done = ticket();
		place(done, 'done');
		board.linkRelation(db, user, a, b, 'blocks');
		expect(refs(board.workableTickets(db, projectId))).toEqual(['STU-1']);
		place(a, 'done');
		expect(refs(board.workableTickets(db, projectId))).toEqual(['STU-2']);
		expect(refs(board.workableTickets(db, projectId, col.implement))).toEqual([]);
	});

	it('hides a ticket while it waits for the human: from the question until the answer, again after the answer is retracted', () => {
		const { db, projectId, ticket, place } = setup();
		const [asking, other] = [ticket(), ticket()];
		place(asking, 'implement');
		place(other, 'implement');
		const { id } = questions.requestHuman(db, dev, asking, { question: 'A oder B?' });
		expect(refs(board.workableTickets(db, projectId))).toEqual(['STU-2']);

		questions.answerQuestion(db, user, id, { text: 'A' });
		expect(refs(board.workableTickets(db, projectId))).toEqual(['STU-1', 'STU-2']);
		questions.retractAnswer(db, user, id);
		expect(refs(board.workableTickets(db, projectId))).toEqual(['STU-2']);
	});

	it('respects blocks_satisfied_at: done versus review_ok', () => {
		const { db, projectId, ticket, place, col } = setup();
		const [a, b] = [ticket(), ticket()];
		board.linkRelation(db, user, a, b, 'blocks');
		place(a, 'critique');
		board.approveReview(db, reviewer, a);
		const workable = () => refs(board.workableTickets(db, projectId, col.backlog));

		expect(workable()).toEqual([]); // default done: an approval is not enough
		board.setBlocksSatisfiedAt(db, user, projectId, 'review_ok');
		expect(workable()).toEqual(['STU-2']);
		board.moveTicket(db, reviewer, a, col.implement); // the approval clears
		expect(workable()).toEqual([]);
	});
});

describe('tasks with a reason', () => {
	it('writes a system comment for updateTask and deleteTask and rejects them without a reason', () => {
		const { db, ticket } = setup();
		const id = ticket();
		const { id: task } = board.addTask(db, dev, id, 'Alt');
		expect(caught(() => board.deleteTask(db, dev, task, '  ')).code).toBe('reason_required');

		board.updateTask(db, dev, task, 'Neu', 'präziser');
		board.deleteTask(db, dev, task, 'durch Folgeticket überholt');
		expect(db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(0);
		const comments = db
			.prepare('SELECT author_kind, author, body FROM comments WHERE ticket_id = ? ORDER BY id')
			.all(id);
		expect(comments).toEqual([
			{
				author_kind: 'system',
				author: 'system',
				body: 'Task „Alt“ umbenannt in „Neu“ von agent (Run 1). Grund: präziser'
			},
			{
				author_kind: 'system',
				author: 'system',
				body: 'Task „Neu“ gelöscht von agent (Run 1). Grund: durch Folgeticket überholt'
			}
		]);
	});
});

describe('event bus', () => {
	it('emits an event for every mutation, outside the transaction', () => {
		const db = openDb(':memory:');
		migrate(db);
		withRuns(db);
		const events: StudioEvent[] = [];
		const inTx: boolean[] = [];
		const off = subscribe((e) => {
			events.push(e);
			inTx.push(db.isTransaction);
		});

		const p = board.createProject(db, user, { key: 'EVT', name: 'Events' }).id;
		board.setBlocksSatisfiedAt(db, user, p, 'review_ok');
		const a = board.createTicket(db, user, p, { title: 'A' }).id;
		const b = board.createTicket(db, user, p, { title: 'B' }).id;
		board.updateTicket(db, dev, a, { description: 'x' });
		const inArbeit = board.allowedMoves(db, a, dev)[0].columnId;
		board.moveTicket(db, dev, a, inArbeit);
		board.approveReview(db, user, a);
		const task = board.addTask(db, dev, a, 'K').id;
		board.completeTask(db, dev, task);
		board.reopenTask(db, dev, task);
		board.updateTask(db, dev, task, 'K2', 'Grund');
		board.deleteTask(db, dev, task, 'Grund');
		board.addComment(db, dev, a, 'Notiz');
		board.linkRelation(db, dev, a, b, 'blocks');
		board.unlinkRelation(db, dev, a, b, 'blocks');
		board.deleteTicket(db, user, b);
		off();

		expect(events.map((e) => e.type)).toEqual([
			'project.created',
			'project.updated',
			'ticket.created',
			'ticket.created',
			'ticket.updated',
			'ticket.moved',
			'ticket.review_approved',
			'task.added',
			'task.completed',
			'task.reopened',
			'task.updated',
			'comment.added',
			'task.deleted',
			'comment.added',
			'comment.added',
			'relation.linked',
			'relation.unlinked',
			'ticket.deleted'
		]);
		expect(events.every((e) => e.projectId === p && e.actor)).toBe(true);
		expect(inTx.every((t) => t === false)).toBe(true); // published only after COMMIT
		expect(events[5]).toMatchObject({ ticketId: a, actor: dev, to: inArbeit });
	});

	it('reports nothing for a rolled back transaction, even if it had already emitted', () => {
		const db = openDb(':memory:');
		migrate(db);
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));
		const failing = () =>
			tx(db, (emit) => {
				emit({ type: 'ticket.created', projectId: 1, actor: user });
				throw new Error('Abbruch');
			});
		expect(failing).toThrow('Abbruch');
		off();
		expect(events).toEqual([]);
		expect(db.isTransaction).toBe(false);
	});

	it('lets mutations called inside a transaction join it: all or nothing, events after the outer commit', () => {
		const { db, projectId } = setup();
		const titles = () =>
			db
				.prepare('SELECT title FROM tickets WHERE project_id = ? ORDER BY id')
				.all(projectId)
				.map((r) => r.title);
		const events: StudioEvent[] = [];
		const inTx: boolean[] = [];
		const off = subscribe((e) => {
			events.push(e);
			inTx.push(db.isTransaction);
		});
		const batch = (second: string) =>
			tx(db, () => {
				board.createTicket(db, user, projectId, { title: 'A' });
				board.createTicket(db, user, projectId, { title: second });
			});

		expect(() => batch(' ')).toThrow(DomainError);
		expect(titles()).toEqual([]);
		expect(events).toEqual([]);

		batch('B');
		off();
		expect(titles()).toEqual(['A', 'B']);
		expect(events.map((e) => e.type)).toEqual(['ticket.created', 'ticket.created']);
		expect(inTx).toEqual([false, false]);
	});

	it("rolls back a joined mutation that fails even when the caller catches its error, and keeps the caller's own writes", () => {
		const { db, projectId, ticket } = setup();
		const id = ticket();
		const { id: task } = board.addTask(db, user, id, 'Alt');
		const ghost: Actor = { kind: 'agent', runId: 999 }; // no such run: the system comment's run FK fails after the delete
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));

		tx(db, () => {
			board.createTicket(db, user, projectId, { title: 'Bleibt' });
			try {
				// deletes and reports the task, then the comment is refused
				board.deleteTask(db, ghost, task, 'überholt');
			} catch {
				// the caller decides to go on without the deletion
			}
		});
		off();

		expect(db.prepare('SELECT count(*) AS n FROM tasks WHERE id = ?').get(task)?.n).toBe(1);
		expect(db.prepare('SELECT count(*) AS n FROM comments WHERE ticket_id = ?').get(id)?.n).toBe(0);
		expect(db.prepare("SELECT count(*) AS n FROM tickets WHERE title = 'Bleibt'").get()?.n).toBe(1);
		expect(events.map((e) => e.type)).toEqual(['ticket.created']);
	});
});

describe('blockingPredecessors', () => {
	const refs = (rows: { ref: string }[]) => rows.map((r) => r.ref);

	it('lists the open predecessors that keep a ticket out of workableTickets', () => {
		const { db, projectId, ticket, place, col } = setup();
		const [open, finished, successor] = [ticket(), ticket(), ticket()];
		place(finished, 'done');
		board.linkRelation(db, user, open, successor, 'blocks');
		board.linkRelation(db, user, finished, successor, 'blocks');
		expect(board.blockingPredecessors(db, successor)).toEqual([
			{ id: open, ref: 'STU-1', title: 'T', column: 'Backlog' }
		]);
		expect(refs(board.workableTickets(db, projectId, col.backlog))).not.toContain('STU-3');

		place(open, 'done');
		expect(board.blockingPredecessors(db, successor)).toEqual([]);
		expect(refs(board.workableTickets(db, projectId, col.backlog))).toContain('STU-3');
	});

	it('counts an approved predecessor as finished only when the project says review_ok', () => {
		const { db, projectId, ticket, place } = setup();
		const [predecessor, successor] = [ticket(), ticket()];
		board.linkRelation(db, user, predecessor, successor, 'blocks');
		place(predecessor, 'critique');
		board.approveReview(db, reviewer, predecessor);
		expect(refs(board.blockingPredecessors(db, successor))).toEqual(['STU-1']);
		board.setBlocksSatisfiedAt(db, user, projectId, 'review_ok');
		expect(board.blockingPredecessors(db, successor)).toEqual([]);
	});
});

describe('addTasks / completeTasks', () => {
	const openTitles = (db: DatabaseSync, id: number) =>
		db
			.prepare('SELECT title FROM tasks WHERE ticket_id = ? AND done_at IS NULL ORDER BY id')
			.all(id)
			.map((r) => r.title);

	it('adds all tasks or none', () => {
		const { db, ticket } = setup();
		const id = ticket();
		expect(caught(() => board.addTasks(db, dev, id, ['A', '  '])).code).toBe('empty_title');
		expect(openTitles(db, id)).toEqual([]);
		expect(board.addTasks(db, dev, id, ['A', 'B']).ids).toHaveLength(2);
		expect(openTitles(db, id)).toEqual(['A', 'B']);
	});

	it('completes only tasks of the given ticket and rejects the whole call for a foreign id', () => {
		const { db, ticket } = setup();
		const [own, other] = [ticket(), ticket()];
		const [a, b] = board.addTasks(db, dev, own, ['A', 'B']).ids;
		const [foreign] = board.addTasks(db, user, other, ['Fremd']).ids;
		const err = caught(() => board.completeTasks(db, dev, own, [a, foreign]));
		expect(err.code).toBe('not_found');
		expect(err.message).toContain(String(foreign));
		expect(err.hint).toContain(`${a}, ${b}`);
		expect(openTitles(db, own)).toEqual(['A', 'B']);
		expect(openTitles(db, other)).toEqual(['Fremd']);

		board.completeTasks(db, dev, own, [a]);
		expect(openTitles(db, own)).toEqual(['B']);
	});

	it('completes a task listed several times only once', () => {
		const { db, ticket } = setup();
		const id = ticket();
		const [a] = board.addTasks(db, dev, id, ['A']).ids;
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));
		board.completeTasks(db, dev, id, [a, a, a]);
		off();
		expect(events.map((e) => e.type)).toEqual(['task.completed']);
	});
});

describe('ticket title', () => {
	it('rejects a blank title on create and update', () => {
		const { db, projectId, ticket } = setup();
		const id = ticket();
		expect(caught(() => board.updateTicket(db, dev, id, { title: '   ' })).code).toBe(
			'empty_title'
		);
		expect(caught(() => board.createTicket(db, user, projectId, { title: ' ' })).code).toBe(
			'empty_title'
		);
	});
});
