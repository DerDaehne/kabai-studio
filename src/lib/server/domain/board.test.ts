import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import { subscribe, type StudioEvent } from '../events';
import * as board from './board';
import { DomainError, tx, type Actor } from './core';
import * as notes from './notes';
import { requestHuman } from './questions';
import * as runs from './runs';

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
	const rows = db.prepare('SELECT name, id FROM columns WHERE project_id = ?').all(projectId);
	const col = Object.fromEntries(rows.map((r) => [r.name, r.id])) as Record<string, number>;
	const ticket = (fields: Partial<board.TicketFields> = {}) =>
		board.createTicket(db, user, projectId, { title: 'T', ...fields }).id;
	/** Sets the initial state directly, bypassing the rules. */
	const place = (id: number, column: string) =>
		db.prepare('UPDATE tickets SET column_id = ? WHERE id = ?').run(col[column], id);
	const columnOf = (id: number) =>
		db
			.prepare('SELECT c.name FROM tickets t JOIN columns c ON c.id = t.column_id WHERE t.id = ?')
			.get(id)?.name;
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
	it('creates the Software template with linear transitions (only a human moves to done or human_answered)', () => {
		const { db, projectId } = setup();
		const cols = db
			.prepare('SELECT name, kind FROM columns WHERE project_id = ? ORDER BY position')
			.all(projectId);
		expect(cols.map((c) => `${c.name}:${c.kind}`)).toEqual([
			'Backlog:normal',
			'Refine:normal',
			'Ready:normal',
			'In Arbeit:normal',
			'Review:normal',
			'Abnahme:normal',
			'Done:done',
			'Human Intervention:human_intervention',
			'Human Answered:human_answered'
		]);
		const edges = db
			.prepare(
				`SELECT f.name AS "from", t.name AS "to", x.requires_human AS rh FROM transitions x
				JOIN columns f ON f.id = x.from_column_id JOIN columns t ON t.id = x.to_column_id WHERE x.project_id = ? ORDER BY f.position, t.position`
			)
			.all(projectId);
		expect(edges.map((e) => `${e.from} → ${e.to}${e.rh ? ' (Mensch)' : ''}`)).toEqual([
			'Backlog → Refine',
			'Refine → Backlog',
			'Refine → Ready',
			'Ready → Refine',
			'Ready → In Arbeit',
			'In Arbeit → Ready',
			'In Arbeit → Review',
			'Review → In Arbeit',
			'Review → Abnahme',
			'Abnahme → Review',
			'Abnahme → Done (Mensch)',
			'Done → Abnahme',
			'Human Intervention → Human Answered (Mensch)'
		]);
	});

	it('marks exactly the Review column with the review flag (migration 009)', () => {
		const { db, projectId } = setup();
		const flagged = db
			.prepare('SELECT name FROM columns WHERE project_id = ? AND review = 1')
			.all(projectId) as { name: string }[];
		expect(flagged.map((c) => c.name)).toEqual(['Review']);
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
		expect(columnOf(a)).toBe('Backlog'); // default: the first normal column
	});

	it('creates tickets never in done, in human_answered only as user, and in human_intervention also as agent', () => {
		const { db, projectId, col } = setup();
		expect(
			caught(() => board.createTicket(db, user, projectId, { title: 'X', column_id: col.Done }))
				.code
		).toBe('invalid_column');
		const err = caught(() =>
			board.createTicket(db, dev, projectId, { title: 'X', column_id: col['Human Answered'] })
		);
		expect(err.code).toBe('requires_human');
		expect(err.message).toBe('Nur ein Mensch darf Tickets in „Human Answered“ anlegen.');
		board.createTicket(db, user, projectId, { title: 'Antwort', column_id: col['Human Answered'] });
		board.createTicket(db, dev, projectId, {
			title: 'Frage',
			column_id: col['Human Intervention']
		}); // an agent may escalate
		expect(
			db.prepare('SELECT count(*) AS n FROM tickets WHERE project_id = ?').get(projectId)?.n
		).toBe(2);
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
		const err = caught(() => board.updateTicket(db, dev, id, { column_id: col.Done } as never));
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
		const rolePrompts = (db: DatabaseSync, projectId: number) =>
			Object.fromEntries(
				(
					db
						.prepare(
							'SELECT name, role_prompt AS rolePrompt FROM columns WHERE project_id = ? ORDER BY position'
						)
						.all(projectId) as { name: string; rolePrompt: string }[]
				).map((r) => [r.name, r.rolePrompt])
			) as Record<string, string>;

		const COLUMNS_WITH_A_ROLE = [
			'Backlog',
			'Refine',
			'Ready',
			'In Arbeit',
			'Review',
			'Abnahme',
			'Human Intervention',
			'Human Answered'
		];

		it('gives every column a non-empty English role prompt, except Done', () => {
			const { db, projectId } = setup();
			const prompts = rolePrompts(db, projectId);
			for (const name of COLUMNS_WITH_A_ROLE) expect(prompts[name].trim()).not.toBe('');
			expect(prompts.Done.trim()).toBe('');
		});

		it.each(COLUMNS_WITH_A_ROLE)(
			'the %s role says what to do, what to deliver and when to stop, in that order',
			(name) => {
				const { db, projectId } = setup();
				const prompt = rolePrompts(db, projectId)[name];
				expect(prompt).toMatchSnapshot();
				const parts = ['Do: ', 'Deliver: ', 'Stop: '].map((label) => prompt.indexOf(label));
				expect(parts.every((at) => at >= 0)).toBe(true);
				expect(parts).toEqual([...parts].sort((a, b) => a - b));
			}
		);

		it('lets Refine propose scope and criteria itself and ask the human only for a genuine product decision', () => {
			const { db, projectId } = setup();
			const refine = rolePrompts(db, projectId).Refine;
			expect(refine).toContain('propose the scope');
			expect(refine).toContain('yourself');
			expect(refine).toContain('Ask the human only for a genuine product decision');
		});

		it('keeps Ready from refining: it picks the ticket up and moves it on', () => {
			const { db, projectId } = setup();
			expect(rolePrompts(db, projectId).Ready).toContain('do not refine');
		});

		it('has In Arbeit carry out the task and deliver the result as an unverified comment, without demanding a test it cannot run', () => {
			const { db, projectId } = setup();
			const inProgress = rolePrompts(db, projectId)['In Arbeit'];
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
			const { db, projectId } = setup();
			const prompts = Object.values(rolePrompts(db, projectId)).filter((text) => text !== '');
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
	it('rejects an illegal transition and names the allowed targets', () => {
		const { db, ticket, col, columnOf } = setup();
		const id = ticket();
		const err = caught(() => board.moveTicket(db, user, id, col.Review));
		expect(err.code).toBe('transition_not_allowed');
		expect(err.message).toBe(
			'STU-1 darf nicht von „Backlog“ nach „Review“ wechseln. Erlaubte Ziele: „Refine“, „Human Intervention“.'
		);
		expect(err.hint).toContain('allowedMoves');
		expect(columnOf(id)).toBe('Backlog');
	});

	it('reaches human_intervention from every column, and every column from human_answered', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket();
		for (const from of ['Backlog', 'In Arbeit', 'Review', 'Done', 'Human Answered']) {
			place(id, from);
			board.moveTicket(db, from === 'Done' ? user : dev, id, col['Human Intervention']); // out of done only the human (reopen)
			expect(columnOf(id)).toBe('Human Intervention');
		}
		place(id, 'Human Answered');
		expect(board.allowedMoves(db, id, dev).map((m) => [m.name, m.requiresHuman])).toEqual([
			['Backlog', false],
			['Refine', false],
			['Ready', false],
			['In Arbeit', false],
			['Review', false],
			['Abnahme', false],
			['Done', true],
			['Human Intervention', false]
		]);
		expect(caught(() => board.moveTicket(db, dev, id, col.Done)).code).toBe('requires_human'); // implicit edge, still human only
		board.moveTicket(db, dev, id, col.Backlog); // no stored edge
		expect(columnOf(id)).toBe('Backlog');
	});

	it('rejects a move into a done column while tasks are open', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket();
		place(id, 'Abnahme');
		const { id: task } = board.addTask(db, dev, id, 'Tests grün');
		const err = caught(() => board.moveTicket(db, user, id, col.Done));
		expect(err.code).toBe('open_tasks');
		expect(err.message).toBe('STU-1 hat 1 offene Tasks: „Tests grün“.');
		board.completeTask(db, dev, task);
		board.moveTicket(db, user, id, col.Done);
		expect(columnOf(id)).toBe('Done');
	});

	it('lets only the user move into a done column and into human_answered', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket();
		place(id, 'Abnahme');
		const err = caught(() => board.moveTicket(db, dev, id, col.Done));
		expect(err.code).toBe('requires_human');
		expect(err.message).toBe('Nur ein Mensch darf STU-1 nach „Done“ verschieben.');
		board.moveTicket(db, user, id, col.Done);
		expect(columnOf(id)).toBe('Done');

		place(id, 'Human Intervention');
		expect(caught(() => board.moveTicket(db, dev, id, col['Human Answered'])).code).toBe(
			'requires_human'
		);
	});

	it('lets only the user move a ticket out of a done column (reopen)', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket();
		place(id, 'Done');
		expect(
			board
				.allowedMoves(db, id, dev)
				.map((m) => [m.name, m.requiresHuman, m.blockers.map((b) => b.code)])
		).toEqual([
			['Abnahme', true, ['requires_human']],
			['Human Intervention', true, ['requires_human']]
		]);
		const err = caught(() => board.moveTicket(db, dev, id, col.Abnahme));
		expect(err.message).toBe('Nur ein Mensch darf STU-1 aus „Done“ wieder öffnen.');
		expect(err.hint).toContain('Folgeticket');
		board.moveTicket(db, user, id, col.Abnahme);
		expect(columnOf(id)).toBe('Abnahme');
	});

	it('rejects moving an epic to done while a child is open', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const epic = ticket({ type: 'epic' });
		const { id: noteId } = notes.createNote(db, user, { slug: 'epic-doku', title: 'N', body: '' });
		notes.linkTicket(db, user, noteId, epic, 'documents'); // epics are always docs_required — a note is linked first so that only open_children applies
		const child = ticket();
		board.linkRelation(db, user, epic, child, 'parent_of');
		place(epic, 'Abnahme');
		const err = caught(() => board.moveTicket(db, user, epic, col.Done));
		expect(err.code).toBe('open_children');
		expect(err.message).toBe('STU-1 hat nicht abgeschlossene Kind-Tickets: STU-2.');
		place(child, 'Done');
		board.moveTicket(db, user, epic, col.Done);
		expect(columnOf(epic)).toBe('Done');
	});

	it('rejects done without the docs_required note and allows it once a note is linked', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket({ docs_required: 1 });
		place(id, 'Abnahme');
		const err = caught(() => board.moveTicket(db, user, id, col.Done));
		expect(err.code).toBe('docs_required');
		expect(err.hint).toContain('createNote');

		const { id: noteId } = notes.createNote(db, user, { slug: 'n-1', title: 'N', body: '' });
		notes.linkTicket(db, user, noteId, id, 'documents');
		board.moveTicket(db, user, id, col.Done);
		expect(columnOf(id)).toBe('Done');
	});

	it('does not accept an archived note as docs_required evidence', () => {
		const { db, ticket, place, col } = setup();
		const id = ticket({ docs_required: 1 });
		const { id: noteId } = notes.createNote(db, user, { slug: 'n-2', title: 'N', body: '' });
		notes.linkTicket(db, user, noteId, id, 'documents');
		notes.archiveNote(db, user, noteId);
		place(id, 'Abnahme');
		expect(caught(() => board.moveTicket(db, user, id, col.Done)).code).toBe('docs_required');
	});

	it('applies to an agent actor too, independent of the requires_human edge (transitions are configurable)', () => {
		const { db, projectId, ticket, place, col } = setup();
		const id = ticket({ docs_required: 1 });
		place(id, 'Abnahme');
		const done = board.allowedMoves(db, id, dev).find((m) => m.name === 'Done');
		expect(done?.blockers.map((b) => b.code)).toEqual(['requires_human', 'docs_required']);

		// Isolated from requires_human: the Abnahme -> Done edge opened up for agents as a probe (not yet exposed as an API).
		db.prepare(
			'UPDATE transitions SET requires_human = 0 WHERE project_id = ? AND from_column_id = ? AND to_column_id = ?'
		).run(projectId, col.Abnahme, col.Done);
		expect(caught(() => board.moveTicket(db, dev, id, col.Done)).code).toBe('docs_required');
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
	it('lists targets including the human_* edges with blockers per actor', () => {
		const { db, ticket, place } = setup();
		const id = ticket();
		place(id, 'Abnahme');
		board.addTask(db, dev, id, 'offen');
		const view = (actor: Actor) =>
			board
				.allowedMoves(db, id, actor)
				.map((m) => [m.name, m.requiresHuman, m.blockers.map((b) => b.code)]);
		expect(view(dev)).toEqual([
			['Review', false, []],
			['Done', true, ['requires_human', 'open_tasks']],
			['Human Intervention', false, []]
		]);
		expect(view(user)[1]).toEqual(['Done', true, ['open_tasks']]);
		expect(board.allowedMoves(db, id, dev)[1].blockers[1].hint).toContain('completeTask');
	});
});

describe('review approval', () => {
	it('rejects self-approval and allows another agent and the human to approve', () => {
		const { db, ticket, place, col } = setup();
		const id = ticket();
		place(id, 'In Arbeit');
		board.moveTicket(db, dev, id, col.Review);
		const err = caught(() => board.approveReview(db, dev, id));
		expect(err.code).toBe('self_approval');
		expect(err.hint).toContain('anderer Agent');
		board.approveReview(db, reviewer, id);
		const row = db
			.prepare('SELECT review_approved_at, review_approved_by FROM tickets WHERE id = ?')
			.get(id);
		expect(row?.review_approved_at).not.toBeNull();
		expect(JSON.parse(row?.review_approved_by as string)).toEqual(reviewer);

		board.moveTicket(db, user, id, col['In Arbeit']);
		board.moveTicket(db, user, id, col.Review);
		board.approveReview(db, user, id); // the human may always approve
	});

	it('lets an agent approve only in a column flagged as review column, the human in any column', () => {
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

		db.prepare("UPDATE columns SET name = 'Prüfung' WHERE id = ?").run(col.Review);
		place(id, 'Review');
		board.approveReview(db, reviewer, id);
	});

	it('clears the approval when moved back to "In Arbeit" and keeps it when moved to done', () => {
		const { db, ticket, place, col } = setup();
		const approved = (id: number) =>
			db.prepare('SELECT review_approved_at AS at FROM tickets WHERE id = ?').get(id)?.at !== null;
		const id = ticket();
		place(id, 'Review');
		board.approveReview(db, reviewer, id);
		board.moveTicket(db, reviewer, id, col['In Arbeit']);
		expect(approved(id)).toBe(false);

		board.moveTicket(db, dev, id, col.Review);
		board.approveReview(db, reviewer, id);
		board.moveTicket(db, reviewer, id, col.Abnahme);
		expect(approved(id)).toBe(true);
		board.moveTicket(db, user, id, col.Done);
		expect(approved(id)).toBe(true);
	});

	it('clears the approval returning from a human column by its kind, not by column position', () => {
		const { db, ticket, place, col } = setup();
		const approved = (id: number) =>
			db.prepare('SELECT review_approved_at AS at FROM tickets WHERE id = ?').get(id)?.at !== null;
		// Move the human columns before Review, so a purely position-based rule would read the return as "forward".
		db.prepare('UPDATE columns SET position = -10 WHERE id = ?').run(col['Human Intervention']);
		db.prepare('UPDATE columns SET position = -9 WHERE id = ?').run(col['Human Answered']);

		const id = ticket();
		place(id, 'Review');
		board.approveReview(db, reviewer, id);
		board.moveTicket(db, dev, id, col['Human Intervention']); // moving into a human column keeps it, regardless of position
		expect(approved(id)).toBe(true);
		board.moveTicket(db, user, id, col['Human Answered']);
		expect(approved(id)).toBe(true);

		board.moveTicket(db, user, id, col.Review); // "forward" by the new position, but returning from a human column
		expect(approved(id)).toBe(false);
	});

	it('keeps a predecessor approved in Review unblocking its successor after it moves on to acceptance (review_ok)', () => {
		const { db, projectId, ticket, place, col } = setup();
		const [a, b] = [ticket(), ticket()];
		board.linkRelation(db, user, a, b, 'blocks');
		board.setBlocksSatisfiedAt(db, user, projectId, 'review_ok');
		place(a, 'Review');
		board.approveReview(db, reviewer, a);
		board.moveTicket(db, reviewer, a, col.Abnahme);
		expect(board.workableTickets(db, projectId, col.Backlog).map((r) => r.ref)).toEqual(['STU-2']);
	});
});

describe('workableTickets', () => {
	const refs = (rows: { ref: string }[]) => rows.map((r) => r.ref);

	it('hides tickets with unfinished blocks predecessors', () => {
		const { db, projectId, ticket, place, col } = setup();
		const [a, b] = [ticket(), ticket()];
		const done = ticket();
		place(done, 'Done');
		place(ticket(), 'Human Intervention'); // waits for the human, not workable
		board.linkRelation(db, user, a, b, 'blocks');
		expect(refs(board.workableTickets(db, projectId))).toEqual(['STU-1']);
		place(a, 'Done');
		expect(refs(board.workableTickets(db, projectId))).toEqual(['STU-2']);
		expect(refs(board.workableTickets(db, projectId, col['In Arbeit']))).toEqual([]);
	});

	it('respects blocks_satisfied_at: done versus review_ok', () => {
		const { db, projectId, ticket, place, col } = setup();
		const [a, b] = [ticket(), ticket()];
		board.linkRelation(db, user, a, b, 'blocks');
		place(a, 'Review');
		board.approveReview(db, reviewer, a);
		const workable = () => refs(board.workableTickets(db, projectId, col.Backlog));

		expect(workable()).toEqual([]); // default done: an approval is not enough
		board.setBlocksSatisfiedAt(db, user, projectId, 'review_ok');
		expect(workable()).toEqual(['STU-2']);
		board.moveTicket(db, reviewer, a, col['In Arbeit']); // the approval clears
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
		const { db, projectId, ticket, place } = setup();
		const closed = ticket();
		place(closed, 'Done');
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));

		tx(db, () => {
			board.createTicket(db, user, projectId, { title: 'Bleibt' });
			try {
				requestHuman(db, dev, closed, { question: 'Nacharbeit?' }); // writes comment and question, then the move out of done is refused
			} catch {
				// the caller decides to go on without the question
			}
		});
		off();

		expect(db.prepare('SELECT count(*) AS n FROM questions').get()?.n).toBe(0);
		expect(
			db.prepare('SELECT count(*) AS n FROM comments WHERE ticket_id = ?').get(closed)?.n
		).toBe(0);
		expect(db.prepare("SELECT count(*) AS n FROM tickets WHERE title = 'Bleibt'").get()?.n).toBe(1);
		expect(events.map((e) => e.type)).toEqual(['ticket.created']);
	});
});

describe('blockingPredecessors', () => {
	const refs = (rows: { ref: string }[]) => rows.map((r) => r.ref);

	it('lists the open predecessors that keep a ticket out of workableTickets', () => {
		const { db, projectId, ticket, place, col } = setup();
		const [open, finished, successor] = [ticket(), ticket(), ticket()];
		place(finished, 'Done');
		board.linkRelation(db, user, open, successor, 'blocks');
		board.linkRelation(db, user, finished, successor, 'blocks');
		expect(board.blockingPredecessors(db, successor)).toEqual([
			{ id: open, ref: 'STU-1', title: 'T', column: 'Backlog' }
		]);
		expect(refs(board.workableTickets(db, projectId, col.Backlog))).not.toContain('STU-3');

		place(open, 'Done');
		expect(board.blockingPredecessors(db, successor)).toEqual([]);
		expect(refs(board.workableTickets(db, projectId, col.Backlog))).toContain('STU-3');
	});

	it('counts an approved predecessor as finished only when the project says review_ok', () => {
		const { db, projectId, ticket, place } = setup();
		const [predecessor, successor] = [ticket(), ticket()];
		board.linkRelation(db, user, predecessor, successor, 'blocks');
		place(predecessor, 'Review');
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
