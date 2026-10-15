-- Machines paired as runners. Only the SHA-256 of a runner's credential is stored; the credential itself is handed
-- out once at pairing and lives only on that machine. Deleting the row revokes it.

CREATE TABLE runners (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE CHECK (name <> ''),
	credential_hash TEXT NOT NULL UNIQUE CHECK (length(credential_hash) = 64), -- SHA-256 hex of the 32-byte credential
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_seen_at TEXT
) STRICT;
