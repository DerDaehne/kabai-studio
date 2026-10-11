-- How a run ended its step with finish_step; NULL while it has not. The chain queues the next step's run only after a
-- run that finished its step with done or back, and the round limit counts the back results of critique runs.
ALTER TABLE runs ADD COLUMN step_result TEXT CHECK (step_result IN ('done', 'back', 'blocked'));
