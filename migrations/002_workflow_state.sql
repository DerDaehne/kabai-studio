-- State for the domain layer's workflow rules: review approval, number counter, last column change.

-- When a blocks predecessor counts as finished: only in a done column, or already with its review approval.
ALTER TABLE projects ADD COLUMN blocks_satisfied_at TEXT NOT NULL DEFAULT 'done' CHECK (blocks_satisfied_at IN ('done', 'review_ok'));

-- Last assigned ticket number: deleted numbers are never reassigned (MAX+1 would reuse them).
ALTER TABLE projects ADD COLUMN ticket_seq INTEGER NOT NULL DEFAULT 0 CHECK (ticket_seq >= 0);
UPDATE projects SET ticket_seq = (SELECT coalesce(max(number), 0) FROM tickets WHERE project_id = projects.id);

-- Review approval as state; *_by and moved_by are actor JSON ({"kind": …, "runId": …}).
ALTER TABLE tickets ADD COLUMN review_approved_at TEXT;
ALTER TABLE tickets ADD COLUMN review_approved_by TEXT
	CHECK ((review_approved_by IS NULL) = (review_approved_at IS NULL) AND (review_approved_by IS NULL OR json_valid(review_approved_by)));
-- Actor of the last column change (or of the creation) — the basis of the self-approval lock.
ALTER TABLE tickets ADD COLUMN moved_by TEXT CHECK (moved_by IS NULL OR json_valid(moved_by));
