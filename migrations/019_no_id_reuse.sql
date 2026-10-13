-- Without AUTOINCREMENT SQLite hands the ids of the newest deleted rows out again. An executor, a page or a stored
-- reference (moved_by, review_approved_by, notes.verified_by_run_id) that still holds the id of a deleted ticket or run
-- would then act on a stranger's. Both tables are rebuilt unchanged apart from AUTOINCREMENT, keeping every id; the
-- copy starts sqlite_sequence at the current maximum.

CREATE TABLE tickets_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	number INTEGER NOT NULL CHECK (number > 0),
	column_id INTEGER NOT NULL,
	type TEXT NOT NULL DEFAULT 'ticket' CHECK (type IN ('ticket', 'epic')),
	title TEXT NOT NULL CHECK (title <> ''),
	description TEXT NOT NULL DEFAULT '',
	docs_required INTEGER NOT NULL DEFAULT 0 CHECK (docs_required IN (0, 1)),
	assignee TEXT,
	position INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	review_approved_at TEXT,
	review_approved_by TEXT
		CHECK ((review_approved_by IS NULL) = (review_approved_at IS NULL) AND (review_approved_by IS NULL OR json_valid(review_approved_by))),
	moved_by TEXT CHECK (moved_by IS NULL OR json_valid(moved_by)),
	size TEXT CHECK (size IN ('XS', 'S', 'M', 'L', 'XL')),
	UNIQUE (project_id, number),
	-- no ON DELETE: a column that holds tickets cannot be deleted
	FOREIGN KEY (project_id, column_id) REFERENCES columns (project_id, id)
) STRICT;

INSERT INTO tickets_new (id, project_id, number, column_id, type, title, description, docs_required, assignee, position,
		created_at, updated_at, review_approved_at, review_approved_by, moved_by, size)
	SELECT id, project_id, number, column_id, type, title, description, docs_required, assignee, position,
		created_at, updated_at, review_approved_at, review_approved_by, moved_by, size
	FROM tickets;
DROP TABLE tickets;
ALTER TABLE tickets_new RENAME TO tickets;
CREATE INDEX tickets_by_column ON tickets (project_id, column_id, position);

CREATE TABLE runs_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
	column_id INTEGER REFERENCES columns (id) ON DELETE SET NULL, -- column (role) at creation
	agent_profile_id INTEGER REFERENCES agent_profiles (id) ON DELETE SET NULL, -- NULL: profile deleted later
	trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'on_enter', 'resume')),
	state TEXT NOT NULL DEFAULT 'queued'
		CHECK (state IN ('queued', 'running', 'waiting_approval', 'paused', 'succeeded', 'failed', 'cancelled')),
	token_hash TEXT UNIQUE CHECK (length(token_hash) = 64), -- SHA-256 hex of the run token, never the plain text
	worktree_path TEXT,
	branch TEXT,
	resumed_from_run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL,
	tokens_in INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
	tokens_out INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
	cost REAL NOT NULL DEFAULT 0 CHECK (cost >= 0), -- USD
	error TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	started_at TEXT,
	finished_at TEXT,
	priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('human', 'blocker', 'review', 'normal')),
	resume_reason TEXT CHECK (resume_reason IN ('context_budget', 'recovery', 'quota', 'halt')),
	-- canonical ISO form (2026-10-02T15:00:00.000Z) because claimRun compares it as text
	not_before TEXT CHECK (not_before IS strftime('%Y-%m-%dT%H:%M:%fZ', not_before)),
	halted INTEGER NOT NULL DEFAULT 0 CHECK (halted IN (0, 1)),
	step_result TEXT CHECK (step_result IN ('done', 'back', 'blocked')),
	CHECK ((finished_at IS NOT NULL) = (state IN ('paused', 'succeeded', 'failed', 'cancelled'))),
	-- The token is valid only while the run is active; afterwards it is gone from the DB.
	CHECK (token_hash IS NULL OR state IN ('running', 'waiting_approval')),
	CHECK (state <> 'failed' OR error IS NOT NULL),
	CHECK (halted = 0 OR state = 'paused')
) STRICT;

INSERT INTO runs_new (id, ticket_id, column_id, agent_profile_id, trigger, state, token_hash, worktree_path, branch,
		resumed_from_run_id, tokens_in, tokens_out, cost, error, created_at, started_at, finished_at, priority, resume_reason,
		not_before, halted, step_result)
	SELECT id, ticket_id, column_id, agent_profile_id, trigger, state, token_hash, worktree_path, branch,
		resumed_from_run_id, tokens_in, tokens_out, cost, error, created_at, started_at, finished_at, priority, resume_reason,
		not_before, halted, step_result
	FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX runs_by_ticket ON runs (ticket_id);
CREATE INDEX runs_by_state ON runs (state);
CREATE INDEX runs_by_resumed_from ON runs (resumed_from_run_id);
-- live.ts pins recentFinishedRuns to this index by name (INDEXED BY)
CREATE INDEX runs_by_finished_at ON runs (finished_at) WHERE state IN ('succeeded', 'failed', 'cancelled');
