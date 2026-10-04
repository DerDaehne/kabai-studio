-- A halt either stops (active runs cancelled) or pauses (active runs paused, resumable); both hold the queue.
-- A halt set before this migration was a stop.
ALTER TABLE runner_halt ADD COLUMN kind TEXT NOT NULL DEFAULT 'stop' CHECK (kind IN ('stop', 'pause'));

-- halted marks a run the human paused; the run that resumes it has the resume reason halt.
-- SQLite cannot alter a CHECK, so runs is rebuilt. The migration runner keeps foreign keys off meanwhile, so the rows
-- that reference a run (events, comments, questions, idempotent calls, resumed runs) stay as they are.
CREATE TABLE runs_new (
	id INTEGER PRIMARY KEY,
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
	CHECK ((finished_at IS NOT NULL) = (state IN ('paused', 'succeeded', 'failed', 'cancelled'))),
	-- The token is valid only while the run is active; afterwards it is gone from the DB.
	CHECK (token_hash IS NULL OR state IN ('running', 'waiting_approval')),
	CHECK (state <> 'failed' OR error IS NOT NULL),
	CHECK (halted = 0 OR state = 'paused')
) STRICT;
INSERT INTO runs_new (id, ticket_id, column_id, agent_profile_id, trigger, state, token_hash, worktree_path, branch,
		resumed_from_run_id, tokens_in, tokens_out, cost, error, created_at, started_at, finished_at, priority, resume_reason,
		not_before)
	SELECT id, ticket_id, column_id, agent_profile_id, trigger, state, token_hash, worktree_path, branch,
		resumed_from_run_id, tokens_in, tokens_out, cost, error, created_at, started_at, finished_at, priority, resume_reason,
		not_before
	FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX runs_by_ticket ON runs (ticket_id);
