-- Wissensbasis: Notes, Links, Projekt-/Ticket-Verknüpfung, Volltextsuche (FTS5, external content, Trigger-synchron).
-- Kein FK auf runs (existiert erst ab 006): verified_by_run_id ist reine Herkunftsangabe, keine harte Invariante.

CREATE TABLE notes (
	id INTEGER PRIMARY KEY,
	slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'), -- kebab-case, permanent
	title TEXT NOT NULL CHECK (title <> ''),
	kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'adr', 'hub')),
	status TEXT CHECK (status IS NULL OR (kind = 'adr' AND status IN ('proposed', 'accepted', 'superseded'))), -- nur ADRs tragen einen Status
	body TEXT NOT NULL DEFAULT '',
	tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
	archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
	verified_at TEXT,
	verified_by_run_id INTEGER,
	version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), -- optimistische Nebenläufigkeit: updateNote vergleicht expectedVersion, bevor updated_at (1s-Auflösung) es könnte
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE note_projects (
	note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	PRIMARY KEY (note_id, project_id)
) STRICT;

CREATE TABLE note_links (
	from_note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	to_note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	type TEXT NOT NULL CHECK (type IN ('references', 'contains', 'supersedes', 'contradicts')),
	origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'wikilink')),
	PRIMARY KEY (from_note_id, to_note_id, type),
	CHECK (from_note_id <> to_note_id)
) STRICT;
CREATE INDEX note_links_by_to ON note_links (to_note_id);

CREATE TABLE note_tickets (
	note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
	relation TEXT NOT NULL CHECK (relation IN ('created_by', 'documents', 'verified_by', 'references')),
	PRIMARY KEY (note_id, ticket_id, relation)
) STRICT;
CREATE INDEX note_tickets_by_ticket ON note_tickets (ticket_id);

-- FTS5, external content: notes bleibt die einzige Quelle, Trigger halten den Index synchron (Insert/Update/Delete).
CREATE VIRTUAL TABLE notes_fts USING fts5(slug, title, tags, body, content='notes', content_rowid='id');

CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
	INSERT INTO notes_fts (rowid, slug, title, tags, body) VALUES (new.id, new.slug, new.title, new.tags, new.body);
END;
CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
	INSERT INTO notes_fts (notes_fts, rowid, slug, title, tags, body) VALUES ('delete', old.id, old.slug, old.title, old.tags, old.body);
END;
CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
	INSERT INTO notes_fts (notes_fts, rowid, slug, title, tags, body) VALUES ('delete', old.id, old.slug, old.title, old.tags, old.body);
	INSERT INTO notes_fts (rowid, slug, title, tags, body) VALUES (new.id, new.slug, new.title, new.tags, new.body);
END;
