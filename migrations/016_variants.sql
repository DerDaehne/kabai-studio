-- Every column becomes one step of a fixed variant; the phase follows from the step. Existing projects become the
-- software variant: known columns keep their id and turn into a step, missing software steps are added, the human
-- columns and columns with unknown names go. Stored transitions, column roles and effort fields are dropped.

ALTER TABLE projects ADD COLUMN variant TEXT NOT NULL DEFAULT 'software' CHECK (variant IN ('software', 'knowledge', 'direct'));

CREATE TEMP TABLE software_steps (step TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
INSERT INTO software_steps (step, name, position) VALUES
	('backlog', 'Backlog', 0),
	('refine', 'Präzisieren', 1),
	('plan', 'Planen', 2),
	('implement', 'Umsetzen', 3),
	('critique', 'Kritik', 4),
	('acceptance', 'Abnahme', 5),
	('done', 'Fertig', 6);

-- The step of every existing column; NULL = the column goes.
CREATE TEMP TABLE column_steps AS
SELECT id, project_id, name, position, kind,
	CASE
		WHEN kind = 'done' THEN 'done'
		WHEN kind <> 'normal' THEN NULL
		WHEN review = 1 THEN 'critique'
		ELSE CASE name
			WHEN 'Backlog' THEN 'backlog'
			WHEN 'Refine' THEN 'refine'
			WHEN 'Ready' THEN 'plan'
			WHEN 'In Arbeit' THEN 'implement'
			WHEN 'Review' THEN 'critique'
			WHEN 'Abnahme' THEN 'acceptance'
		END
	END AS step
FROM columns;

-- A second column for the same step (possible only by hand-written SQL) goes like an unknown one.
UPDATE column_steps SET step = NULL
WHERE EXISTS (
	SELECT 1 FROM column_steps first
	WHERE first.project_id = column_steps.project_id AND first.step = column_steps.step
		AND (first.position < column_steps.position OR (first.position = column_steps.position AND first.id < column_steps.id)));

CREATE TABLE columns_new (
	id INTEGER PRIMARY KEY,
	project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	step TEXT NOT NULL CHECK (step IN ('backlog', 'refine', 'plan', 'implement', 'research', 'draft', 'critique', 'acceptance', 'done')),
	phase TEXT GENERATED ALWAYS AS (
		CASE step WHEN 'backlog' THEN 'open' WHEN 'acceptance' THEN 'acceptance' WHEN 'done' THEN 'done' ELSE 'work' END) VIRTUAL,
	name TEXT NOT NULL,
	position INTEGER NOT NULL DEFAULT 0,
	UNIQUE (project_id, step),
	UNIQUE (project_id, id) -- target of the composite FKs: the column belongs to the same project
) STRICT;

INSERT INTO columns_new (id, project_id, step, name, position)
	SELECT c.id, c.project_id, c.step, s.name, s.position FROM column_steps c JOIN software_steps s ON s.step = c.step;
-- Added columns get ids above every old one, so no ticket or run pointing to a dropped column lands in them.
INSERT INTO columns_new (id, project_id, step, name, position)
	SELECT coalesce((SELECT max(id) FROM column_steps), 0) + row_number() OVER (ORDER BY p.id, s.position),
		p.id, s.step, s.name, s.position
	FROM projects p CROSS JOIN software_steps s
	WHERE NOT EXISTS (SELECT 1 FROM columns_new c WHERE c.project_id = p.id AND c.step = s.step);

-- A ticket waiting in a human column goes back to the work step of its newest run there, else to the backlog; its
-- questions, runs and review approval stay as they are.
UPDATE tickets SET column_id = coalesce(
	(SELECT c.id FROM runs r JOIN columns_new c ON c.id = r.column_id
		WHERE r.ticket_id = tickets.id AND c.phase = 'work' ORDER BY r.id DESC LIMIT 1),
	(SELECT id FROM columns_new WHERE project_id = tickets.project_id AND step = 'backlog'))
WHERE column_id IN (SELECT id FROM column_steps WHERE kind IN ('human_intervention', 'human_answered'));

INSERT INTO comments (ticket_id, author_kind, author, body)
	SELECT t.id, 'system', 'system', 'Die Spalte „' || c.name || '“ gibt es nicht mehr. Das Ticket liegt jetzt im Backlog.'
	FROM tickets t JOIN column_steps c ON c.id = t.column_id
	WHERE c.step IS NULL
	ORDER BY t.id;
UPDATE tickets SET column_id = (SELECT id FROM columns_new WHERE project_id = tickets.project_id AND step = 'backlog')
WHERE column_id IN (SELECT id FROM column_steps WHERE step IS NULL);

-- Explicitly, because foreign keys are off during a migration and ON DELETE SET NULL does not fire.
UPDATE runs SET column_id = NULL WHERE column_id IN (SELECT id FROM column_steps WHERE step IS NULL);

DROP TABLE transitions;
DROP TABLE columns;
ALTER TABLE columns_new RENAME TO columns;
DROP TABLE column_steps;
DROP TABLE software_steps;

-- XS–XL replaces the effort estimate; tokens and cost of the runs replace the actual effort.
ALTER TABLE tickets ADD COLUMN size TEXT CHECK (size IN ('XS', 'S', 'M', 'L', 'XL'));
ALTER TABLE tickets DROP COLUMN effort_estimate;
ALTER TABLE tickets DROP COLUMN effort_actual;
ALTER TABLE tickets DROP COLUMN effort_unit;
