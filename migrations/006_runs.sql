-- Agent profiles, runs and run events. The domain layer (domain/runs.ts) governs state transitions, seq numbers and run tokens.

CREATE TABLE agent_profiles (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL UNIQUE CHECK (name <> ''),
	executor TEXT NOT NULL CHECK (executor IN ('builtin', 'acp')),
	provider TEXT, -- builtin
	base_url TEXT,
	model TEXT,
	command TEXT, -- acp
	args TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(args) AND json_type(args) = 'array'),
	-- Only a reference (secret:<name> or ${ENV_NAME}), never the key itself.
	api_key_ref TEXT CHECK (api_key_ref GLOB 'secret:?*' OR api_key_ref GLOB '${?*}'),
	params TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params) AND json_type(params) = 'object'),
	extra_prompt TEXT NOT NULL DEFAULT '',
	permission_policy TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(permission_policy) AND json_type(permission_policy) = 'object'),
	max_steps INTEGER CHECK (max_steps > 0),
	max_tokens INTEGER CHECK (max_tokens > 0),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CHECK (executor <> 'builtin' OR (provider IS NOT NULL AND model IS NOT NULL)),
	CHECK (executor <> 'acp' OR command IS NOT NULL)
) STRICT;

CREATE TABLE runs (
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
	CHECK ((finished_at IS NOT NULL) = (state IN ('paused', 'succeeded', 'failed', 'cancelled'))),
	-- The token is valid only while the run is active; afterwards it is gone from the DB.
	CHECK (token_hash IS NULL OR state IN ('running', 'waiting_approval')),
	CHECK (state <> 'failed' OR error IS NOT NULL)
) STRICT;
CREATE INDEX runs_by_ticket ON runs (ticket_id);

CREATE TABLE run_events (
	run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
	seq INTEGER NOT NULL CHECK (seq > 0), -- without gaps per run
	type TEXT NOT NULL CHECK (type IN (
		'message', 'reasoning', 'tool_call', 'tool_result', 'permission_request', 'permission_decision', 'diff', 'log', 'error')),
	payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
	idempotency_key TEXT CHECK (idempotency_key <> ''), -- repeating the same call creates no second event
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (run_id, seq),
	UNIQUE (run_id, idempotency_key)
) STRICT;

-- Deferred from 001: in SQLite a FK to a table that does not exist yet blocks every DML on comments.
ALTER TABLE comments ADD COLUMN run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL;
