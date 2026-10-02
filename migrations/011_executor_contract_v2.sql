-- New run event type intervention: a recovery step of the runner or the executor, countable per run and chain.
-- SQLite cannot alter a CHECK, so run_events is rebuilt; no table references it, so foreign_keys may stay on.
CREATE TABLE run_events_new (
	run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
	seq INTEGER NOT NULL CHECK (seq > 0),
	type TEXT NOT NULL CHECK (type IN (
		'message', 'reasoning', 'tool_call', 'tool_result', 'permission_request', 'permission_decision', 'diff', 'log', 'error',
		'intervention')),
	payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
	idempotency_key TEXT CHECK (idempotency_key <> ''),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (run_id, seq),
	UNIQUE (run_id, idempotency_key)
) STRICT;
INSERT INTO run_events_new (run_id, seq, type, payload, idempotency_key, created_at)
	SELECT run_id, seq, type, payload, idempotency_key, created_at FROM run_events;
DROP TABLE run_events;
ALTER TABLE run_events_new RENAME TO run_events;

-- Why the runner queued a run to continue a paused one, and the earliest moment it may be claimed.
-- not_before holds the canonical ISO form (2026-10-02T15:00:00.000Z) because claimRun compares it as text.
ALTER TABLE runs ADD COLUMN resume_reason TEXT CHECK (resume_reason IN ('context_budget', 'recovery', 'quota'));
ALTER TABLE runs ADD COLUMN not_before TEXT CHECK (not_before IS strftime('%Y-%m-%dT%H:%M:%fZ', not_before));
