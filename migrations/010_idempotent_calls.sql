-- Agent writes sent with an idempotency key, bound to their run: a repeat gets the first result back instead of
-- writing twice. The domain layer (domain/idempotency.ts) decides about a reused key and an expired one.
CREATE TABLE idempotent_calls (
	run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
	key TEXT NOT NULL CHECK (key <> ''),
	request_hash TEXT NOT NULL, -- SHA-256 of tool and arguments: the same key for another call is refused
	result TEXT NOT NULL CHECK (json_valid(result)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (run_id, key)
) STRICT;
