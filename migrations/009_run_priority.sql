-- Claim order of queued runs: human > blocker > review > normal, FIFO among equals. The domain layer (domain/runs.ts)
-- derives the priority when a run is created; only the human raises it to human.
ALTER TABLE runs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('human', 'blocker', 'review', 'normal'));

-- Runs triggered in a review column get the review priority. Existing boards only have the default Review column.
ALTER TABLE columns ADD COLUMN review INTEGER NOT NULL DEFAULT 0 CHECK (review IN (0, 1));
UPDATE columns SET review = 1 WHERE name = 'Review';
