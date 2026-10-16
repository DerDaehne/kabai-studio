-- At most one active run per ticket. Databases that already hold several get all but the oldest cancelled and
-- explained on the ticket first, so the index can always be created.
INSERT INTO comments (ticket_id, author_kind, author, body, run_id)
SELECT r.ticket_id, 'system', 'system',
	'Run ' || r.id || ' wurde abgebrochen, weil das Ticket mehrere aktive Runs hatte; Run '
	|| (SELECT min(o.id) FROM runs o WHERE o.ticket_id = r.ticket_id AND o.state IN ('queued', 'running', 'waiting_approval'))
	|| ' ist der älteste und bleibt aktiv.' || char(10) || 'Ausweg: Braucht es den abgebrochenen Run noch, starte nach dem Ende des anderen einen neuen mit „los“.', r.id
FROM runs r
WHERE r.state IN ('queued', 'running', 'waiting_approval')
	AND EXISTS (
		SELECT 1 FROM runs o
		WHERE o.ticket_id = r.ticket_id AND o.id < r.id AND o.state IN ('queued', 'running', 'waiting_approval'))
ORDER BY r.id;

UPDATE runs
SET state = 'cancelled', token_hash = NULL, finished_at = CURRENT_TIMESTAMP
WHERE state IN ('queued', 'running', 'waiting_approval')
	AND EXISTS (
		SELECT 1 FROM runs o
		WHERE o.ticket_id = runs.ticket_id AND o.id < runs.id AND o.state IN ('queued', 'running', 'waiting_approval'));

CREATE UNIQUE INDEX runs_one_active_per_ticket ON runs (ticket_id)
WHERE state IN ('queued', 'running', 'waiting_approval');
