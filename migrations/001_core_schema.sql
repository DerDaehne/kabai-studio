-- Kernschema Board: harte Invarianten als Constraints, Workflow-Regeln in der Domain-Schicht.

CREATE TABLE projects (
	id INTEGER PRIMARY KEY,
	key TEXT NOT NULL UNIQUE CHECK (key GLOB '[A-Z]*' AND key NOT GLOB '*[^A-Z0-9]*'), -- Anzeige STU-12
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE columns (
	id INTEGER PRIMARY KEY,
	project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	position INTEGER NOT NULL DEFAULT 0,
	role_prompt TEXT NOT NULL DEFAULT '',
	kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'done', 'human_intervention', 'human_answered')),
	UNIQUE (project_id, id) -- Ziel der zusammengesetzten FKs: Spalte gehört zum selben Projekt
) STRICT;

CREATE TABLE transitions (
	project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	from_column_id INTEGER NOT NULL,
	to_column_id INTEGER NOT NULL,
	requires_human INTEGER NOT NULL DEFAULT 0 CHECK (requires_human IN (0, 1)),
	PRIMARY KEY (project_id, from_column_id, to_column_id),
	CHECK (from_column_id <> to_column_id),
	FOREIGN KEY (project_id, from_column_id) REFERENCES columns (project_id, id) ON DELETE CASCADE,
	FOREIGN KEY (project_id, to_column_id) REFERENCES columns (project_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE tickets (
	id INTEGER PRIMARY KEY,
	project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	number INTEGER NOT NULL CHECK (number > 0),
	column_id INTEGER NOT NULL,
	type TEXT NOT NULL DEFAULT 'ticket' CHECK (type IN ('ticket', 'epic')),
	title TEXT NOT NULL CHECK (title <> ''),
	description TEXT NOT NULL DEFAULT '',
	docs_required INTEGER NOT NULL DEFAULT 0 CHECK (docs_required IN (0, 1)),
	assignee TEXT,
	position INTEGER NOT NULL DEFAULT 0,
	effort_estimate REAL,
	effort_actual REAL,
	effort_unit TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (project_id, number),
	-- ohne ON DELETE: eine Spalte mit Tickets lässt sich nicht löschen
	FOREIGN KEY (project_id, column_id) REFERENCES columns (project_id, id)
) STRICT;
CREATE INDEX tickets_by_column ON tickets (project_id, column_id, position);

CREATE TABLE tasks (
	id INTEGER PRIMARY KEY,
	ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
	title TEXT NOT NULL CHECK (title <> ''),
	position INTEGER NOT NULL DEFAULT 0,
	done_at TEXT -- NULL = offen
) STRICT;
CREATE INDEX tasks_by_ticket ON tasks (ticket_id, position);

CREATE TABLE comments (
	id INTEGER PRIMARY KEY,
	ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
	author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'system')),
	author TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	redacted_at TEXT,
	redacted_reason TEXT,
	CHECK ((redacted_at IS NULL) = (redacted_reason IS NULL))
) STRICT;
CREATE INDEX comments_by_ticket ON comments (ticket_id, id);

CREATE TABLE ticket_relations (
	from_ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
	to_ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
	type TEXT NOT NULL CHECK (type IN ('parent_of', 'blocks', 'relates_to', 'duplicate_of')),
	PRIMARY KEY (from_ticket_id, to_ticket_id, type),
	CHECK (from_ticket_id <> to_ticket_id)
) STRICT;
CREATE INDEX ticket_relations_by_to ON ticket_relations (to_ticket_id);
