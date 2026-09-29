import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import { subscribe, type StudioEvent } from '../events';
import * as board from './board';
import { DomainError, tx, type Actor } from './core';
import * as runs from './runs';

const user: Actor = { kind: 'user' };
const dev: Actor = { kind: 'agent', runId: 1 };
const reviewer: Actor = { kind: 'agent', runId: 2 };

/** Agent-Actors handeln in echten Runs (comments.run_id hat einen FK): legt Run 1 und 2 in einem eigenen Projekt an. */
function withRuns(db: DatabaseSync) {
	const p = board.createProject(db, user, { key: 'RUN', name: 'Runs' }).id;
	const ticketId = board.createTicket(db, user, p, { title: 'Runs' }).id;
	const profileId = runs.createProfile(db, user, { name: 'Test', executor: 'builtin', provider: 'openai-compatible', model: 'm' }).id;
	for (let i = 0; i < 2; i++) runs.createRun(db, user, { ticketId, profileId });
}

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	withRuns(db);
	const { id: projectId } = board.createProject(db, user, { key: 'STU', name: 'Studio' });
	const rows = db.prepare('SELECT name, id FROM columns WHERE project_id = ?').all(projectId);
	const col = Object.fromEntries(rows.map((r) => [r.name, r.id])) as Record<string, number>;
	const ticket = (fields: Partial<board.TicketFields> = {}) => board.createTicket(db, user, projectId, { title: 'T', ...fields }).id;
	/** Setzt den Ausgangszustand direkt, ohne die Regeln zu durchlaufen. */
	const place = (id: number, column: string) => db.prepare('UPDATE tickets SET column_id = ? WHERE id = ?').run(col[column], id);
	const columnOf = (id: number) => db.prepare('SELECT c.name FROM tickets t JOIN columns c ON c.id = t.column_id WHERE t.id = ?').get(id)?.name;
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
	it('legt Default-Spalten und lineare Transitionen an (Wechsel nach done und human_answered nur durch Menschen)', () => {
		const { db, projectId } = setup();
		const cols = db.prepare('SELECT name, kind FROM columns WHERE project_id = ? ORDER BY position').all(projectId);
		expect(cols.map((c) => `${c.name}:${c.kind}`)).toEqual([
			'Backlog:normal',
			'In Arbeit:normal',
			'Review:normal',
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
			'Backlog → In Arbeit',
			'In Arbeit → Backlog',
			'In Arbeit → Review',
			'Review → In Arbeit',
			'Review → Done (Mensch)',
			'Done → Review',
			'Human Intervention → Human Answered (Mensch)'
		]);
	});

	it('vergibt Ticketnummern fortlaufend pro Projekt und nie doppelt, auch nach Löschen', () => {
		const { db, projectId, ticket, columnOf } = setup();
		const other = board.createProject(db, user, { key: 'OTH', name: 'Anderes' }).id;
		const a = ticket();
		const b = ticket();
		board.deleteTicket(db, user, b);
		const c = board.createTicket(db, user, projectId, { title: 'C' });
		expect(board.createTicket(db, user, other, { title: 'X' }).number).toBe(1);
		const numbers = db.prepare('SELECT number FROM tickets WHERE project_id = ? ORDER BY number').all(projectId);
		expect(numbers.map((r) => r.number)).toEqual([1, 3]);
		expect(c.number).toBe(3);
		expect(columnOf(a)).toBe('Backlog'); // Default: erste normale Spalte
	});

	it('Anlage: nie in done, in human_answered nur durch user, in human_intervention auch durch Agent', () => {
		const { db, projectId, col } = setup();
		expect(caught(() => board.createTicket(db, user, projectId, { title: 'X', column_id: col.Done })).code).toBe('invalid_column');
		const err = caught(() => board.createTicket(db, dev, projectId, { title: 'X', column_id: col['Human Answered'] }));
		expect(err.code).toBe('requires_human');
		expect(err.message).toBe('Nur ein Mensch darf Tickets in „Human Answered“ anlegen.');
		board.createTicket(db, user, projectId, { title: 'Antwort', column_id: col['Human Answered'] });
		board.createTicket(db, dev, projectId, { title: 'Frage', column_id: col['Human Intervention'] }); // Agent darf eskalieren
		expect(db.prepare('SELECT count(*) AS n FROM tickets WHERE project_id = ?').get(projectId)?.n).toBe(2);
	});

	it('updateTicket setzt nur freigegebene Felder', () => {
		const { db, ticket, col } = setup();
		const id = ticket();
		board.updateTicket(db, dev, id, { title: 'Neu', docs_required: 1 });
		expect(db.prepare('SELECT title, docs_required FROM tickets WHERE id = ?').get(id)).toEqual({ title: 'Neu', docs_required: 1 });
		const err = caught(() => board.updateTicket(db, dev, id, { column_id: col.Done } as never));
		expect(err.code).toBe('unknown_field');
		expect(err.hint).toContain('moveTicket');
	});
});

describe('moveTicket', () => {
	it('weist eine illegale Transition ab und nennt die erlaubten Ziele', () => {
		const { db, ticket, col, columnOf } = setup();
		const id = ticket();
		const err = caught(() => board.moveTicket(db, user, id, col.Review));
		expect(err.code).toBe('transition_not_allowed');
		expect(err.message).toBe('STU-1 darf nicht von „Backlog“ nach „Review“ wechseln. Erlaubte Ziele: „In Arbeit“, „Human Intervention“.');
		expect(err.hint).toContain('allowedMoves');
		expect(columnOf(id)).toBe('Backlog');
	});

	it('erreicht human_intervention aus jeder Spalte und aus human_answered jede Spalte', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket();
		for (const from of ['Backlog', 'In Arbeit', 'Review', 'Done', 'Human Answered']) {
			place(id, from);
			board.moveTicket(db, from === 'Done' ? user : dev, id, col['Human Intervention']); // aus done nur der Mensch (Reopen)
			expect(columnOf(id)).toBe('Human Intervention');
		}
		place(id, 'Human Answered');
		expect(board.allowedMoves(db, id, dev).map((m) => [m.name, m.requiresHuman])).toEqual([
			['Backlog', false],
			['In Arbeit', false],
			['Review', false],
			['Done', true],
			['Human Intervention', false]
		]);
		expect(caught(() => board.moveTicket(db, dev, id, col.Done)).code).toBe('requires_human'); // implizite Kante, trotzdem nur Mensch
		board.moveTicket(db, dev, id, col.Backlog); // keine gespeicherte Kante
		expect(columnOf(id)).toBe('Backlog');
	});

	it('weist den Wechsel in eine done-Spalte mit offenen Tasks ab', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket();
		place(id, 'Review');
		const { id: task } = board.addTask(db, dev, id, 'Tests grün');
		const err = caught(() => board.moveTicket(db, user, id, col.Done));
		expect(err.code).toBe('open_tasks');
		expect(err.message).toBe('STU-1 hat 1 offene Tasks: „Tests grün“.');
		board.completeTask(db, dev, task);
		board.moveTicket(db, user, id, col.Done);
		expect(columnOf(id)).toBe('Done');
	});

	it('lässt nur user in eine done-Spalte und nach human_answered verschieben', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket();
		place(id, 'Review');
		const err = caught(() => board.moveTicket(db, dev, id, col.Done));
		expect(err.code).toBe('requires_human');
		expect(err.message).toBe('Nur ein Mensch darf STU-1 nach „Done“ verschieben.');
		board.moveTicket(db, user, id, col.Done);
		expect(columnOf(id)).toBe('Done');

		place(id, 'Human Intervention');
		expect(caught(() => board.moveTicket(db, dev, id, col['Human Answered'])).code).toBe('requires_human');
	});

	it('lässt nur user ein Ticket aus einer done-Spalte heraus verschieben (Reopen)', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket();
		place(id, 'Done');
		expect(board.allowedMoves(db, id, dev).map((m) => [m.name, m.requiresHuman, m.blockers.map((b) => b.code)])).toEqual([
			['Review', true, ['requires_human']],
			['Human Intervention', true, ['requires_human']]
		]);
		const err = caught(() => board.moveTicket(db, dev, id, col.Review));
		expect(err.message).toBe('Nur ein Mensch darf STU-1 aus „Done“ wieder öffnen.');
		expect(err.hint).toContain('Folgeticket');
		board.moveTicket(db, user, id, col.Review);
		expect(columnOf(id)).toBe('Review');
	});

	it('weist Epic → done mit offenem Kind ab', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const epic = ticket({ type: 'epic' });
		const child = ticket();
		board.linkRelation(db, user, epic, child, 'parent_of');
		place(epic, 'Review');
		const err = caught(() => board.moveTicket(db, user, epic, col.Done));
		expect(err.code).toBe('open_children');
		expect(err.message).toBe('STU-1 hat nicht abgeschlossene Kind-Tickets: STU-2.');
		place(child, 'Done');
		board.moveTicket(db, user, epic, col.Done);
		expect(columnOf(epic)).toBe('Done');
	});
});

describe('linkRelation', () => {
	it('weist Zyklen in parent_of und blocks sowie Selbst-Relationen ab', () => {
		const { db, ticket } = setup();
		const [a, b, c] = [ticket(), ticket(), ticket()];
		board.linkRelation(db, user, a, b, 'blocks');
		board.linkRelation(db, user, b, c, 'blocks');
		const err = caught(() => board.linkRelation(db, user, c, a, 'blocks'));
		expect(err.code).toBe('cycle');
		expect(err.message).toBe('STU-3 blocks STU-1 ergäbe einen Zyklus: STU-1 führt über blocks schon zu STU-3.');

		board.linkRelation(db, user, a, b, 'parent_of');
		expect(caught(() => board.linkRelation(db, user, b, a, 'parent_of')).code).toBe('cycle');
		expect(caught(() => board.linkRelation(db, user, a, a, 'relates_to')).code).toBe('self_relation');

		board.linkRelation(db, user, c, a, 'relates_to'); // kein Zyklus-Begriff für relates_to
		board.linkRelation(db, user, a, b, 'blocks'); // idempotent
		expect(db.prepare('SELECT count(*) AS n FROM ticket_relations').get()?.n).toBe(4);
	});
});

describe('allowedMoves', () => {
	it('liefert Ziele inkl. human_*-Kanten mit Sperrgründen je Actor', () => {
		const { db, ticket, place } = setup();
		const id = ticket();
		place(id, 'Review');
		board.addTask(db, dev, id, 'offen');
		const view = (actor: Actor) => board.allowedMoves(db, id, actor).map((m) => [m.name, m.requiresHuman, m.blockers.map((b) => b.code)]);
		expect(view(dev)).toEqual([
			['In Arbeit', false, []],
			['Done', true, ['requires_human', 'open_tasks']],
			['Human Intervention', false, []]
		]);
		expect(view(user)[1]).toEqual(['Done', true, ['open_tasks']]);
		expect(board.allowedMoves(db, id, dev)[1].blockers[1].hint).toContain('completeTask');
	});
});

describe('Review-Freigabe', () => {
	it('weist Selbstfreigabe ab und erlaubt sie anderem Agent und dem Menschen', () => {
		const { db, ticket, place, col } = setup();
		const id = ticket();
		place(id, 'In Arbeit');
		board.moveTicket(db, dev, id, col.Review);
		const err = caught(() => board.approveReview(db, dev, id));
		expect(err.code).toBe('self_approval');
		expect(err.hint).toContain('anderer Agent');
		board.approveReview(db, reviewer, id);
		const row = db.prepare('SELECT review_approved_at, review_approved_by FROM tickets WHERE id = ?').get(id);
		expect(row?.review_approved_at).not.toBeNull();
		expect(JSON.parse(row?.review_approved_by as string)).toEqual(reviewer);

		board.moveTicket(db, user, id, col['In Arbeit']);
		board.moveTicket(db, user, id, col.Review);
		board.approveReview(db, user, id); // der Mensch darf immer
	});

	it('erlischt beim Zurückschieben nach „In Arbeit“, bleibt beim Wechsel nach done', () => {
		const { db, ticket, place, col } = setup();
		const approved = (id: number) => db.prepare('SELECT review_approved_at AS at FROM tickets WHERE id = ?').get(id)?.at !== null;
		const id = ticket();
		place(id, 'Review');
		board.approveReview(db, reviewer, id);
		board.moveTicket(db, reviewer, id, col['In Arbeit']);
		expect(approved(id)).toBe(false);

		board.moveTicket(db, dev, id, col.Review);
		board.approveReview(db, reviewer, id);
		board.moveTicket(db, user, id, col.Done);
		expect(approved(id)).toBe(true);
	});
});

describe('workableTickets', () => {
	const refs = (rows: { ref: string }[]) => rows.map((r) => r.ref);

	it('blendet Tickets mit offenen blocks-Vorgängern aus', () => {
		const { db, projectId, ticket, place, col } = setup();
		const [a, b] = [ticket(), ticket()];
		const done = ticket();
		place(done, 'Done');
		place(ticket(), 'Human Intervention'); // wartet auf den Menschen, nicht bearbeitbar
		board.linkRelation(db, user, a, b, 'blocks');
		expect(refs(board.workableTickets(db, projectId))).toEqual(['STU-1']);
		place(a, 'Done');
		expect(refs(board.workableTickets(db, projectId))).toEqual(['STU-2']);
		expect(refs(board.workableTickets(db, projectId, col['In Arbeit']))).toEqual([]);
	});

	it('respektiert blocks_satisfied_at: done vs. review_ok', () => {
		const { db, projectId, ticket, place, col } = setup();
		const [a, b] = [ticket(), ticket()];
		board.linkRelation(db, user, a, b, 'blocks');
		place(a, 'Review');
		board.approveReview(db, reviewer, a);
		const workable = () => refs(board.workableTickets(db, projectId, col.Backlog));

		expect(workable()).toEqual([]); // Default done: Freigabe reicht nicht
		board.setBlocksSatisfiedAt(db, user, projectId, 'review_ok');
		expect(workable()).toEqual(['STU-2']);
		board.moveTicket(db, reviewer, a, col['In Arbeit']); // Freigabe erlischt
		expect(workable()).toEqual([]);
	});
});

describe('Tasks mit Begründung', () => {
	it('updateTask und deleteTask schreiben einen System-Kommentar; ohne Begründung abgewiesen', () => {
		const { db, ticket } = setup();
		const id = ticket();
		const { id: task } = board.addTask(db, dev, id, 'Alt');
		expect(caught(() => board.deleteTask(db, dev, task, '  ')).code).toBe('reason_required');

		board.updateTask(db, dev, task, 'Neu', 'präziser');
		board.deleteTask(db, dev, task, 'durch Folgeticket überholt');
		expect(db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(0);
		const comments = db.prepare('SELECT author_kind, author, body FROM comments WHERE ticket_id = ? ORDER BY id').all(id);
		expect(comments).toEqual([
			{ author_kind: 'system', author: 'system', body: 'Task „Alt“ umbenannt in „Neu“ von agent (Run 1). Grund: präziser' },
			{ author_kind: 'system', author: 'system', body: 'Task „Neu“ gelöscht von agent (Run 1). Grund: durch Folgeticket überholt' }
		]);
	});
});

describe('Event-Bus', () => {
	it('jede Mutation emittiert ein Event, und zwar außerhalb der Transaktion', () => {
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
		board.approveReview(db, reviewer, a);
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
		expect(inTx.every((t) => t === false)).toBe(true); // erst nach COMMIT publiziert
		expect(events[5]).toMatchObject({ ticketId: a, actor: dev, to: inArbeit });
	});

	it('eine zurückgerollte Transaktion meldet nichts, auch wenn sie schon emittiert hatte', () => {
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
});
