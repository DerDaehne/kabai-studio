-- liveState and claimRun scan questions and runs fully once history grows; four indexes fix that.

-- liveState's open-question check (EXISTS ... questions q WHERE q.run_id = r.id) scans questions per run without this.
CREATE INDEX questions_by_run ON questions (run_id);

-- Covers claimRun's queued/running/waiting_approval filters, liveState's active-run filter and failOrphanedRuns.
CREATE INDEX runs_by_state ON runs (state);

-- liveState's awaitsResume (NOT EXISTS ... runs c WHERE c.resumed_from_run_id = r.id) scans runs per row without this.
CREATE INDEX runs_by_resumed_from ON runs (resumed_from_run_id);

-- Only the ended runs recentFinishedRuns ever reads; already ordered by finished_at, so no sort step is needed either.
CREATE INDEX runs_by_finished_at ON runs (finished_at) WHERE state IN ('succeeded', 'failed', 'cancelled');
