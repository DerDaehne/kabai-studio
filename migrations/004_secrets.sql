-- Secrets: only ciphertext, IV and auth tag (AES-256-GCM); the key never lives in the DB.
CREATE TABLE secrets (
	name TEXT PRIMARY KEY CHECK (name GLOB '[a-z0-9]*' AND name NOT GLOB '*[^a-z0-9_-]*' AND length(name) <= 64),
	ciphertext BLOB NOT NULL CHECK (length(ciphertext) > 0),
	iv BLOB NOT NULL CHECK (length(iv) = 12),
	auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
