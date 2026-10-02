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

	it('Epics tragen docs_required immer: wird beim Anlegen erzwungen, explizites 0 wird abgelehnt (Anlegen und Ändern)', () => {
		const { db, projectId, ticket } = setup();
		const epic = board.createTicket(db, user, projectId, { title: 'Epic', type: 'epic' }).id;
		expect(db.prepare('SELECT docs_required FROM tickets WHERE id = ?').get(epic)).toEqual({ docs_required: 1 });
		expect(caught(() => board.createTicket(db, user, projectId, { title: 'X', type: 'epic', docs_required: 0 })).code).toBe('epic_docs_required');

		const plain = ticket();
		board.updateTicket(db, user, plain, { type: 'epic' });
		expect(db.prepare('SELECT docs_required FROM tickets WHERE id = ?').get(plain)).toEqual({ docs_required: 1 });
		const err = caught(() => board.updateTicket(db, user, plain, { docs_required: 0 }));
		expect(err.code).toBe('epic_docs_required');
		expect(err.message).toContain('STU-'); // Meldung nennt den Ticket-Ref
	});

	it('ein unbeteiligtes Update eines Epics schmuggelt docs_required nicht als geändertes Feld ins Event', () => {
		const { db, projectId } = setup();
		const epic = board.createTicket(db, user, projectId, { title: 'Epic', type: 'epic' }).id; // docs_required bereits 1
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));
		board.updateTicket(db, user, epic, { title: 'Anderer Titel' });
		off();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: 'ticket.updated', fields: ['title'] }); // kein docs_required in fields, obwohl das Epic es trägt

		const events2: StudioEvent[] = [];
		const off2 = subscribe((e) => events2.push(e));
		board.updateTicket(db, user, epic, {}); // leeres Update auf einem Epic bleibt No-op, kein Event
		off2();
		expect(events2).toEqual([]);
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
		const { id: noteId } = notes.createNote(db, user, { slug: 'epic-doku', title: 'N', body: '' });
		notes.linkTicket(db, user, noteId, epic, 'documents'); // Epics sind immer docs_required — Note vorab verknüpft, damit nur open_children prüft
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

	it('weist done mit fehlender docs_required-Note ab und lässt es mit verknüpfter Note zu', () => {
		const { db, ticket, place, col, columnOf } = setup();
		const id = ticket({ docs_required: 1 });
		place(id, 'Review');
		const err = caught(() => board.moveTicket(db, user, id, col.Done));
		expect(err.code).toBe('docs_required');
		expect(err.hint).toContain('createNote');

		const { id: noteId } = notes.createNote(db, user, { slug: 'n-1', title: 'N', body: '' });
		notes.linkTicket(db, user, noteId, id, 'documents');
		board.moveTicket(db, user, id, col.Done);
		expect(columnOf(id)).toBe('Done');
	});

	it('eine archivierte Note zählt nicht als docs_required-Nachweis', () => {
		const { db, ticket, place, col } = setup();
		const id = ticket({ docs_required: 1 });
		const { id: noteId } = notes.createNote(db, user, { slug: 'n-2', title: 'N', body: '' });
		notes.linkTicket(db, user, noteId, id, 'documents');
		notes.archiveNote(db, user, noteId);
		place(id, 'Review');
		expect(caught(() => board.moveTicket(db, user, id, col.Done)).code).toBe('docs_required');
	});

	it('gilt auch für einen Agent-Actor, unabhängig von der requires_human-Kante (#771: Transitionen sind konfigurierbar)', () => {
		const { db, projectId, ticket, place, col } = setup();
		const id = ticket({ docs_required: 1 });
		place(id, 'Review');
		const done = board.allowedMoves(db, id, dev).find((m) => m.name === 'Done');
		expect(done?.blockers.map((b) => b.code)).toEqual(['requires_human', 'docs_required']);

		// Isoliert von requires_human: die Kante Review -> Done probeweise für Agents freigegeben (#771 noch nicht als API vorhanden).
		db.prepare('UPDATE transitions SET requires_human = 0 WHERE project_id = ? AND from_column_id = ? AND to_column_id = ?').run(projectId, col.Review, col.Done);
		expect(caught(() => board.moveTicket(db, dev, id, col.Done)).code).toBe('docs_required');
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

	it('lets an agent approve only in a column flagged as review column, the human in any column', () => {
		const { db, ticket, place, col } = setup();
		const id = ticket();
		const err = caught(() => board.approveReview(db, reviewer, id));
		expect(err.code).toBe('not_in_review');
		expect(err.message).toContain('STU-1');
		expect(err.message).toContain('„Backlog“');
		expect(db.prepare('SELECT review_approved_at AS at FROM tickets WHERE id = ?').get(id)?.at).toBeNull();
		board.approveReview(db, user, id);

		db.prepare("UPDATE columns SET name = 'Prüfung' WHERE id = ?").run(col.Review);
		place(id, 'Review');
		board.approveReview(db, reviewer, id);
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

	it('lets mutations called inside a transaction join it: all or nothing, events after the outer commit', () => {
		const { db, projectId } = setup();
		const titles = () => db.prepare('SELECT title FROM tickets WHERE project_id = ? ORDER BY id').all(projectId).map((r) => r.title);
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

	it('rolls back a joined mutation that fails even when the caller catches its error, and keeps the caller\'s own writes', () => {
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
		expect(db.prepare('SELECT count(*) AS n FROM comments WHERE ticket_id = ?').get(closed)?.n).toBe(0);
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
		expect(board.blockingPredecessors(db, successor)).toEqual([{ id: open, ref: 'STU-1', title: 'T', column: 'Backlog' }]);
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
	const openTitles = (db: DatabaseSync, id: number) => db.prepare('SELECT title FROM tasks WHERE ticket_id = ? AND done_at IS NULL ORDER BY id').all(id).map((r) => r.title);

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
		expect(caught(() => board.updateTicket(db, dev, id, { title: '   ' })).code).toBe('empty_title');
		expect(caught(() => board.createTicket(db, user, projectId, { title: ' ' })).code).toBe('empty_title');
	});
});
