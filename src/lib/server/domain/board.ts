import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { StudioEvent } from '../events';
import { actorLabel as label, DomainError, tx, type Actor } from './core';

type Kind = 'normal' | 'done' | 'human_intervention' | 'human_answered';
type Column = { id: number; name: string; kind: Kind };
export type Ticket = {
	id: number;
	project_id: number;
	column_id: number;
	moved_by: string | null;
	ref: string;
	column_name: string;
	column_kind: Kind;
	type: 'ticket' | 'epic';
	docs_required: 0 | 1;
};
type Emit = (event: StudioEvent) => void;
export type RelationType = 'parent_of' | 'blocks' | 'relates_to' | 'duplicate_of';
export type Blocker = { code: string; message: string; hint: string };
/** Ein erreichbares Ziel; `blockers` leer = der Wechsel ist für diesen Actor jetzt erlaubt. */
export type Move = {
	columnId: number;
	name: string;
	kind: Kind;
	requiresHuman: boolean;
	blockers: Blocker[];
};

/** Direkt setzbare Ticketfelder — die Spalte wechselt nur über moveTicket, die Freigabe nur über approveReview. */
const FIELDS = [
	'title',
	'description',
	'type',
	'docs_required',
	'assignee',
	'position',
	'effort_estimate',
	'effort_actual',
	'effort_unit'
] as const;
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

// Generic role prompts for the default "Software" template: short, English, no product, project, tool or path names
// — an agent's role comes from the prompt's role block (assemblePrompt), built from this text, never from the
// column name.
const BACKLOG_ROLE =
	'Capture new work with enough detail that someone else could size it. Move it along once it is ready for scope and acceptance criteria to be worked out.';
const REFINE_ROLE =
	'Make the scope, the effort and the acceptance criteria explicit before moving a ticket on. Leave a title-only ticket for someone else to flesh out instead of advancing it as is.';
const READY_ROLE =
	'Pick up a ticket only once every blocker is finished. If the description no longer matches reality, send it back for refinement with a comment explaining why.';
const IN_PROGRESS_ROLE =
	'For a bug, reproduce it with a failing test before you fix it. A probe someone used to demonstrate a finding becomes a permanent regression test. Move the ticket on once every acceptance criterion is met.';
const REVIEW_ROLE =
	'Check the work against its acceptance criteria, not your own taste. Leave findings as a comment and send it back, or approve it and move it on.';
const ACCEPTANCE_ROLE =
	'Finished work waits here for a human to accept it in a batch. Do not act on a ticket sitting in this column.';
const HUMAN_INTERVENTION_ROLE =
	'A question is open and blocks this ticket. Read it in the comments and wait for an answer instead of resuming work.';
const HUMAN_ANSWERED_ROLE =
	'An open question now has an answer. Read it in the comments, then move the ticket back into work.';

const DEFAULT_COLUMNS: [string, Kind, string][] = [
	['Backlog', 'normal', BACKLOG_ROLE],
	['Refine', 'normal', REFINE_ROLE],
	['Ready', 'normal', READY_ROLE],
	['In Arbeit', 'normal', IN_PROGRESS_ROLE],
	['Review', 'normal', REVIEW_ROLE],
	['Abnahme', 'normal', ACCEPTANCE_ROLE],
	['Done', 'done', ''],
	['Human Intervention', 'human_intervention', HUMAN_INTERVENTION_ROLE],
	['Human Answered', 'human_answered', HUMAN_ANSWERED_ROLE]
];

/** Default für requires_human: Abschließen und „der Mensch hat geantwortet“ darf nur ein Mensch. */
const humanOnly = (kind: Kind) => kind === 'done' || kind === 'human_answered';
const quoted = (names: string[]) => names.map((n) => `„${n}“`).join(', ');

export function ticket(db: DatabaseSync, id: number): Ticket {
	const t = db
		.prepare(
			`SELECT t.id, t.project_id, t.column_id, t.moved_by, t.type, t.docs_required, p.key || '-' || t.number AS ref, c.name AS column_name, c.kind AS column_kind
			FROM tickets t JOIN projects p ON p.id = t.project_id JOIN columns c ON c.id = t.column_id WHERE t.id = ?`
		)
		.get(id) as Ticket | undefined;
	if (!t)
		throw new DomainError(
			'not_found',
			`Ticket ${id} gibt es nicht.`,
			'Prüfe die Ticket-ID; workableTickets listet die Tickets eines Projekts.'
		);
	return t;
}

function task(db: DatabaseSync, id: number) {
	const k = db.prepare('SELECT id, ticket_id, title FROM tasks WHERE id = ?').get(id) as
		{ id: number; ticket_id: number; title: string } | undefined;
	if (!k)
		throw new DomainError(
			'not_found',
			`Task ${id} gibt es nicht.`,
			'Die Task-IDs stehen im Ticket-Detail.'
		);
	return { ...k, t: ticket(db, k.ticket_id) };
}

const columns = (db: DatabaseSync, projectId: number) =>
	db
		.prepare('SELECT id, name, kind FROM columns WHERE project_id = ? ORDER BY position, id')
		.all(projectId) as Column[];

/**
 * Erreichbare Spalten: gespeicherte Transitionen plus implizit jede Spalte → human_intervention und human_answered → jede Spalte.
 * Aus einer done-Spalte heraus (Reopen) darf nur der Mensch — unabhängig von der Kante.
 */
function targets(db: DatabaseSync, t: Ticket) {
	const rows = db
		.prepare(
			'SELECT to_column_id AS id, requires_human AS rh FROM transitions WHERE project_id = ? AND from_column_id = ?'
		)
		.all(t.project_id, t.column_id);
	const explicit = new Map(rows.map((r) => [r.id as number, r.rh === 1]));
	return columns(db, t.project_id)
		.filter(
			(c) =>
				c.id !== t.column_id &&
				(explicit.has(c.id) ||
					c.kind === 'human_intervention' ||
					t.column_kind === 'human_answered')
		)
		.map((column) => ({
			column,
			requiresHuman: t.column_kind === 'done' || (explicit.get(column.id) ?? humanOnly(column.kind))
		}));
}

/** Die eine Regelprüfung für allowedMoves und moveTicket. */
function blockers(
	db: DatabaseSync,
	t: Ticket,
	to: Column,
	requiresHuman: boolean,
	actor: Actor
): Blocker[] {
	const out: Blocker[] = [];
	if (requiresHuman && actor.kind !== 'user') out.push(requiresHumanBlocker(t, to));
	if (to.kind === 'done') out.push(...completionBlockers(db, t));
	return out;
}

function requiresHumanBlocker(t: Ticket, to: Column): Blocker {
	if (t.column_kind === 'done')
		return {
			code: 'requires_human',
			message: `Nur ein Mensch darf ${t.ref} aus „${t.column_name}“ wieder öffnen.`,
			hint: 'Abgenommene Tickets öffnet nur der Mensch. Für Nacharbeit ein Folgeticket anlegen und per relates_to verknüpfen.'
		};
	return {
		code: 'requires_human',
		message: `Nur ein Mensch darf ${t.ref} nach „${to.name}“ verschieben.`,
		hint: 'Lass das Ticket in der aktuellen Spalte, den Wechsel übernimmt der Mensch. Brauchst du vorher eine Entscheidung: Frage als Kommentar, dann in die human_intervention-Spalte.'
	};
}

function completionBlockers(db: DatabaseSync, t: Ticket): Blocker[] {
	return [openTasksBlocker(db, t), openChildrenBlocker(db, t), missingNoteBlocker(db, t)].filter(
		(b) => b !== undefined
	);
}

function openTasksBlocker(db: DatabaseSync, t: Ticket): Blocker | undefined {
	const open = db
		.prepare(
			'SELECT title FROM tasks WHERE ticket_id = ? AND done_at IS NULL ORDER BY position, id'
		)
		.all(t.id);
	if (!open.length) return undefined;
	return {
		code: 'open_tasks',
		message: `${t.ref} hat ${open.length} offene Tasks: ${quoted(open.map((r) => r.title as string))}.`,
		hint: 'Erledige die Tasks (completeTask) oder lösche überholte mit Begründung (deleteTask).'
	};
}

function openChildrenBlocker(db: DatabaseSync, t: Ticket): Blocker | undefined {
	const kids = db
		.prepare(
			`SELECT p.key || '-' || k.number AS ref FROM ticket_relations r JOIN tickets k ON k.id = r.to_ticket_id
			JOIN projects p ON p.id = k.project_id JOIN columns c ON c.id = k.column_id
			WHERE r.from_ticket_id = ? AND r.type = 'parent_of' AND c.kind <> 'done' ORDER BY k.project_id, k.number`
		)
		.all(t.id);
	if (!kids.length) return undefined;
	return {
		code: 'open_children',
		message: `${t.ref} hat nicht abgeschlossene Kind-Tickets: ${kids.map((r) => r.ref).join(', ')}.`,
		hint: 'Schließe die Kind-Tickets zuerst ab oder löse sie per unlinkRelation vom Epic und begründe das im Kommentar.'
	};
}

function missingNoteBlocker(db: DatabaseSync, t: Ticket): Blocker | undefined {
	if (!t.docs_required) return undefined;
	const hasNote = db
		.prepare(
			'SELECT 1 FROM note_tickets nt JOIN notes n ON n.id = nt.note_id WHERE nt.ticket_id = ? AND n.archived = 0'
		)
		.get(t.id);
	if (hasNote) return undefined;
	return {
		code: 'docs_required',
		message: `${t.ref} verlangt vor dem Abschluss eine verknüpfte Note, hat aber keine.`,
		hint: 'Lege eine Note an (createNote) und verknüpfe sie mit dem Ticket (linkTicket, z. B. relation "documents").'
	};
}

/**
 * Epics tragen docs_required immer: fehlt es, wird es gesetzt; explizit auf 0 gesetzt ist ein Fehler. `current` ist der
 * gespeicherte Wert (0 bei createTicket, da die Zeile noch nicht existiert) — ist er schon 1, bleibt `fields` unverändert,
 * sonst würde jedes Update eines Epics (auch nur der Titel) still ein docs_required-Feld einschmuggeln, das sich gar nicht
 * geändert hat: kein No-op mehr, ein irreführendes `ticket.updated`-Event mit `fields:['docs_required']`.
 */
function withEpicDocsRequired<T extends { type?: string; docs_required?: 0 | 1 }>(
	type: string,
	fields: T,
	current: 0 | 1,
	ref?: string
): T {
	if (type !== 'epic') return fields;
	if (fields.docs_required === 0)
		throw new DomainError(
			'epic_docs_required',
			`${ref ? ref + ': ' : ''}Epics brauchen docs_required — das lässt sich nicht ausschalten.`,
			'Lass docs_required weg oder setze es auf 1; für Epics ist es immer an.'
		);
	return fields.docs_required === 1 || current === 1 ? fields : { ...fields, docs_required: 1 };
}

/** Nur freigegebene Felder; alles andere ist ein Fehler statt still ignoriert. Liefert [Spalte, Wert]-Paare. */
function fieldsOf(input: object): [string, SQLInputValue][] {
	return Object.entries(input)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => {
			if (!(FIELDS as readonly string[]).includes(k))
				throw new DomainError(
					'unknown_field',
					`Das Ticketfeld „${k}“ ist nicht direkt setzbar.`,
					`Setzbar: ${FIELDS.join(', ')}. Spaltenwechsel über moveTicket.`
				);
			if (k === 'title' && !String(v).trim())
				throw new DomainError(
					'empty_title',
					'Ein Ticket braucht einen Titel.',
					'Gib einen Titel an, der sagt, worum es im Ticket geht.'
				);
			return [k, v];
		});
}

/** Writes a comment inside an open transaction; `addComment` is the standalone mutation. */
export function appendComment(
	db: DatabaseSync,
	emit: Emit,
	actor: Actor,
	t: Ticket,
	body: string,
	system = false
) {
	const row = db
		.prepare(
			'INSERT INTO comments (ticket_id, author_kind, author, body, run_id) VALUES (?, ?, ?, ?, ?) RETURNING id'
		)
		.get(
			t.id,
			system ? 'system' : actor.kind,
			system ? 'system' : label(actor),
			body,
			actor.runId ?? null
		) as { id: number };
	emit({
		type: 'comment.added',
		projectId: t.project_id,
		ticketId: t.id,
		actor,
		commentId: row.id
	});
	return { id: row.id };
}

function requireReason(reason: string) {
	if (!reason.trim())
		throw new DomainError(
			'reason_required',
			'Tasks ändern oder löschen geht nur mit Begründung.',
			'Gib `reason` an — sie landet als System-Kommentar am Ticket.'
		);
}

const reaches = (db: DatabaseSync, start: number, goal: number, type: RelationType) =>
	!!db
		.prepare(
			`WITH RECURSIVE r(id) AS (SELECT ?1 UNION SELECT x.to_ticket_id FROM ticket_relations x JOIN r ON x.from_ticket_id = r.id WHERE x.type = ?3)
			SELECT 1 FROM r WHERE id = ?2`
		)
		.get(start, goal, type);

/** Creates a project with the default "Software" board: Backlog ↔ Refine ↔ Ready ↔ In Arbeit ↔ Review ↔ Abnahme ↔ Done, plus human_intervention → human_answered. */
export function createProject(
	db: DatabaseSync,
	actor: Actor,
	p: { key: string; name: string; description?: string }
): { id: number } {
	return tx(db, (emit) => {
		const { id } = db
			.prepare('INSERT INTO projects (key, name, description) VALUES (?, ?, ?) RETURNING id')
			.get(p.key, p.name, p.description ?? '') as { id: number };
		const col = db.prepare(
			'INSERT INTO columns (project_id, name, position, kind, role_prompt, review) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
		);
		const ids = DEFAULT_COLUMNS.map(
			([name, kind, rolePrompt], i) =>
				(col.get(id, name, i, kind, rolePrompt, name === 'Review' ? 1 : 0) as { id: number }).id
		);
		const tr = db.prepare(
			'INSERT INTO transitions (project_id, from_column_id, to_column_id, requires_human) VALUES (?, ?, ?, ?)'
		);
		const edge = (a: number, b: number) =>
			tr.run(id, ids[a], ids[b], humanOnly(DEFAULT_COLUMNS[b][1]) ? 1 : 0);
		const doneIndex = DEFAULT_COLUMNS.findIndex(([, kind]) => kind === 'done');
		for (let i = 0; i < doneIndex; i++) {
			edge(i, i + 1);
			edge(i + 1, i);
		}
		edge(
			DEFAULT_COLUMNS.findIndex(([, kind]) => kind === 'human_intervention'),
			DEFAULT_COLUMNS.findIndex(([, kind]) => kind === 'human_answered')
		);
		emit({ type: 'project.created', projectId: id, actor });
		return { id };
	});
}

export function setBlocksSatisfiedAt(
	db: DatabaseSync,
	actor: Actor,
	projectId: number,
	value: 'done' | 'review_ok'
) {
	tx(db, (emit) => {
		if (
			!db.prepare('UPDATE projects SET blocks_satisfied_at = ? WHERE id = ?').run(value, projectId)
				.changes
		)
			throw new DomainError(
				'not_found',
				`Projekt ${projectId} gibt es nicht.`,
				'Prüfe die Projekt-ID.'
			);
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
		const col = startColumn(db, actor, projectId, column_id);
		const f = fieldsOf(withEpicDocsRequired(rest.type ?? 'ticket', rest, 0));
		const { n } = db
			.prepare(
				'UPDATE projects SET ticket_seq = ticket_seq + 1 WHERE id = ? RETURNING ticket_seq AS n'
			)
			.get(projectId) as { n: number };
		const { id } = db
			.prepare(
				`INSERT INTO tickets (project_id, number, column_id, moved_by, ${f.map(([k]) => k).join(', ')}) VALUES (?, ?, ?, ?, ${f.map(() => '?').join(', ')}) RETURNING id`
			)
			.get(projectId, n, col.id, JSON.stringify(actor), ...f.map(([, v]) => v)) as { id: number };
		emit({ type: 'ticket.created', projectId, ticketId: id, actor });
		return { id, number: n };
	});
}

function startColumn(
	db: DatabaseSync,
	actor: Actor,
	projectId: number,
	columnId: number | undefined
): Column {
	const col = columns(db, projectId).find((c) =>
		columnId === undefined ? c.kind === 'normal' : c.id === columnId
	);
	if (!col)
		throw new DomainError(
			'not_found',
			`Projekt ${projectId} hat keine Spalte ${columnId ?? 'der Art normal'}.`,
			'Prüfe Projekt- und Spalten-ID.'
		);
	if (col.kind === 'done')
		throw new DomainError(
			'invalid_column',
			`Tickets starten nicht in der done-Spalte „${col.name}“.`,
			'Lege das Ticket in einer anderen Spalte an; nach done führt nur moveTicket.'
		);
	if (col.kind === 'human_answered' && actor.kind !== 'user')
		throw new DomainError(
			'requires_human',
			`Nur ein Mensch darf Tickets in „${col.name}“ anlegen.`,
			'Lege das Ticket in einer normalen Spalte an. Eine Frage an den Menschen: als Kommentar, dann in die human_intervention-Spalte.'
		);
	return col;
}

export function updateTicket(
	db: DatabaseSync,
	actor: Actor,
	ticketId: number,
	patch: Partial<TicketFields>
) {
	tx(db, (emit) => {
		const t = ticket(db, ticketId);
		const f = fieldsOf(withEpicDocsRequired(patch.type ?? t.type, patch, t.docs_required, t.ref));
		if (!f.length) return;
		db.prepare(
			`UPDATE tickets SET ${f.map(([k]) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
		).run(...f.map(([, v]) => v), t.id);
		emit({
			type: 'ticket.updated',
			projectId: t.project_id,
			ticketId: t.id,
			actor,
			fields: f.map(([k]) => k)
		});
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
	return targets(db, t).map(({ column: c, requiresHuman }) => ({
		columnId: c.id,
		name: c.name,
		kind: c.kind,
		requiresHuman,
		blockers: blockers(db, t, c, requiresHuman, actor)
	}));
}

export function moveTicket(db: DatabaseSync, actor: Actor, ticketId: number, columnId: number) {
	tx(db, (emit) => applyMove(db, emit, actor, ticket(db, ticketId), columnId));
}

/** Moves a ticket inside an open transaction, with the same rules as `moveTicket`. */
export function applyMove(db: DatabaseSync, emit: Emit, actor: Actor, t: Ticket, columnId: number) {
	if (t.column_id === columnId) return;
	const cols = columns(db, t.project_id);
	const to = cols.find((c) => c.id === columnId);
	if (!to)
		throw new DomainError(
			'not_found',
			`Spalte ${columnId} gibt es im Projekt von ${t.ref} nicht.`,
			'allowedMoves listet die erreichbaren Spalten mit ID.'
		);
	assertMoveAllowed(db, actor, t, to);
	db.prepare(
		'UPDATE tickets SET column_id = ?, moved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
	).run(columnId, JSON.stringify(actor), t.id);
	if (invalidatesApproval(t, to, cols))
		db.prepare(
			'UPDATE tickets SET review_approved_at = NULL, review_approved_by = NULL WHERE id = ?'
		).run(t.id);
	emit({
		type: 'ticket.moved',
		projectId: t.project_id,
		ticketId: t.id,
		actor,
		from: t.column_id,
		to: columnId
	});
}

function assertMoveAllowed(db: DatabaseSync, actor: Actor, t: Ticket, to: Column) {
	const moves = targets(db, t);
	const move = moves.find((m) => m.column.id === to.id);
	if (!move)
		throw new DomainError(
			'transition_not_allowed',
			`${t.ref} darf nicht von „${t.column_name}“ nach „${to.name}“ wechseln. Erlaubte Ziele: ${quoted(moves.map((m) => m.column.name))}.`,
			'Verschiebe über eine der erlaubten Spalten; allowedMoves zeigt alle Ziele samt Sperrgründen.'
		);
	const bs = blockers(db, t, to, move.requiresHuman, actor);
	if (bs.length)
		throw new DomainError(
			bs[0].code,
			bs.map((b) => b.message).join(' '),
			bs.map((b) => b.hint).join(' ')
		);
}

/**
 * The approval is good for the reviewed state; it clears only when the ticket moves back into earlier work, or
 * returns from a human column into a normal one — the human column case is judged by kind, not by where the
 * human columns happen to sit, so reordering the board cannot flip the direction.
 */
function invalidatesApproval(t: Ticket, to: Column, cols: Column[]): boolean {
	if (to.kind !== 'normal') return false;
	const returnsFromHuman =
		t.column_kind === 'human_intervention' || t.column_kind === 'human_answered';
	const movesBack = cols.indexOf(to) < cols.findIndex((c) => c.id === t.column_id);
	return returnsFromHuman || movesBack;
}

/** Review approval. The human may always; an agent only in a review column and not after it moved the ticket last. */
export function approveReview(db: DatabaseSync, actor: Actor, ticketId: number) {
	tx(db, (emit) => {
		const t = ticket(db, ticketId);
		const inReviewColumn =
			db.prepare('SELECT review FROM columns WHERE id = ?').get(t.column_id)?.review === 1;
		if (actor.kind !== 'user' && !inReviewColumn)
			throw new DomainError(
				'not_in_review',
				`${t.ref} liegt in „${t.column_name}“, keiner Review-Spalte; ein Agent gibt nur im Review frei.`,
				'Freigeben gehört zur Review-Rolle. Halte dein Ergebnis als Kommentar fest; freigeben kann ein Review-Run oder der Mensch.'
			);
		const last = t.moved_by === null ? null : (JSON.parse(t.moved_by) as Actor);
		// ponytail: „Autor der letzten Arbeit“ ≈ wer zuletzt verschoben hat; mit Runs (#779) den letzten Arbeits-Run bzw. dessen Profil vergleichen
		if (actor.kind !== 'user' && last?.kind === actor.kind && last.runId === actor.runId)
			throw new DomainError(
				'self_approval',
				`${t.ref} wurde zuletzt von dir (${label(actor)}) verschoben — eigene Arbeit darfst du nicht freigeben.`,
				'Die Freigabe erteilt ein anderer Agent (Review-Run) oder der Mensch. Halte dein Ergebnis als Kommentar fest.'
			);
		db.prepare(
			'UPDATE tickets SET review_approved_at = CURRENT_TIMESTAMP, review_approved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
		).run(JSON.stringify(actor), t.id);
		emit({ type: 'ticket.review_approved', projectId: t.project_id, ticketId: t.id, actor });
	});
}

/** SQL condition for an unfinished `blocks` predecessor `b` in column `bc`, judged by the successor's project `p`. */
const PREDECESSOR_OPEN = `bc.kind <> 'done' AND NOT (p.blocks_satisfied_at = 'review_ok' AND b.review_approved_at IS NOT NULL)`;

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
					WHERE r.to_ticket_id = t.id AND r.type = 'blocks' AND ${PREDECESSOR_OPEN})
			ORDER BY c.position, t.position, t.number`
		)
		.all(projectId, columnId ?? null) as {
		id: number;
		ref: string;
		title: string;
		type: 'ticket' | 'epic';
		column_id: number;
		assignee: string | null;
	}[];
}

export type Predecessor = { id: number; ref: string; title: string; column: string };

/** The `blocks` predecessors that keep a ticket out of `workableTickets`. */
export function blockingPredecessors(db: DatabaseSync, ticketId: number): Predecessor[] {
	const t = ticket(db, ticketId);
	return db
		.prepare(
			`SELECT b.id, bp.key || '-' || b.number AS ref, b.title, bc.name AS "column"
			FROM ticket_relations r JOIN tickets b ON b.id = r.from_ticket_id JOIN projects bp ON bp.id = b.project_id
			JOIN columns bc ON bc.id = b.column_id JOIN projects p ON p.id = ?2
			WHERE r.to_ticket_id = ?1 AND r.type = 'blocks' AND ${PREDECESSOR_OPEN}
			ORDER BY b.project_id, b.number`
		)
		.all(t.id, t.project_id) as Predecessor[];
}

export function addTask(
	db: DatabaseSync,
	actor: Actor,
	ticketId: number,
	title: string
): { id: number } {
	return { id: addTasks(db, actor, ticketId, [title]).ids[0] };
}

/** Adds all tasks or none. */
export function addTasks(
	db: DatabaseSync,
	actor: Actor,
	ticketId: number,
	titles: string[]
): { ids: number[] } {
	return tx(db, (emit) => {
		const t = ticket(db, ticketId);
		if (titles.some((title) => !title.trim()))
			throw new DomainError(
				'empty_title',
				`Ein Task für ${t.ref} hat keinen Titel.`,
				'Gib jedem Task einen Titel, der das Akzeptanzkriterium nennt.'
			);
		const insert = db.prepare('INSERT INTO tasks (ticket_id, title) VALUES (?, ?) RETURNING id');
		const ids = titles.map((title) => {
			const { id } = insert.get(t.id, title) as { id: number };
			emit({ type: 'task.added', projectId: t.project_id, ticketId: t.id, actor, taskId: id });
			return id;
		});
		return { ids };
	});
}

/** Completes tasks of one ticket, all or none: an id that is not a task of this ticket rejects the whole call. */
export function completeTasks(db: DatabaseSync, actor: Actor, ticketId: number, taskIds: number[]) {
	tx(db, (emit) => {
		const t = ticket(db, ticketId);
		const own = db
			.prepare('SELECT id FROM tasks WHERE ticket_id = ? ORDER BY position, id')
			.all(t.id)
			.map((r) => r.id as number);
		const foreign = taskIds.filter((id) => !own.includes(id));
		if (foreign.length)
			throw new DomainError(
				'not_found',
				`${t.ref} hat keine Tasks mit den IDs ${foreign.join(', ')}.`,
				own.length
					? `Die Tasks von ${t.ref} haben die IDs ${own.join(', ')}.`
					: `${t.ref} hat noch keine Tasks.`
			);
		const complete = db.prepare(
			'UPDATE tasks SET done_at = coalesce(done_at, CURRENT_TIMESTAMP) WHERE id = ?'
		);
		for (const taskId of new Set(taskIds)) {
			complete.run(taskId);
			emit({ type: 'task.completed', projectId: t.project_id, ticketId: t.id, actor, taskId });
		}
	});
}

function setTaskDone(db: DatabaseSync, actor: Actor, taskId: number, done: boolean) {
	tx(db, (emit) => {
		const { t } = task(db, taskId);
		db.prepare(
			`UPDATE tasks SET done_at = ${done ? 'coalesce(done_at, CURRENT_TIMESTAMP)' : 'NULL'} WHERE id = ?`
		).run(taskId);
		emit({
			type: done ? 'task.completed' : 'task.reopened',
			projectId: t.project_id,
			ticketId: t.id,
			actor,
			taskId
		});
	});
}
export const completeTask = (db: DatabaseSync, actor: Actor, taskId: number) =>
	setTaskDone(db, actor, taskId, true);
export const reopenTask = (db: DatabaseSync, actor: Actor, taskId: number) =>
	setTaskDone(db, actor, taskId, false);

/** Benennt einen Task um; die Begründung landet als System-Kommentar am Ticket. */
export function updateTask(
	db: DatabaseSync,
	actor: Actor,
	taskId: number,
	title: string,
	reason: string
) {
	tx(db, (emit) => {
		requireReason(reason);
		const { t, title: old } = task(db, taskId);
		db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(title, taskId);
		emit({ type: 'task.updated', projectId: t.project_id, ticketId: t.id, actor, taskId });
		appendComment(
			db,
			emit,
			actor,
			t,
			`Task „${old}“ umbenannt in „${title}“ von ${label(actor)}. Grund: ${reason}`,
			true
		);
	});
}

/** Löscht einen Task; die Begründung landet als System-Kommentar am Ticket. */
export function deleteTask(db: DatabaseSync, actor: Actor, taskId: number, reason: string) {
	tx(db, (emit) => {
		requireReason(reason);
		const { t, title } = task(db, taskId);
		db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
		emit({ type: 'task.deleted', projectId: t.project_id, ticketId: t.id, actor, taskId });
		appendComment(
			db,
			emit,
			actor,
			t,
			`Task „${title}“ gelöscht von ${label(actor)}. Grund: ${reason}`,
			true
		);
	});
}

export function addComment(
	db: DatabaseSync,
	actor: Actor,
	ticketId: number,
	body: string
): { id: number } {
	return tx(db, (emit) => appendComment(db, emit, actor, ticket(db, ticketId), body));
}

/** Verknüpft zwei Tickets (idempotent). parent_of und blocks bleiben zyklenfrei. */
export function linkRelation(
	db: DatabaseSync,
	actor: Actor,
	fromId: number,
	toId: number,
	type: RelationType
) {
	tx(db, (emit) => {
		const from = ticket(db, fromId);
		const to = ticket(db, toId);
		if (from.id === to.id)
			throw new DomainError(
				'self_relation',
				`${from.ref} kann nicht mit sich selbst verknüpft werden.`,
				'Wähle als Ziel ein anderes Ticket.'
			);
		if ((type === 'parent_of' || type === 'blocks') && reaches(db, to.id, from.id, type))
			throw new DomainError(
				'cycle',
				`${from.ref} ${type} ${to.ref} ergäbe einen Zyklus: ${to.ref} führt über ${type} schon zu ${from.ref}.`,
				'Prüfe die Richtung (from ist Eltern-Ticket bzw. Vorgänger) oder entferne zuerst die bestehende Kante mit unlinkRelation.'
			);
		if (
			db
				.prepare(
					'INSERT INTO ticket_relations (from_ticket_id, to_ticket_id, type) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
				)
				.run(from.id, to.id, type).changes
		)
			emit({
				type: 'relation.linked',
				projectId: from.project_id,
				ticketId: from.id,
				actor,
				toTicketId: to.id,
				relation: type
			});
	});
}

export function unlinkRelation(
	db: DatabaseSync,
	actor: Actor,
	fromId: number,
	toId: number,
	type: RelationType
) {
	tx(db, (emit) => {
		const from = ticket(db, fromId);
		if (
			db
				.prepare(
					'DELETE FROM ticket_relations WHERE from_ticket_id = ? AND to_ticket_id = ? AND type = ?'
				)
				.run(from.id, toId, type).changes
		)
			emit({
				type: 'relation.unlinked',
				projectId: from.project_id,
				ticketId: from.id,
				actor,
				toTicketId: toId,
				relation: type
			});
	});
}
