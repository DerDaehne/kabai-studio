-- Auth: one owner account (created atomically in the domain, only while none exists), sessions only as token hash.

CREATE TABLE users (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL UNIQUE CHECK (name <> ''),
	password_hash TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64), -- SHA-256 hex; the token itself (base64url, 43 characters) lives only in the cookie
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	expires_at TEXT NOT NULL, -- UTC 'YYYY-MM-DD HH:MM:SS', extended sliding
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
