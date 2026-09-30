-- Parallelism pool of a profile: the runner limits active runs overall and per pool (e.g. local, cloud),
-- so local and cloud runs never take each other's slots. Defaults to local because local models come first.
ALTER TABLE agent_profiles ADD COLUMN pool TEXT NOT NULL DEFAULT 'local' CHECK (pool <> '');
