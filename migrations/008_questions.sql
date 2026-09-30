-- Questions an agent asks the human, with up to three answer options. The domain layer (domain/questions.ts)
-- decides who may answer and until when an answer can be retracted.

CREATE TABLE questions (
	id INTEGER PRIMARY KEY,
	ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
	run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL,
	question TEXT NOT NULL CHECK (question <> ''),
	options TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options) AND json_type(options) = 'array' AND json_array_length(options) <= 3),
	answer TEXT CHECK (answer IS NULL OR json_valid(answer)), -- {"option": n} (1-based) or {"text": "…"}
	answered_at TEXT,
	collected_at TEXT, -- the agent picked the answer up; from then on it is final
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CHECK ((answer IS NULL) = (answered_at IS NULL)),
	CHECK (collected_at IS NULL OR answer IS NOT NULL)
) STRICT;
CREATE INDEX questions_by_ticket ON questions (ticket_id, id);
