import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { StudioEvent } from '../events';
import { ticket } from './board';
import { DomainError, tx, type Actor } from './core';

export type NoteKind = 'note' | 'adr' | 'hub';
export type NoteStatus = 'proposed' | 'accepted' | 'superseded';
export type NoteLinkType = 'references' | 'contains' | 'supersedes' | 'contradicts';
export type NoteTicketRelation = 'created_by' | 'documents' | 'verified_by' | 'references';
type Emit = (event: StudioEvent) => void;
type Note = { id: number; slug: string; title: string; kind: NoteKind; status: NoteStatus | null; body: string; archived: 0 | 1; version: number };

/** Direkt setzbare Notefelder — der Slug ist permanent, Archivieren hat eine eigene Funktion. */
const FIELDS = ['title', 'kind', 'status', 'body', 'tags'] as const;
export type NoteFields = { title: string; kind: NoteKind; status: NoteStatus | null; body: string; tags: string[] };

function note(db: DatabaseSync, id: number): Note {
	const n = db.prepare('SELECT id, slug, title, kind, status, body, archived, version FROM notes WHERE id = ?').get(id) as Note | undefined;
	if (!n) throw new DomainError('not_found', `Note ${id} gibt es nicht.`, 'Prüfe die Note-ID; searchNotes findet vorhandene Notes.');
	return n;
}

/** Volle Sicht für UI/MCP (#777/#780): alle Spalten, `tags` als Array statt JSON-Text. */
export function getNote(db: DatabaseSync, id: number) {
	const row = db
		.prepare('SELECT id, slug, title, kind, status, body, tags, archived, verified_at, verified_by_run_id, version, created_at, updated_at FROM notes WHERE id = ?')
		.get(id) as (Record<string, unknown> & { tags: string }) | undefined;
	if (!row) throw new DomainError('not_found', `Note ${id} gibt es nicht.`, 'Prüfe die Note-ID; searchNotes findet vorhandene Notes.');
	return { ...row, tags: JSON.parse(row.tags) as string[] };
}

/** Nur freigegebene Felder; alles andere ist ein Fehler statt still ignoriert. `tags` wird als JSON gespeichert. */
function fieldsOf(input: object): [string, SQLInputValue][] {
	return Object.entries(input)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => {
			if (!(FIELDS as readonly string[]).includes(k))
				throw new DomainError('unknown_field', `Das Notefeld „${k}“ ist nicht direkt setzbar.`, `Setzbar: ${FIELDS.join(', ')}. Der Slug ist permanent, Archivieren über archiveNote.`);
			return [k, k === 'tags' ? JSON.stringify(v) : v] as [string, SQLInputValue];
		});
}

/** [[slug]]-Verweise im Body: bekannte Slugs (ohne sich selbst) → Ziel-ID, unbekannte separat. */
function wikilinks(db: DatabaseSync, selfId: number, body: string): { known: Map<string, number>; unknown: string[] } {
	const slugs = [...new Set([...body.matchAll(/\[\[([^\]|]+)\]\]/g)].map((m) => m[1].trim()))].filter(Boolean);
	const known = new Map<string, number>();
	const unknown: string[] = [];
	for (const slug of slugs) {
		const row = db.prepare('SELECT id FROM notes WHERE slug = ?').get(slug) as { id: number } | undefined;
		if (!row) unknown.push(slug);
		else if (row.id !== selfId) known.set(slug, row.id);
	}
	return { known, unknown };
}

/**
 * Gleicht automatische (origin=wikilink) references-Kanten mit den [[slug]]-Verweisen im Body ab. Manuelle Kanten bleiben unberührt.
 * ponytail: reine Note-Note-Kanten lösen kein Bus-Event aus (kein Ticket, also kein projectId) — wie Agent-Profile in domain/runs.ts.
 */
function syncWikilinks(db: DatabaseSync, fromId: number, body: string): string[] {
	const { known, unknown } = wikilinks(db, fromId, body);
	const targets = new Set(known.values());
	const existing = db.prepare("SELECT to_note_id FROM note_links WHERE from_note_id = ? AND type = 'references' AND origin = 'wikilink'").all(fromId) as { to_note_id: number }[];
	for (const { to_note_id } of existing)
		if (!targets.has(to_note_id)) db.prepare("DELETE FROM note_links WHERE from_note_id = ? AND to_note_id = ? AND type = 'references'").run(fromId, to_note_id);
	for (const to_note_id of targets)
		db.prepare("INSERT INTO note_links (from_note_id, to_note_id, type, origin) VALUES (?, ?, 'references', 'wikilink') ON CONFLICT DO NOTHING").run(fromId, to_note_id);
	return unknown.map((s) => `Unbekannter Slug „${s}“ im Wikilink — kein Link angelegt.`);
}

export function createNote(
	db: DatabaseSync,
	actor: Actor,
	fields: { slug: string; title: string; body: string; kind?: NoteKind; status?: NoteStatus; tags?: string[]; projectIds?: number[] }
): { id: number; warnings: string[] } {
	return tx(db, () => {
		const { slug, projectIds, ...rest } = fields;
		const f = fieldsOf(rest);
		const { id } = db
			.prepare(`INSERT INTO notes (slug, ${f.map(([k]) => k).join(', ')}) VALUES (?, ${f.map(() => '?').join(', ')}) RETURNING id`)
			.get(slug, ...f.map(([, v]) => v)) as { id: number };
		for (const projectId of projectIds ?? []) db.prepare('INSERT INTO note_projects (note_id, project_id) VALUES (?, ?)').run(id, projectId);
		const warnings = syncWikilinks(db, id, rest.body);
		return { id, warnings };
	});
}

/**
 * `expectedVersion`, wenn gegeben, muss der aktuellen `version` entsprechen — sonst `conflict` (optimistische Nebenläufigkeit:
 * ein `updated_at`-Vergleich reicht nicht, `CURRENT_TIMESTAMP` löst nur sekundengenau auf und zwei schnelle Agent-Schreiber
 * träfen sonst denselben Wert). Jede angewandte Änderung erhöht `version` um 1. Body geändert → Wikilinks werden neu abgeglichen.
 */
export function updateNote(db: DatabaseSync, actor: Actor, noteId: number, patch: Partial<NoteFields>, expectedVersion?: number): { warnings: string[] } {
	return tx(db, () => {
		const n = note(db, noteId);
		if (expectedVersion !== undefined && expectedVersion !== n.version)
			throw new DomainError(
				'conflict',
				`Note „${n.slug}“ wurde inzwischen geändert (aktuelle Version ${n.version}, erwartet ${expectedVersion}).`,
				'Note neu lesen (getNote) und die Änderung auf der aktuellen Version erneut anwenden.'
			);
		const f = fieldsOf(patch);
		if (f.length) db.prepare(`UPDATE notes SET ${f.map(([k]) => `${k} = ?`).join(', ')}, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...f.map(([, v]) => v), n.id);
		if (patch.body === undefined) return { warnings: [] };
		return { warnings: syncWikilinks(db, n.id, patch.body) };
	});
}

/** `actor` ist für spätere Regeln vorgesehen (Konvention: Mutationen nehmen ihn als zweiten Parameter) — heute ungenutzt. */
export function archiveNote(db: DatabaseSync, actor: Actor, noteId: number): void {
	tx(db, () => {
		const n = note(db, noteId);
		if (!n.archived) db.prepare('UPDATE notes SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(n.id);
	});
}

/** Verknüpft zwei Notes (idempotent). `supersedes` auf eine ADR setzt deren Status automatisch auf `superseded`. */
export function linkNote(db: DatabaseSync, actor: Actor, fromId: number, toId: number, type: NoteLinkType): void {
	tx(db, () => {
		const from = note(db, fromId);
		const to = note(db, toId);
		if (from.id === to.id) throw new DomainError('self_relation', `Note „${from.slug}“ kann nicht mit sich selbst verknüpft werden.`, 'Wähle als Ziel eine andere Note.');
		db.prepare("INSERT INTO note_links (from_note_id, to_note_id, type, origin) VALUES (?, ?, ?, 'manual') ON CONFLICT DO NOTHING").run(from.id, to.id, type);
		if (type === 'supersedes' && to.kind === 'adr' && to.status !== 'superseded')
			db.prepare("UPDATE notes SET status = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(to.id);
	});
}

export function unlinkNote(db: DatabaseSync, actor: Actor, fromId: number, toId: number, type: NoteLinkType): void {
	tx(db, () => {
		const from = note(db, fromId);
		db.prepare('DELETE FROM note_links WHERE from_note_id = ? AND to_note_id = ? AND type = ?').run(from.id, toId, type);
	});
}

/** Verknüpft eine Note mit einem Ticket (idempotent); `linkTicketRow` wird auch von verifyNote genutzt. */
function linkTicketRow(db: DatabaseSync, emit: Emit, actor: Actor, noteId: number, ticketId: number, relation: NoteTicketRelation) {
	const t = ticket(db, ticketId);
	if (db.prepare('INSERT INTO note_tickets (note_id, ticket_id, relation) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(noteId, t.id, relation).changes)
		emit({ type: 'note.ticket_linked', projectId: t.project_id, ticketId: t.id, actor, noteId, relation });
}

export function linkTicket(db: DatabaseSync, actor: Actor, noteId: number, ticketId: number, relation: NoteTicketRelation): void {
	tx(db, (emit) => linkTicketRow(db, emit, actor, note(db, noteId).id, ticketId, relation));
}

export function unlinkTicket(db: DatabaseSync, actor: Actor, noteId: number, ticketId: number, relation: NoteTicketRelation): void {
	tx(db, (emit) => {
		const n = note(db, noteId);
		const t = ticket(db, ticketId);
		if (db.prepare('DELETE FROM note_tickets WHERE note_id = ? AND ticket_id = ? AND relation = ?').run(n.id, t.id, relation).changes)
			emit({ type: 'note.ticket_unlinked', projectId: t.project_id, ticketId: t.id, actor, noteId: n.id, relation });
	});
}

/** Markiert eine Note als verifiziert; mit `ticketId` zusätzlich eine `verified_by`-Verknüpfung (das Ticket bestätigt den Stand). */
export function verifyNote(db: DatabaseSync, actor: Actor, noteId: number, ticketId?: number): void {
	tx(db, (emit) => {
		const n = note(db, noteId);
		db.prepare('UPDATE notes SET verified_at = CURRENT_TIMESTAMP, verified_by_run_id = ? WHERE id = ?').run(actor.runId ?? null, n.id);
		if (ticketId !== undefined) linkTicketRow(db, emit, actor, n.id, ticketId, 'verified_by');
	});
}

export type NoteSearchHit = { id: number; slug: string; title: string; kind: NoteKind; status: NoteStatus | null; archived: 0 | 1; version: number; snippet: string; bodyChars: number };

/** Quotet jeden Suchbegriff einzeln als FTS5-Stringliteral — Sonderzeichen (Punkte, Unterstriche, Klammern, „-“ …) brechen nichts. */
function ftsQuery(query: string): string {
	return query
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((term) => `"${term.replace(/"/g, '""')}"`)
		.join(' ');
}

/** Ranking: bm25 (beste Treffer zuerst), superseded ADRs werden herabgestuft. Snippet + bodyChars statt Volltext. */
export function searchNotes(db: DatabaseSync, query: string, opts: { kind?: NoteKind; projectId?: number; tag?: string; limit?: number } = {}): NoteSearchHit[] {
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
			ORDER BY (n.status = 'superseded'), notes_fts.rank
			LIMIT ?3`
		)
		.all(match, opts.kind ?? null, opts.limit ?? 20, opts.projectId ?? null, opts.tag ?? null) as NoteSearchHit[];
}
