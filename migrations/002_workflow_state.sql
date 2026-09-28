-- Zustand für die Workflow-Regeln der Domain-Schicht: Review-Freigabe, Nummernzähler, letzter Spaltenwechsel.

-- Ab wann ein blocks-Vorgänger als erledigt gilt: erst in einer done-Spalte oder schon mit Review-Freigabe.
ALTER TABLE projects ADD COLUMN blocks_satisfied_at TEXT NOT NULL DEFAULT 'done' CHECK (blocks_satisfied_at IN ('done', 'review_ok'));

-- Zuletzt vergebene Ticketnummer: gelöschte Nummern werden nie neu vergeben (MAX+1 würde sie wiederverwenden).
ALTER TABLE projects ADD COLUMN ticket_seq INTEGER NOT NULL DEFAULT 0 CHECK (ticket_seq >= 0);
UPDATE projects SET ticket_seq = (SELECT coalesce(max(number), 0) FROM tickets WHERE project_id = projects.id);

-- Review-Freigabe als Zustand; *_by und moved_by sind Actor-JSON ({"kind": …, "runId": …}).
ALTER TABLE tickets ADD COLUMN review_approved_at TEXT;
ALTER TABLE tickets ADD COLUMN review_approved_by TEXT
	CHECK ((review_approved_by IS NULL) = (review_approved_at IS NULL) AND (review_approved_by IS NULL OR json_valid(review_approved_by)));
-- Actor des letzten Spaltenwechsels (oder der Anlage) — Grundlage der Selbstfreigabe-Sperre.
ALTER TABLE tickets ADD COLUMN moved_by TEXT CHECK (moved_by IS NULL OR json_valid(moved_by));
