-- Who can fulfil a task: the agent working the ticket, the system (e.g. after a merge) or the human. Finishing a step
-- requires only the agent's tasks.
ALTER TABLE tasks ADD COLUMN owner TEXT NOT NULL DEFAULT 'agent' CHECK (owner IN ('agent', 'system', 'human'));
