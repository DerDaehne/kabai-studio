-- The kill switch: while its one row exists, the runner claims no run. Kept in the database so that it outlasts a restart.
CREATE TABLE runner_halt (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	halted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
