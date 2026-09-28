-- Auth: ein Owner-Account (Anlage atomar in der Domain, „nur wenn noch keiner existiert"), Sessions nur als Token-Hash.

CREATE TABLE users (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL UNIQUE CHECK (name <> ''),
	password_hash TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64), -- SHA-256 hex; der Token selbst (base64url, 43 Zeichen) steht nur im Cookie
	user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	expires_at TEXT NOT NULL, -- UTC 'YYYY-MM-DD HH:MM:SS', gleitend verlängert
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
