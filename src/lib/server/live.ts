import type { DatabaseSync } from 'node:sqlite';
import type { LiveRun, LiveState } from '$lib/shell/live.svelte';
import type { ProjectRef } from '$lib/shell/shell.svelte';
import type { ProjectPalette } from '$lib/ui/ProjectTag.svelte';
import type { RunState } from './domain/runs';

type ProjectRow = { id: number; key: string; name: string };
type RunRow = ProjectRow & {
	runId: number;
	state: RunState;
	profile: string | null;
	pool: string | null;
	ticket: string;
	asking: 0 | 1;
};

const PALETTE_SLOTS = 5;

// ponytail: the slot follows the id, so colours repeat from the sixth project on (the code stays unique); store a slot in the project settings once that matters.
export const projectRef = ({ id, key, name }: ProjectRow): ProjectRef => ({
	id,
	code: key,
	name,
	palette: (((id - 1) % PALETTE_SLOTS) + 1) as ProjectPalette
});

// Only the newest question of a ticket can still be answered meaningfully; collectAnswer reads no other.
export const OPEN_QUESTION = `q.answer IS NULL AND q.id = (SELECT max(id) FROM questions WHERE ticket_id = q.ticket_id)`;

const ACTIVE_RUNS = `
	WITH candidates AS (
		SELECT r.id AS runId, r.state, ap.name AS profile, ap.pool, p.id, p.key, p.name,
			p.key || '-' || t.number AS ticket,
			EXISTS (SELECT 1 FROM questions q WHERE q.run_id = r.id AND ${OPEN_QUESTION}) AS asking
		FROM runs r
		JOIN tickets t ON t.id = r.ticket_id
		JOIN projects p ON p.id = t.project_id
		LEFT JOIN agent_profiles ap ON ap.id = r.agent_profile_id
		WHERE p.archived = 0)
	SELECT * FROM candidates
	WHERE state IN ('queued', 'running', 'waiting_approval') OR (state = 'paused' AND asking)
	ORDER BY runId`;

const OPEN_QUESTIONS = `
	SELECT count(*) AS count FROM questions q
	JOIN tickets t ON t.id = q.ticket_id
	JOIN projects p ON p.id = t.project_id
	WHERE p.archived = 0 AND ${OPEN_QUESTION}`;

/** What every view shows live across all projects: projects, active and holding runs, open questions. */
export function liveState(db: DatabaseSync): LiveState {
	const projects = db
		.prepare('SELECT id, key, name FROM projects WHERE archived = 0 ORDER BY key')
		.all() as ProjectRow[];
	const runs = db.prepare(ACTIVE_RUNS).all() as RunRow[];
	const { count } = db.prepare(OPEN_QUESTIONS).get() as { count: number };
	return { projects: projects.map(projectRef), runs: runs.map(liveRun), openQuestions: count };
}

function liveRun(row: RunRow): LiveRun {
	return {
		id: row.runId,
		profile: row.profile ?? 'Agent', // the profile of a paused run may have been deleted since
		// ponytail: only the pool "local" counts as local; give profiles a location of their own once a second local pool appears.
		location: row.pool === 'local' ? 'lokal' : 'online',
		project: projectRef(row),
		ticket: row.ticket,
		state: displayState(row.state, row.asking === 1)
	};
}

function displayState(state: RunState, asking: boolean): LiveRun['state'] {
	if (state === 'queued') return 'queued';
	if (state === 'running' && !asking) return 'running';
	return 'waiting';
}
