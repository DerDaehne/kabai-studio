import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { StudioEvent } from '../events';
import { ticket } from './board';
import { DomainError, tx, type Actor } from './core';

export type NoteKind = 'note' | 'adr' | 'hub';
export type NoteStatus = 'proposed' | 'accepted' | 'superseded';
export type NoteLinkType = 'references' | 'contains' | 'supersedes' | 'contradicts';
export type NoteTicketRelation = 'created_by' | 'documents' | 'verified_by' | 'references';
type Emit = (event: StudioEvent) => void;
type Note = {
	id: number;
	slug: string;
	title: string;
	kind: NoteKind;
	status: NoteStatus | null;
	body: string;
	archived: 0 | 1;
	version: number;
};

/** Note fields that can be set directly — the slug is permanent, and archiving has its own function. */
const FIELDS = ['title', 'kind', 'status', 'body', 'tags'] as const;
export type NoteFields = {
	title: string;
	kind: NoteKind;
	status: NoteStatus | null;
	body: string;
	tags: string[];
};

function note(db: DatabaseSync, id: number): Note {
	const n = db
		.prepare(
			'SELECT id, slug, title, kind, status, body, archived, version FROM notes WHERE id = ?'
		)
		.get(id) as Note | undefined;
	if (!n)
		throw new DomainError(
			'not_found',
			`Note ${id} gibt es nicht.`,
			'Prüfe die Note-ID; searchNotes findet vorhandene Notes.'
		);
	return n;
}

/** The full view for UI and MCP: all columns, with `tags` as an array instead of JSON text. */
export function getNote(db: DatabaseSync, id: number) {
	const row = db
		.prepare(
			'SELECT id, slug, title, kind, status, body, tags, archived, verified_at, verified_by_run_id, version, created_at, updated_at FROM notes WHERE id = ?'
		)
		.get(id) as (Record<string, unknown> & { tags: string }) | undefined;
	if (!row)
		throw new DomainError(
			'not_found',
			`Note ${id} gibt es nicht.`,
			'Prüfe die Note-ID; searchNotes findet vorhandene Notes.'
		);
	return { ...row, tags: JSON.parse(row.tags) as string[] };
}

/** Only the allowed fields; anything else is an error instead of being ignored silently. `tags` is stored as JSON. */
function fieldsOf(input: object): [string, SQLInputValue][] {
	return Object.entries(input)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => {
			if (!(FIELDS as readonly string[]).includes(k))
				throw new DomainError(
					'unknown_field',
					`Das Notefeld „${k}“ ist nicht direkt setzbar.`,
					`Setzbar: ${FIELDS.join(', ')}. Der Slug ist permanent, Archivieren über archiveNote.`
				);
			return [k, k === 'tags' ? JSON.stringify(v) : v] as [string, SQLInputValue];
		});
}

/** Mirrors the DB CHECK exactly: starts with a lower-case letter or digit, then only lower-case letters, digits and "-". */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Checks slug format and uniqueness up front instead of passing the raw SQLite error (CHECK/UNIQUE) to the caller. */
function checkSlug(db: DatabaseSync, slug: string) {
	if (!SLUG_RE.test(slug))
		throw new DomainError(
			'invalid_slug',
			`Slug „${slug}“ ist nicht kebab-case.`,
			'Nur Kleinbuchstaben, Ziffern und „-“, beginnend mit Buchstabe/Ziffer (Beispiel: „arch-studio-notes“).'
		);
	const existing = db.prepare('SELECT id FROM notes WHERE slug = ?').get(slug) as
		{ id: number } | undefined;
	if (existing)
		throw new DomainError(
			'slug_taken',
			`Slug „${slug}“ ist schon vergeben (Note ${existing.id}).`,
			`Note ${existing.id} existiert schon — updateNote statt createNote, oder einen anderen Slug wählen.`
		);
}

/** `status` is only allowed with `kind="adr"` (DB CHECK) — checked up front, so changing the kind away from adr throws no raw CHECK error. */
function checkKindStatus(kind: NoteKind, status: NoteStatus | null | undefined) {
	if (status != null && kind !== 'adr')
		throw new DomainError(
			'invalid_status',
			`status ist nur bei kind="adr" erlaubt (kind ist "${kind}").`,
			'Lass status weg, oder setze kind auf "adr".'
		);
}

/**
 * Which notes a caller may see. `visibleIn` limits that to the notes of one project plus the global ones: wikilinks
 * then neither reach nor reveal nor remove notes of other projects.
 */
export type NoteScope = { visibleIn?: number };

/** Wikilinks in the body (`[[slug]]` or `[[slug|label]]`): known slugs (except the note itself) → target id, unknown ones separately. */
function wikilinks(
	db: DatabaseSync,
	selfId: number,
	body: string,
	scope: NoteScope
): { known: Map<string, number>; unknown: string[] } {
	const slugs = [
		...new Set([...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim()))
	].filter(Boolean);
	const known = new Map<string, number>();
	const unknown: string[] = [];
	const find = db.prepare(
		`SELECT id FROM notes n WHERE slug = ?1 AND (?2 IS NULL OR ${noteVisibleIn('?2')})`
	);
	for (const slug of slugs) {
		const row = find.get(slug, scope.visibleIn ?? null) as { id: number } | undefined;
		if (!row) unknown.push(slug);
		else if (row.id !== selfId) known.set(slug, row.id);
	}
	return { known, unknown };
}

/**
 * Syncs the automatic (origin=wikilink) references edges with the wikilinks in the body. Manual edges stay untouched.
 * ponytail: pure note-to-note edges emit no bus event (no ticket, so no projectId) — like agent profiles in domain/runs.ts.
 */
function syncWikilinks(db: DatabaseSync, fromId: number, body: string, scope: NoteScope): string[] {
	const { known, unknown } = wikilinks(db, fromId, body, scope);
	const targets = new Set(known.values());
	const existing = db
		.prepare(
			`SELECT l.to_note_id FROM note_links l JOIN notes n ON n.id = l.to_note_id
			WHERE l.from_note_id = ?1 AND l.type = 'references' AND l.origin = 'wikilink' AND (?2 IS NULL OR ${noteVisibleIn('?2')})`
		)
		.all(fromId, scope.visibleIn ?? null) as { to_note_id: number }[];
	for (const { to_note_id } of existing)
		if (!targets.has(to_note_id))
			db.prepare(
				"DELETE FROM note_links WHERE from_note_id = ? AND to_note_id = ? AND type = 'references'"
			).run(fromId, to_note_id);
	for (const to_note_id of targets)
		db.prepare(
			"INSERT INTO note_links (from_note_id, to_note_id, type, origin) VALUES (?, ?, 'references', 'wikilink') ON CONFLICT DO NOTHING"
		).run(fromId, to_note_id);
	return unknown.map((s) => `Unbekannter Slug „${s}“ im Wikilink — kein Link angelegt.`);
}

export function createNote(
	db: DatabaseSync,
	actor: Actor,
	fields: {
		slug: string;
		title: string;
		body: string;
		kind?: NoteKind;
		status?: NoteStatus;
		tags?: string[];
		projectIds?: number[];
	},
	scope: NoteScope = {}
): { id: number; warnings: string[] } {
	return tx(db, () => {
		const { slug, projectIds, ...rest } = fields;
		checkSlug(db, slug);
		checkKindStatus(rest.kind ?? 'note', rest.status);
		const f = fieldsOf(rest);
		const { id } = db
			.prepare(
				`INSERT INTO notes (slug, ${f.map(([k]) => k).join(', ')}) VALUES (?, ${f.map(() => '?').join(', ')}) RETURNING id`
			)
			.get(slug, ...f.map(([, v]) => v)) as { id: number };
		for (const projectId of projectIds ?? [])
			db.prepare('INSERT INTO note_projects (note_id, project_id) VALUES (?, ?)').run(
				id,
				projectId
			);
		const warnings = syncWikilinks(db, id, rest.body, scope);
		return { id, warnings };
	});
}

/**
 * Optimistic concurrency: a given `expectedVersion` must equal the current `version`, otherwise `conflict`
 * (`updated_at` resolves to the second only, so two fast agent writers could not be told apart).
 */
export function updateNote(
	db: DatabaseSync,
	actor: Actor,
	noteId: number,
	patch: Partial<NoteFields>,
	expectedVersion?: number,
	scope: NoteScope = {}
): { warnings: string[] } {
	return tx(db, () => {
		const n = note(db, noteId);
		if (expectedVersion !== undefined && expectedVersion !== n.version)
			throw new DomainError(
				'conflict',
				`Note „${n.slug}“ wurde inzwischen geändert (aktuelle Version ${n.version}, erwartet ${expectedVersion}).`,
				'Note neu lesen (getNote) und die Änderung auf der aktuellen Version erneut anwenden.'
			);
		checkKindStatus(patch.kind ?? n.kind, patch.status !== undefined ? patch.status : n.status);
		const f = fieldsOf(patch);
		if (f.length)
			db.prepare(
				`UPDATE notes SET ${f.map(([k]) => `${k} = ?`).join(', ')}, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
			).run(...f.map(([, v]) => v), n.id);
		if (patch.body === undefined) return { warnings: [] };
		return { warnings: syncWikilinks(db, n.id, patch.body, scope) };
	});
}

/**
 * Increments `version`, so a parallel `updateNote` with an older `expectedVersion` gets `conflict` instead of
 * silently overwriting the archived state.
 */
export function archiveNote(db: DatabaseSync, actor: Actor, noteId: number): void {
	tx(db, () => {
		const n = note(db, noteId);
		if (!n.archived)
			db.prepare(
				'UPDATE notes SET archived = 1, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
			).run(n.id);
	});
}

/**
 * Links two notes manually. An existing automatic wikilink edge is raised to `manual`, so removing the wikilink later
 * keeps the deliberate link. `supersedes` on an adr note also marks it `superseded` and increments its `version`.
 */
export function linkNote(
	db: DatabaseSync,
	actor: Actor,
	fromId: number,
	toId: number,
	type: NoteLinkType
): void {
	tx(db, () => {
		const from = note(db, fromId);
		const to = note(db, toId);
		if (from.id === to.id)
			throw new DomainError(
				'self_relation',
				`Note „${from.slug}“ kann nicht mit sich selbst verknüpft werden.`,
				'Wähle als Ziel eine andere Note.'
			);
		db.prepare(
			"INSERT INTO note_links (from_note_id, to_note_id, type, origin) VALUES (?, ?, ?, 'manual') ON CONFLICT (from_note_id, to_note_id, type) DO UPDATE SET origin = 'manual'"
		).run(from.id, to.id, type);
		if (type === 'supersedes' && to.kind === 'adr' && to.status !== 'superseded')
			db.prepare(
				"UPDATE notes SET status = 'superseded', version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
			).run(to.id);
	});
}

export function unlinkNote(
	db: DatabaseSync,
	actor: Actor,
	fromId: number,
	toId: number,
	type: NoteLinkType
): void {
	tx(db, () => {
		const from = note(db, fromId);
		db.prepare('DELETE FROM note_links WHERE from_note_id = ? AND to_note_id = ? AND type = ?').run(
			from.id,
			toId,
			type
		);
	});
}

/** Links a note to a ticket (idempotent); verifyNote uses `linkTicketRow` too. */
function linkTicketRow(
	db: DatabaseSync,
	emit: Emit,
	actor: Actor,
	noteId: number,
	ticketId: number,
	relation: NoteTicketRelation
) {
	const t = ticket(db, ticketId);
	if (
		db
			.prepare(
				'INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
			)
			.run(noteId, t.id, relation).changes
	)
		emit({
			type: 'note.ticket_linked',
			projectId: t.project_id,
			ticketId: t.id,
			actor,
			noteId,
			relation
		});
}

export function linkTicket(
	db: DatabaseSync,
	actor: Actor,
	noteId: number,
	ticketId: number,
	relation: NoteTicketRelation
): void {
	tx(db, (emit) => linkTicketRow(db, emit, actor, note(db, noteId).id, ticketId, relation));
}

export function unlinkTicket(
	db: DatabaseSync,
	actor: Actor,
	noteId: number,
	ticketId: number,
	relation: NoteTicketRelation
): void {
	tx(db, (emit) => {
		const n = note(db, noteId);
		const t = ticket(db, ticketId);
		if (
			db
				.prepare('DELETE FROM note_tickets WHERE note_id = ? AND ticket_id = ? AND relation = ?')
				.run(n.id, t.id, relation).changes
		)
			emit({
				type: 'note.ticket_unlinked',
				projectId: t.project_id,
				ticketId: t.id,
				actor,
				noteId: n.id,
				relation
			});
	});
}

/** Marks a note as verified; with `ticketId` it also adds a `verified_by` link (the ticket confirms the state). */
export function verifyNote(
	db: DatabaseSync,
	actor: Actor,
	noteId: number,
	ticketId?: number
): void {
	tx(db, (emit) => {
		const n = note(db, noteId);
		db.prepare(
			'UPDATE notes SET verified_at = CURRENT_TIMESTAMP, verified_by_run_id = ? WHERE id = ?'
		).run(actor.runId ?? null, n.id);
		if (ticketId !== undefined) linkTicketRow(db, emit, actor, n.id, ticketId, 'verified_by');
	});
}

/** SQL condition: note `n` belongs to the project bound to `projectParam`, or to no project at all (a global note). */
export const noteVisibleIn = (projectParam: string) =>
	`(NOT EXISTS (SELECT 1 FROM note_projects vp WHERE vp.note_id = n.id) OR EXISTS (SELECT 1 FROM note_projects vp WHERE vp.note_id = n.id AND vp.project_id = ${projectParam}))`;

export type NoteSearchHit = {
	id: number;
	slug: string;
	title: string;
	kind: NoteKind;
	status: NoteStatus | null;
	archived: 0 | 1;
	version: number;
	snippet: string;
	bodyChars: number;
};

/**
 * Quotes every search term as an FTS5 string literal, so special characters break nothing. NUL is removed first:
 * it would cut the bound string before the closing quote ("unterminated string").
 */
function ftsQuery(query: string): string {
	return query
		.replace(/\0/g, '')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((term) => `"${term.replace(/"/g, '""')}"`)
		.join(' ');
}

/**
 * bm25 ranking with superseded adr notes and (with `includeArchived`) archived notes sorted last. The comparison uses
 * `IS`, because `=` yields NULL for notes without a status and NULL sorts before 0/1 in SQLite.
 */
export function searchNotes(
	db: DatabaseSync,
	query: string,
	opts: {
		kind?: NoteKind;
		projectId?: number;
		visibleIn?: number;
		tag?: string;
		limit?: number;
		includeArchived?: boolean;
	} = {}
): NoteSearchHit[] {
	const match = ftsQuery(query);
	if (!match) return [];
	return db
		.prepare(
			`SELECT n.id, n.slug, n.title, n.kind, n.status, n.archived, n.version, length(n.body) AS bodyChars,
				snippet(notes_fts, -1, '**', '**', '…', 12) AS snippet
			FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
			WHERE notes_fts MATCH ?1
				AND (?2 IS NULL OR n.kind = ?2)
				AND (?4 IS NULL OR EXISTS (SELECT 1 FROM note_projects np WHERE np.note_id = n.id AND np.project_id = ?4))
				AND (?5 IS NULL OR EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?5))
				AND (n.archived = 0 OR ?6 = 1)
				AND (?7 IS NULL OR ${noteVisibleIn('?7')})
			ORDER BY n.archived, n.status IS 'superseded', notes_fts.rank
			LIMIT ?3`
		)
		.all(
			match,
			opts.kind ?? null,
			opts.limit ?? 20,
			opts.projectId ?? null,
			opts.tag ?? null,
			opts.includeArchived ? 1 : 0,
			opts.visibleIn ?? null
		) as NoteSearchHit[];
}
