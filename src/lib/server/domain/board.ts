import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { StudioEvent } from '../events';
import { DomainError, tx, type Actor } from './core';

type Kind = 'normal' | 'done' | 'human_intervention' | 'human_answered';
type Column = { id: number; name: string; kind: Kind };
type Ticket = { id: number; project_id: number; column_id: number; moved_by: string | null; ref: string; column_name: string; column_kind: Kind };
type Emit = (event: StudioEvent) => void;
export type RelationType = 'parent_of' | 'blocks' | 'relates_to' | 'duplicate_of';
export type Blocker = { code: string; message: string; hint: string };
/** Ein erreichbares Ziel; `blockers` leer = der Wechsel ist für diesen Actor jetzt erlaubt. */
export type Move = { columnId: number; name: string; kind: Kind; requiresHuman: boolean; blockers: Blocker[] };

/** Direkt setzbare Ticketfelder — die Spalte wechselt nur über moveTicket, die Freigabe nur über approveReview. */
const FIELDS = ['title', 'description', 'type', 'docs_required', 'assignee', 'position', 'effort_estimate', 'effort_actual', 'effort_unit'] as const;
export type TicketFields = {
	title: string;
	description: string;
	type: 'ticket' | 'epic';
	docs_required: 0 | 1;
	assignee: string | null;
	position: number;
	effort_estimate: number | null;
	effort_actual: number | null;
	effort_unit: string | null;
};

const DEFAULT_COLUMNS: [string, Kind][] = [
	['Backlog', 'normal'],
	['In Arbeit', 'normal'],
	['Review', 'normal'],
	['Done', 'done'],
	['Human Intervention', 'human_intervention'],
	['Human Answered', 'human_answered']
];

/** Default für requires_human: Abschließen und „der Mensch hat geantwortet“ darf nur ein Mensch. */
const humanOnly = (kind: Kind) => kind === 'done' || kind === 'human_answered';
const label = (a: Actor) => (a.runId === undefined ? a.kind : `${a.kind} (Run ${a.runId})`);
const quoted = (names: string[]) => names.map((n) => `„${n}“`).join(', ');

function ticket(db: DatabaseSync, id: number): Ticket {
	const t = db
		.prepare(
			`SELECT t.id, t.project_id, t.column_id, t.moved_by, p.key || '-' || t.number AS ref, c.name AS column_name, c.kind AS column_kind
			FROM tickets t JOIN projects p ON p.id = t.project_id JOIN columns c ON c.id = t.column_id WHERE t.id = ?`
		)
		.get(id) as Ticket | undefined;
	if (!t) throw new DomainError('not_found', `Ticket ${id} gibt es nicht.`, 'Prüfe die Ticket-ID; workableTickets listet die Tickets eines Projekts.');
	return t;
}

function task(db: DatabaseSync, id: number) {
	const k = db.prepare('SELECT id, ticket_id, title FROM tasks WHERE id = ?').get(id) as { id: number; ticket_id: number; title: string } | undefined;
	if (!k) throw new DomainError('not_found', `Task ${id} gibt es nicht.`, 'Die Task-IDs stehen im Ticket-Detail.');
	return { ...k, t: ticket(db, k.ticket_id) };
}

const columns = (db: DatabaseSync, projectId: number) =>
	db.prepare('SELECT id, name, kind FROM columns WHERE project_id = ? ORDER BY position, id').all(projectId) as Column[];

/** Erreichbare Spalten: gespeicherte Transitionen plus implizit jede Spalte → human_intervention und human_answered → jede Spalte. */
function targets(db: DatabaseSync, t: Ticket) {
	const rows = db.prepare('SELECT to_column_id AS id, requires_human AS rh FROM transitions WHERE project_id = ? AND from_column_id = ?').all(t.project_id, t.column_id);
	const explicit = new Map(rows.map((r) => [r.id as number, r.rh === 1]));
	return columns(db, t.project_id)
		.filter((c) => c.id !== t.column_id && (explicit.has(c.id) || c.kind === 'human_intervention' || t.column_kind === 'human_answered'))
		.map((column) => ({ column, requiresHuman: explicit.get(column.id) ?? humanOnly(column.kind) }));
}

/** Die eine Regelprüfung für allowedMoves und moveTicket. */
function blockers(db: DatabaseSync, t: Ticket, to: Column, requiresHuman: boolean, actor: Actor): Blocker[] {
	const out: Blocker[] = [];
	if (requiresHuman && actor.kind !== 'user')
		out.push({
			code: 'requires_human',
			message: `Nur ein Mensch darf ${t.ref} nach „${to.name}“ verschieben.`,
			hint: 'Lass das Ticket in der aktuellen Spalte, den Wechsel übernimmt der Mensch. Brauchst du vorher eine Entscheidung: Frage als Kommentar, dann in die human_intervention-Spalte.'
		});
	if (to.kind !== 'done') return out;
	const open = db.prepare('SELECT title FROM tasks WHERE ticket_id = ? AND done_at IS NULL ORDER BY position, id').all(t.id);
	if (open.length)
		out.push({
			code: 'open_tasks',
			message: `${t.ref} hat ${open.length} offene Tasks: ${quoted(open.map((r) => r.title as string))}.`,
			hint: 'Erledige die Tasks (completeTask) oder lösche überholte mit Begründung (deleteTask).'
		});
	const kids = db
		.prepare(
			`SELECT p.key || '-' || k.number AS ref FROM ticket_relations r JOIN tickets k ON k.id = r.to_ticket_id
			JOIN projects p ON p.id = k.project_id JOIN columns c ON c.id = k.column_id
			WHERE r.from_ticket_id = ? AND r.type = 'parent_of' AND c.kind <> 'done' ORDER BY k.project_id, k.number`
		)
		.all(t.id);
	if (kids.length)
		out.push({
			code: 'open_children',
			message: `${t.ref} hat nicht abgeschlossene Kind-Tickets: ${kids.map((r) => r.ref).join(', ')}.`,
			hint: 'Schließe die Kind-Tickets zuerst ab oder löse sie per unlinkRelation vom Epic und begründe das im Kommentar.'
		});
	return out;
}

/** Nur freigegebene Felder; alles andere ist ein Fehler statt still ignoriert. Liefert [Spalte, Wert]-Paare. */
function fieldsOf(input: object): [string, SQLInputValue][] {
	return Object.entries(input)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => {
			if (!(FIELDS as readonly string[]).includes(k))
				throw new DomainError('unknown_field', `Das Ticketfeld „${k}“ ist nicht direkt setzbar.`, `Setzbar: ${FIELDS.join(', ')}. Spaltenwechsel über moveTicket.`);
			return [k, v];
		});
}

function comment(db: DatabaseSync, emit: Emit, actor: Actor, t: Ticket, body: string, system = false) {
	const row = db
		.prepare('INSERT INTO comments (ticket_id, author_kind, author, body) VALUES (?, ?, ?, ?) RETURNING id')
		.get(t.id, system ? 'system' : actor.kind, system ? 'system' : label(actor), body) as { id: number };
	emit({ type: 'comment.added', projectId: t.project_id, ticketId: t.id, actor, commentId: row.id });
	return { id: row.id };
}

function requireReason(reason: string) {
	if (!reason.trim())
		throw new DomainError('reason_required', 'Tasks ändern oder löschen geht nur mit Begründung.', 'Gib `reason` an — sie landet als System-Kommentar am Ticket.');
}

const reaches = (db: DatabaseSync, start: number, goal: number, type: RelationType) =>
	!!db
		.prepare(
			`WITH RECURSIVE r(id) AS (SELECT ?1 UNION SELECT x.to_ticket_id FROM ticket_relations x JOIN r ON x.from_ticket_id = r.id WHERE x.type = ?3)
			SELECT 1 FROM r WHERE id = ?2`
		)
		.get(start, goal, type);

/** Legt ein Projekt mit Default-Board an: Backlog ↔ In Arbeit ↔ Review ↔ Done, dazu human_intervention → human_answered. */
export function createProject(db: DatabaseSync, actor: Actor, p: { key: string; name: string; description?: string }): { id: number } {
	return tx(db, (emit) => {
		const { id } = db.prepare('INSERT INTO projects (key, name, description) VALUES (?, ?, ?) RETURNING id').get(p.key, p.name, p.description ?? '') as { id: number };
		const col = db.prepare('INSERT INTO columns (project_id, name, position, kind) VALUES (?, ?, ?, ?) RETURNING id');
		const ids = DEFAULT_COLUMNS.map(([name, kind], i) => (col.get(id, name, i, kind) as { id: number }).id);
		const tr = db.prepare('INSERT INTO transitions (project_id, from_column_id, to_column_id, requires_human) VALUES (?, ?, ?, ?)');
		const edge = (a: number, b: number) => tr.run(id, ids[a], ids[b], humanOnly(DEFAULT_COLUMNS[b][1]) ? 1 : 0);
		for (let i = 0; i < 3; i++) {
			edge(i, i + 1);
			edge(i + 1, i);
		}
		edge(4, 5);
		emit({ type: 'project.created', projectId: id, actor });
		return { id };
	});
}

export function setBlocksSatisfiedAt(db: DatabaseSync, actor: Actor, projectId: number, value: 'done' | 'review_ok') {
	tx(db, (emit) => {
		if (!db.prepare('UPDATE projects SET blocks_satisfied_at = ? WHERE id = ?').run(value, projectId).changes)
			throw new DomainError('not_found', `Projekt ${projectId} gibt es nicht.`, 'Prüfe die Projekt-ID.');
		emit({ type: 'project.updated', projectId, actor, blocksSatisfiedAt: value });
	});
}

/** Nummer = Projektzähler + 1; ohne `column_id` landet das Ticket in der ersten normalen Spalte. */
export function createTicket(
	db: DatabaseSync,
	actor: Actor,
	projectId: number,
	fields: Partial<TicketFields> & { title: string; column_id?: number }
): { id: number; number: number } {
	return tx(db, (emit) => {
		const { column_id, ...rest } = fields;
		const col = columns(db, projectId).find((c) => (column_id === undefined ? c.kind === 'normal' : c.id === column_id));
		if (!col) throw new DomainError('not_found', `Projekt ${projectId} hat keine Spalte ${column_id ?? 'der Art normal'}.`, 'Prüfe Projekt- und Spalten-ID.');
		if (col.kind === 'done')
			throw new DomainError('invalid_column', `Tickets starten nicht in der done-Spalte „${col.name}“.`, 'Lege das Ticket in einer anderen Spalte an; nach done führt nur moveTicket.');
		const f = fieldsOf(rest);
		const { n } = db.prepare('UPDATE projects SET ticket_seq = ticket_seq + 1 WHERE id = ? RETURNING ticket_seq AS n').get(projectId) as { n: number };
		const { id } = db
			.prepare(`INSERT INTO tickets (project_id, number, column_id, moved_by, ${f.map(([k]) => k).join(', ')}) VALUES (?, ?, ?, ?, ${f.map(() => '?').join(', ')}) RETURNING id`)
			.get(projectId, n, col.id, JSON.stringify(actor), ...f.map(([, v]) => v)) as { id: number };
		emit({ type: 'ticket.created', projectId, ticketId: id, actor });
		return { id, number: n };
	});
}

export function updateTicket(db: DatabaseSync, actor: Actor, ticketId: number, patch: Partial<TicketFields>) {
	tx(db, (emit) => {
		const t = ticket(db, ticketId);
		const f = fieldsOf(patch);
		if (!f.length) return;
		db.prepare(`UPDATE tickets SET ${f.map(([k]) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...f.map(([, v]) => v), t.id);
		emit({ type: 'ticket.updated', projectId: t.project_id, ticketId: t.id, actor, fields: f.map(([k]) => k) });
	});
}

export function deleteTicket(db: DatabaseSync, actor: Actor, ticketId: number) {
	tx(db, (emit) => {
		const t = ticket(db, ticketId);
		db.prepare('DELETE FROM tickets WHERE id = ?').run(t.id);
		emit({ type: 'ticket.deleted', projectId: t.project_id, ticketId: t.id, actor });
	});
}

export function allowedMoves(db: DatabaseSync, ticketId: number, actor: Actor): Move[] {
	const t = ticket(db, ticketId);
	return targets(db, t).map(({ column: c, requiresHuman }) => ({ columnId: c.id, name: c.name, kind: c.kind, requiresHuman, blockers: blockers(db, t, c, requiresHuman, actor) }));
}

export function moveTicket(db: DatabaseSync, actor: Actor, ticketId: number, columnId: number) {
	tx(db, (emit) => {
		const t = ticket(db, ticketId);
		if (t.column_id === columnId) return;
		const to = columns(db, t.project_id).find((c) => c.id === columnId);
		if (!to) throw new DomainError('not_found', `Spalte ${columnId} gibt es im Projekt von ${t.ref} nicht.`, 'allowedMoves listet die erreichbaren Spalten mit ID.');
		const moves = targets(db, t);
		const move = moves.find((m) => m.column.id === columnId);
		if (!move)
			throw new DomainError(
				'transition_not_allowed',
				`${t.ref} darf nicht von „${t.column_name}“ nach „${to.name}“ wechseln. Erlaubte Ziele: ${quoted(moves.map((m) => m.column.name))}.`,
				'Verschiebe über eine der erlaubten Spalten; allowedMoves zeigt alle Ziele samt Sperrgründen.'
			);
		const bs = blockers(db, t, to, move.requiresHuman, actor);
		if (bs.length) throw new DomainError(bs[0].code, bs.map((b) => b.message).join(' '), bs.map((b) => b.hint).join(' '));
		db.prepare('UPDATE tickets SET column_id = ?, moved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(columnId, JSON.stringify(actor), t.id);
		// Die Freigabe gilt dem geprüften Stand; zurück im normalen Fluss (z. B. „In Arbeit“) kann er sich ändern.
		if (to.kind === 'normal') db.prepare('UPDATE tickets SET review_approved_at = NULL, review_approved_by = NULL WHERE id = ?').run(t.id);
		emit({ type: 'ticket.moved', projectId: t.project_id, ticketId: t.id, actor, from: t.column_id, to: columnId });
	});
}

/** Review-Freigabe (ADR studio-012). Der Mensch darf immer; ein Agent nicht, wenn er das Ticket zuletzt verschoben hat. */
export function approveReview(db: DatabaseSync, actor: Actor, ticketId: number) {
	tx(db, (emit) => {
		const t = ticket(db, ticketId);
		const last = t.moved_by === null ? null : (JSON.parse(t.moved_by) as Actor);
		// ponytail: „Autor der letzten Arbeit“ ≈ wer zuletzt verschoben hat; mit Runs (#779) den letzten Arbeits-Run bzw. dessen Profil vergleichen
		if (actor.kind !== 'user' && last?.kind === actor.kind && last.runId === actor.runId)
			throw new DomainError(
				'self_approval',
				`${t.ref} wurde zuletzt von dir (${label(actor)}) verschoben — eigene Arbeit darfst du nicht freigeben.`,
				'Die Freigabe erteilt ein anderer Agent (Review-Run) oder der Mensch. Halte dein Ergebnis als Kommentar fest.'
			);
		db.prepare('UPDATE tickets SET review_approved_at = CURRENT_TIMESTAMP, review_approved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(actor), t.id);
		emit({ type: 'ticket.review_approved', projectId: t.project_id, ticketId: t.id, actor });
	});
}

/**
 * Tickets ohne offene blocks-Vorgänger (ohne done- und human_intervention-Spalten). Offen ist ein Vorgänger,
 * solange er nicht in einer done-Spalte liegt — bei `blocks_satisfied_at = 'review_ok'` genügt seine Review-Freigabe.
 */
export function workableTickets(db: DatabaseSync, projectId: number, columnId?: number) {
	return db
		.prepare(
			`SELECT t.id, p.key || '-' || t.number AS ref, t.title, t.type, t.column_id, t.assignee
			FROM tickets t JOIN columns c ON c.id = t.column_id JOIN projects p ON p.id = t.project_id
			WHERE t.project_id = ?1 AND (?2 IS NULL OR t.column_id = ?2) AND c.kind NOT IN ('done', 'human_intervention')
				AND NOT EXISTS (
					SELECT 1 FROM ticket_relations r JOIN tickets b ON b.id = r.from_ticket_id JOIN columns bc ON bc.id = b.column_id
					WHERE r.to_ticket_id = t.id AND r.type = 'blocks' AND bc.kind <> 'done'
						AND NOT (p.blocks_satisfied_at = 'review_ok' AND b.review_approved_at IS NOT NULL))
			ORDER BY c.position, t.position, t.number`
		)
		.all(projectId, columnId ?? null) as { id: number; ref: string; title: string; type: 'ticket' | 'epic'; column_id: number; assignee: string | null }[];
}

export function addTask(db: DatabaseSync, actor: Actor, ticketId: number, title: string): { id: number } {
	return tx(db, (emit) => {
		const t = ticket(db, ticketId);
		const { id } = db.prepare('INSERT INTO tasks (ticket_id, title) VALUES (?, ?) RETURNING id').get(t.id, title) as { id: number };
		emit({ type: 'task.added', projectId: t.project_id, ticketId: t.id, actor, taskId: id });
		return { id };
	});
}

function setTaskDone(db: DatabaseSync, actor: Actor, taskId: number, done: boolean) {
	tx(db, (emit) => {
		const { t } = task(db, taskId);
		db.prepare(`UPDATE tasks SET done_at = ${done ? 'coalesce(done_at, CURRENT_TIMESTAMP)' : 'NULL'} WHERE id = ?`).run(taskId);
		emit({ type: done ? 'task.completed' : 'task.reopened', projectId: t.project_id, ticketId: t.id, actor, taskId });
	});
}
export const completeTask = (db: DatabaseSync, actor: Actor, taskId: number) => setTaskDone(db, actor, taskId, true);
export const reopenTask = (db: DatabaseSync, actor: Actor, taskId: number) => setTaskDone(db, actor, taskId, false);

/** Benennt einen Task um; die Begründung landet als System-Kommentar am Ticket. */
export function updateTask(db: DatabaseSync, actor: Actor, taskId: number, title: string, reason: string) {
	tx(db, (emit) => {
		requireReason(reason);
		const { t, title: old } = task(db, taskId);
		db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(title, taskId);
		emit({ type: 'task.updated', projectId: t.project_id, ticketId: t.id, actor, taskId });
		comment(db, emit, actor, t, `Task „${old}“ umbenannt in „${title}“ von ${label(actor)}. Grund: ${reason}`, true);
	});
}

/** Löscht einen Task; die Begründung landet als System-Kommentar am Ticket. */
export function deleteTask(db: DatabaseSync, actor: Actor, taskId: number, reason: string) {
	tx(db, (emit) => {
		requireReason(reason);
		const { t, title } = task(db, taskId);
		db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
		emit({ type: 'task.deleted', projectId: t.project_id, ticketId: t.id, actor, taskId });
		comment(db, emit, actor, t, `Task „${title}“ gelöscht von ${label(actor)}. Grund: ${reason}`, true);
	});
}

export function addComment(db: DatabaseSync, actor: Actor, ticketId: number, body: string): { id: number } {
	return tx(db, (emit) => comment(db, emit, actor, ticket(db, ticketId), body));
}

/** Verknüpft zwei Tickets (idempotent). parent_of und blocks bleiben zyklenfrei. */
export function linkRelation(db: DatabaseSync, actor: Actor, fromId: number, toId: number, type: RelationType) {
	tx(db, (emit) => {
		const from = ticket(db, fromId);
		const to = ticket(db, toId);
		if (from.id === to.id) throw new DomainError('self_relation', `${from.ref} kann nicht mit sich selbst verknüpft werden.`, 'Wähle als Ziel ein anderes Ticket.');
		if ((type === 'parent_of' || type === 'blocks') && reaches(db, to.id, from.id, type))
			throw new DomainError(
				'cycle',
				`${from.ref} ${type} ${to.ref} ergäbe einen Zyklus: ${to.ref} führt über ${type} schon zu ${from.ref}.`,
				'Prüfe die Richtung (from ist Eltern-Ticket bzw. Vorgänger) oder entferne zuerst die bestehende Kante mit unlinkRelation.'
			);
		if (db.prepare('INSERT INTO ticket_relations (from_ticket_id, to_ticket_id, type) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(from.id, to.id, type).changes)
			emit({ type: 'relation.linked', projectId: from.project_id, ticketId: from.id, actor, toTicketId: to.id, relation: type });
	});
}

export function unlinkRelation(db: DatabaseSync, actor: Actor, fromId: number, toId: number, type: RelationType) {
	tx(db, (emit) => {
		const from = ticket(db, fromId);
		if (db.prepare('DELETE FROM ticket_relations WHERE from_ticket_id = ? AND to_ticket_id = ? AND type = ?').run(from.id, toId, type).changes)
			emit({ type: 'relation.unlinked', projectId: from.project_id, ticketId: from.id, actor, toTicketId: toId, relation: type });
	});
}
