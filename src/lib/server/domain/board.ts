import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { StudioEvent } from '../events';
import {
	actorLabel as label,
	chainRootOf,
	DomainError,
	OPEN_QUESTION,
	tx,
	type Actor
} from './core';
import { DEFAULT_VARIANT } from '../../variant';
import {
	STEP_LABELS,
	VARIANTS,
	VARIANT_LABELS,
	type Phase,
	type Step,
	type Variant
} from './variants';

export type Column = { id: number; name: string; step: Step; phase: Phase };
export type Ticket = {
	id: number;
	project_id: number;
	column_id: number;
	moved_by: string | null;
	ref: string;
	column_name: string;
	column_step: Step;
	column_phase: Phase;
	type: 'ticket' | 'epic';
	docs_required: 0 | 1;
};
type Emit = (event: StudioEvent) => void;
export type RelationType = 'parent_of' | 'blocks' | 'relates_to' | 'duplicate_of';
/** Who can fulfil a task; finishing a step requires only the agent's tasks. */
export const TASK_OWNERS = ['agent', 'system', 'human'] as const;
export type TaskOwner = (typeof TASK_OWNERS)[number];
export type Blocker = { code: string; message: string; hint: string };
/** A reachable target; empty `blockers` = this actor may make the move now. */
export type Move = {
	columnId: number;
	name: string;
	phase: Phase;
	blockers: Blocker[];
};

/** Ticket fields that can be set directly — the column changes only through moveTicket, the approval only through approveReview. */
const FIELDS = [
	'title',
	'description',
	'type',
	'docs_required',
	'assignee',
	'position',
	'size'
] as const;
export type TicketFields = {
	title: string;
	description: string;
	type: 'ticket' | 'epic';
	docs_required: 0 | 1;
	assignee: string | null;
	position: number;
	size: (typeof SIZES)[number] | null;
};
const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

const quoted = (names: string[]) => names.map((n) => `„${n}“`).join(', ') || 'keine';

export function ticket(db: DatabaseSync, id: number): Ticket {
	const t = db
		.prepare(
			`SELECT t.id, t.project_id, t.column_id, t.moved_by, t.type, t.docs_required, p.key || '-' || t.number AS ref,
				c.name AS column_name, c.step AS column_step, c.phase AS column_phase
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

export const columns = (db: DatabaseSync, projectId: number) =>
	db
		.prepare('SELECT id, name, step, phase FROM columns WHERE project_id = ? ORDER BY position, id')
		.all(projectId) as Column[];

/** The human reaches every column of the variant. An agent moves a ticket only by finishing its step (`finishStep`). */
function targets(db: DatabaseSync, t: Ticket, actor: Actor): Column[] {
	if (actor.kind !== 'user') return [];
	return columns(db, t.project_id).filter((c) => c.id !== t.column_id);
}

/** The single rule check shared by allowedMoves and moveTicket. */
function blockers(db: DatabaseSync, t: Ticket, to: Column): Blocker[] {
	return to.phase === 'done' ? completionBlockers(db, t) : [];
}

function notReachable(t: Ticket, to: Column): DomainError {
	return new DomainError(
		'requires_human',
		`Nur ein Mensch darf ${t.ref} von „${t.column_name}“ nach „${to.name}“ verschieben.`,
		'Einen Schritt beendest du mit finish_step. Lass das Ticket, wo es ist; für Nacharbeit an einem fertigen Ticket ein Folgeticket anlegen und per relates_to verknüpfen.'
	);
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
			WHERE r.from_ticket_id = ? AND r.type = 'parent_of' AND c.phase <> 'done' ORDER BY k.project_id, k.number`
		)
		.all(t.id);
	if (!kids.length) return undefined;
	return {
		code: 'open_children',
		message: `${t.ref} hat nicht abgeschlossene Kind-Tickets: ${kids.map((r) => r.ref).join(', ')}.`,
		hint: 'Schließe die Kind-Tickets zuerst ab oder löse sie per unlinkRelation vom Epic und begründe das im Kommentar.'
	};
}

export const hasLinkedNote = (db: DatabaseSync, ticketId: number) =>
	db
		.prepare(
			'SELECT 1 FROM note_tickets nt JOIN notes n ON n.id = nt.note_id WHERE nt.ticket_id = ? AND n.archived = 0'
		)
		.get(ticketId) !== undefined;

function missingNoteBlocker(db: DatabaseSync, t: Ticket): Blocker | undefined {
	if (!t.docs_required || hasLinkedNote(db, t.id)) return undefined;
	return {
		code: 'docs_required',
		message: `${t.ref} verlangt vor dem Abschluss eine verknüpfte Note, hat aber keine.`,
		hint: 'Lege eine Note an (createNote) und verknüpfe sie mit dem Ticket (linkTicket, z. B. relation "documents").'
	};
}

/**
 * Epics always carry docs_required: it is set when missing, and an explicit 0 is an error. `current` is the stored
 * value (0 on create); when it is already 1, `fields` stays unchanged, so an epic update does not report docs_required
 * as a changed field.
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

/** Only the allowed fields; anything else is an error instead of being ignored silently. Returns [column, value] pairs. */
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
			if (k === 'size' && v !== null && !(SIZES as readonly unknown[]).includes(v))
				throw new DomainError(
					'invalid_size',
					`„${String(v)}“ ist keine Größe.`,
					`Erlaubt: ${SIZES.join(', ')}.`
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

/** Creates a project with one column per step of its variant, in the variant's order. */
export function createProject(
	db: DatabaseSync,
	actor: Actor,
	p: { key: string; name: string; description?: string },
	variant: Variant = DEFAULT_VARIANT
): { id: number } {
	return tx(db, (emit) => {
		checkNewProject(db, p);
		checkVariant(variant);
		const { id } = db
			.prepare(
				'INSERT INTO projects (key, name, description, variant) VALUES (?, ?, ?, ?) RETURNING id'
			)
			.get(p.key, p.name, p.description ?? '', variant) as { id: number };
		const column = db.prepare(
			'INSERT INTO columns (project_id, step, name, position) VALUES (?, ?, ?, ?)'
		);
		VARIANTS[variant].forEach((step, position) =>
			column.run(id, step, STEP_LABELS[step], position)
		);
		emit({ type: 'project.created', projectId: id, actor });
		return { id };
	});
}

function checkVariant(variant: string) {
	if (!Object.hasOwn(VARIANTS, variant))
		throw new DomainError(
			'invalid_variant',
			`Die Variante „${variant}“ gibt es nicht.`,
			`Wähle eine der Varianten: ${Object.values(VARIANT_LABELS).join(', ')}.`
		);
}

/** Key and name each identify a project for the human, so neither may repeat; names compare without case. */
function checkNewProject(db: DatabaseSync, p: { key: string; name: string }) {
	if (!p.name.trim())
		throw new DomainError(
			'empty_name',
			'Ein Projekt braucht einen Namen.',
			'Gib einen Namen an, der sagt, worum es im Projekt geht, z. B. „Webseite“.'
		);
	if (!/^[A-Z][A-Z0-9]*$/.test(p.key))
		throw new DomainError(
			'invalid_key',
			'Der Key besteht aus Großbuchstaben und Ziffern und beginnt mit einem Buchstaben.',
			'Wähle einen kurzen Key wie WEB; er steht vor jeder Ticketnummer (WEB-1).'
		);
	const taken = db
		.prepare('SELECT key, name FROM projects WHERE key = ? OR name = ? COLLATE NOCASE')
		.get(p.key, p.name) as { key: string; name: string } | undefined;
	if (taken?.key === p.key)
		throw new DomainError(
			'key_taken',
			`Den Key „${p.key}“ hat schon das Projekt „${taken.name}“.`,
			`Wähle einen anderen Key, z. B. ${p.key}2, oder arbeite im Projekt „${taken.name}“ weiter.`
		);
	if (taken)
		throw new DomainError(
			'name_taken',
			`Ein Projekt „${taken.name}“ gibt es schon (${taken.key}).`,
			`Wähle einen anderen Namen oder arbeite im vorhandenen Projekt ${taken.key} weiter.`
		);
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

/** Number = project counter + 1; without `column_id` the ticket lands in the backlog. */
export function createTicket(
	db: DatabaseSync,
	actor: Actor,
	projectId: number,
	fields: Partial<TicketFields> & { title: string; column_id?: number }
): { id: number; number: number } {
	return tx(db, (emit) => {
		const { column_id, ...rest } = fields;
		const col = startColumn(db, projectId, column_id);
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

function startColumn(db: DatabaseSync, projectId: number, columnId: number | undefined): Column {
	const col = columns(db, projectId).find((c) =>
		columnId === undefined ? c.step === 'backlog' : c.id === columnId
	);
	if (!col)
		throw new DomainError(
			'not_found',
			`Projekt ${projectId} hat keine Spalte ${columnId ?? 'Backlog'}.`,
			'Prüfe Projekt- und Spalten-ID.'
		);
	if (col.phase === 'done')
		throw new DomainError(
			'invalid_column',
			`Tickets starten nicht in „${col.name}“.`,
			'Lege das Ticket in einem anderen Schritt an; nach „Fertig“ führt nur moveTicket.'
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
	return targets(db, t, actor).map((c) => ({
		columnId: c.id,
		name: c.name,
		phase: c.phase,
		blockers: blockers(db, t, c)
	}));
}

export function moveTicket(db: DatabaseSync, actor: Actor, ticketId: number, columnId: number) {
	tx(db, (emit) => applyMove(db, emit, actor, ticket(db, ticketId), columnId));
}

/** Moves a ticket inside an open transaction, with the same rules as `moveTicket`. */
export function applyMove(db: DatabaseSync, emit: Emit, actor: Actor, t: Ticket, columnId: number) {
	if (t.column_id === columnId) return;
	const cols = columns(db, t.project_id);
	const to = targetColumn(t, cols, columnId);
	assertMoveAllowed(db, actor, t, to);
	writeMove(db, emit, actor, t, to, cols);
}

function targetColumn(t: Ticket, cols: Column[], columnId: number): Column {
	const to = cols.find((c) => c.id === columnId);
	if (!to)
		throw new DomainError(
			'not_found',
			`Spalte ${columnId} gibt es im Projekt von ${t.ref} nicht.`,
			'allowedMoves listet die erreichbaren Spalten mit ID.'
		);
	return to;
}

/** Writes a move inside an open transaction without the reachability rules; callers check their own. */
export function writeMove(
	db: DatabaseSync,
	emit: Emit,
	actor: Actor,
	t: Ticket,
	to: Column,
	cols: Column[]
) {
	db.prepare(
		'UPDATE tickets SET column_id = ?, moved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
	).run(to.id, JSON.stringify(actor), t.id);
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
		to: to.id
	});
	if (to.phase === 'done') retractOpenQuestions(db, emit, t);
}

/** Done means nothing waits any more: a question still open then is closed by the system, so Lage and inbox agree. */
function retractOpenQuestions(db: DatabaseSync, emit: Emit, t: Ticket) {
	const open = db
		.prepare(`SELECT q.id FROM questions q WHERE q.ticket_id = ? AND ${OPEN_QUESTION}`)
		.all(t.id) as { id: number }[];
	if (!open.length) return;
	const system: Actor = { kind: 'system' };
	const note = 'Das Ticket wurde nach „fertig“ verschoben; die Frage wurde zurückgezogen.';
	const close = db.prepare(
		"UPDATE questions SET answer = json_object('text', ?), answered_at = ?, collected_at = CURRENT_TIMESTAMP WHERE id = ?"
	);
	const answeredAt = new Date().toISOString();
	for (const { id } of open) {
		close.run(note, answeredAt, id);
		emit({
			type: 'question.retracted',
			projectId: t.project_id,
			ticketId: t.id,
			actor: system,
			questionId: id
		});
	}
	appendComment(
		db,
		emit,
		system,
		t,
		`${note} (${open.length === 1 ? 'Frage' : 'Fragen'} ${open.map((q) => q.id).join(', ')})`,
		true
	);
}

function assertMoveAllowed(db: DatabaseSync, actor: Actor, t: Ticket, to: Column) {
	const reachable = targets(db, t, actor);
	if (!reachable.some((c) => c.id === to.id)) throw notReachable(t, to);
	const bs = blockers(db, t, to);
	if (bs.length)
		throw new DomainError(
			bs[0].code,
			bs.map((b) => b.message).join(' '),
			bs.map((b) => b.hint).join(' ')
		);
}

/** The approval is good for the reviewed state; it clears only when the ticket moves back to an earlier step. */
function invalidatesApproval(t: Ticket, to: Column, cols: Column[]): boolean {
	return cols.indexOf(to) < cols.findIndex((c) => c.id === t.column_id);
}

/** Review approval. The human may always; an agent only in the critique step and not after it moved the ticket last. */
export function approveReview(db: DatabaseSync, actor: Actor, ticketId: number) {
	tx(db, (emit) => {
		const t = ticket(db, ticketId);
		if (actor.kind !== 'user' && t.column_step !== 'critique')
			throw new DomainError(
				'not_in_review',
				`${t.ref} liegt in „${t.column_name}“, nicht in der Kritik; ein Agent gibt nur in der Kritik frei.`,
				'Freigeben gehört zur Review-Rolle. Halte dein Ergebnis als Kommentar fest; freigeben kann ein Review-Run oder der Mensch.'
			);
		writeApproval(db, emit, actor, t);
	});
}

/**
 * Writes the review approval inside an open transaction; an agent never approves a ticket it moved last, also not in a
 * run that resumes the one that moved it.
 */
export function writeApproval(db: DatabaseSync, emit: Emit, actor: Actor, t: Ticket) {
	const last = t.moved_by === null ? null : (JSON.parse(t.moved_by) as Actor);
	// ponytail: "author of the last work" ≈ whoever moved the ticket last; compare the last working run or its profile once that distinction matters
	if (actor.kind !== 'user' && last?.kind === actor.kind && sameRunChain(db, last, actor))
		throw new DomainError(
			'self_approval',
			`${t.ref} wurde zuletzt von dir (${label(actor)}) verschoben — eigene Arbeit darfst du nicht freigeben.`,
			'Die Freigabe erteilt ein anderer Agent (Review-Run) oder der Mensch. Halte dein Ergebnis als Kommentar fest.'
		);
	db.prepare(
		'UPDATE tickets SET review_approved_at = CURRENT_TIMESTAMP, review_approved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
	).run(JSON.stringify(actor), t.id);
	emit({ type: 'ticket.review_approved', projectId: t.project_id, ticketId: t.id, actor });
}

const sameRunChain = (db: DatabaseSync, a: Actor, b: Actor) =>
	a.runId === undefined || b.runId === undefined
		? a.runId === b.runId
		: chainRootOf(db, a.runId) === chainRootOf(db, b.runId);

/** SQL condition for an unfinished `blocks` predecessor `b` in column `bc`, judged by the successor's project `p`. */
export const PREDECESSOR_OPEN = `bc.phase <> 'done' AND NOT (p.blocks_satisfied_at = 'review_ok' AND b.review_approved_at IS NOT NULL)`;

/**
 * Tickets without unfinished blocks predecessors and without an open question, excluding done ones. A predecessor is unfinished until it is done —
 * with `blocks_satisfied_at = 'review_ok'` its review approval suffices.
 */
export function workableTickets(db: DatabaseSync, projectId: number, columnId?: number) {
	return db
		.prepare(
			`SELECT t.id, p.key || '-' || t.number AS ref, t.title, t.type, t.column_id, t.assignee
			FROM tickets t JOIN columns c ON c.id = t.column_id JOIN projects p ON p.id = t.project_id
			WHERE t.project_id = ?1 AND (?2 IS NULL OR t.column_id = ?2) AND c.phase <> 'done'
				AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.ticket_id = t.id AND ${OPEN_QUESTION})
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
	titles: string[],
	owner: TaskOwner = 'agent'
): { ids: number[] } {
	return tx(db, (emit) => {
		const t = ticket(db, ticketId);
		if (!TASK_OWNERS.includes(owner))
			throw new DomainError(
				'invalid_owner',
				`„${owner}“ ist keine Zuständigkeit für Tasks.`,
				`Erlaubt: ${TASK_OWNERS.join(', ')}.`
			);
		if (titles.some((title) => !title.trim()))
			throw new DomainError(
				'empty_title',
				`Ein Task für ${t.ref} hat keinen Titel.`,
				'Gib jedem Task einen Titel, der das Akzeptanzkriterium nennt.'
			);
		const insert = db.prepare(
			'INSERT INTO tasks (ticket_id, title, owner) VALUES (?, ?, ?) RETURNING id'
		);
		const ids = titles.map((title) => {
			const { id } = insert.get(t.id, title, owner) as { id: number };
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

/** Renames a task; the reason is recorded as a system comment on the ticket. */
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

/** Deletes a task; the reason is recorded as a system comment on the ticket. */
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

/** Links two tickets (idempotent). parent_of and blocks stay free of cycles. */
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

/** The ticket's tasks in position order, as an agent reads them. */
export const tasksOf = (db: DatabaseSync, ticketId: number) =>
	(
		db
			.prepare(
				'SELECT id, title, done_at IS NOT NULL AS done, owner FROM tasks WHERE ticket_id = ? ORDER BY position, id'
			)
			.all(ticketId) as { id: number; title: string; done: 0 | 1; owner: TaskOwner }[]
	).map((k) => ({
		id: k.id,
		title: k.title,
		done: k.done === 1,
		...(k.owner !== 'agent' && { owner: k.owner })
	}));
