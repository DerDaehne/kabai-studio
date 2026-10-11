import type { DatabaseSync } from 'node:sqlite';
import type { LiveRun, LiveState, ProjectRef, QueuedQuestion } from '$lib/live';
import type { ProjectPalette } from '$lib/ui/ProjectTag.svelte';
import { OPEN_QUESTION } from './domain/core';
import { haltKind } from './domain/halt';
import { awaitsResume, type RunState } from './domain/runs';

type ProjectRow = { id: number; key: string; name: string };
type RunRow = ProjectRow & {
	runId: number;
	state: RunState;
	profile: string | null;
	pool: string | null;
	ticket: string;
	asking: 0 | 1;
	halted: 0 | 1;
};

const PALETTE_SLOTS = 5;

// ponytail: the slot follows the id, so colours repeat from the sixth project on (the code stays unique); store a slot in the project settings once that matters.
export const projectRef = ({ id, key, name }: ProjectRow): ProjectRef => ({
	id,
	code: key,
	name,
	palette: (((id - 1) % PALETTE_SLOTS) + 1) as ProjectPalette
});

export { OPEN_QUESTION };

export const ACTIVE_RUNS = `
	WITH candidates AS (
		SELECT r.id AS runId, r.state, ap.name AS profile, ap.pool, p.id, p.key, p.name,
			p.key || '-' || t.number AS ticket,
			EXISTS (SELECT 1 FROM questions q WHERE q.run_id = r.id AND ${OPEN_QUESTION}) AS asking,
			${awaitsResume('r')} AS halted
		FROM runs r
		JOIN tickets t ON t.id = r.ticket_id
		JOIN projects p ON p.id = t.project_id
		LEFT JOIN agent_profiles ap ON ap.id = r.agent_profile_id
		WHERE p.archived = 0)
	SELECT * FROM candidates
	WHERE state IN ('queued', 'running', 'waiting_approval') OR (state = 'paused' AND (asking OR halted))
	ORDER BY runId`;

const OPEN_QUESTIONS = `
	SELECT count(*) AS count FROM questions q
	JOIN tickets t ON t.id = q.ticket_id
	JOIN projects p ON p.id = t.project_id
	WHERE p.archived = 0 AND ${OPEN_QUESTION}`;

// Every run the kill switch would cancel, in archived projects too.
const ACTIVE_RUN_COUNT =
	"SELECT count(*) AS count FROM runs WHERE state IN ('running', 'waiting_approval')";

/** What every view shows live across all projects: projects, active, holding and halted runs, open questions, the halt. */
export function liveState(db: DatabaseSync): LiveState {
	const projects = db
		.prepare('SELECT id, key, name FROM projects WHERE archived = 0 ORDER BY key')
		.all() as ProjectRow[];
	const runs = db.prepare(ACTIVE_RUNS).all() as RunRow[];
	const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
	return {
		projects: projects.map(projectRef),
		runs: runs.map(liveRun),
		openQuestions: count(OPEN_QUESTIONS),
		halt: haltKind(db),
		activeRuns: count(ACTIVE_RUN_COUNT)
	};
}

function liveRun(row: RunRow): LiveRun {
	return {
		id: row.runId,
		profile: row.profile ?? 'Agent', // the profile of a paused run may have been deleted since
		// ponytail: only the pool "local" counts as local; give profiles a location of their own once a second local pool appears.
		location: row.pool === 'local' ? 'lokal' : 'online',
		project: projectRef(row),
		ticket: row.ticket,
		state: displayState(row)
	};
}

function displayState({ state, asking, halted }: RunRow): LiveRun['state'] {
	if (state === 'queued') return 'queued';
	if (halted) return 'paused';
	if (state === 'running' && !asking) return 'running';
	return 'waiting';
}

export type FinishedRunState = 'succeeded' | 'failed' | 'cancelled';

export type FinishedRun = {
	id: number;
	project: ProjectRef;
	/** e.g. `STU-12` */
	ticket: string;
	number: number;
	state: FinishedRunState;
	/** ISO timestamps; `startedAt` is null for a run cancelled before it started. */
	startedAt: string | null;
	finishedAt: string;
	/** In US dollars; 0 for a profile without a price. */
	cost: number;
	/** The first line of the stored error; only set for a failed run. */
	summary: string | null;
};

type FinishedRunRow = ProjectRow & {
	runId: number;
	state: FinishedRunState;
	number: number;
	error: string | null;
	cost: number;
	startedAt: string | null;
	finishedAt: string;
};

// 'paused' ends a run too (it can still resume), so it stays out: it belongs with the active runs above, not here.
// INDEXED BY pins the plan to runs_by_finished_at: without ANALYZE statistics SQLite sometimes prefers the broader
// runs_by_state index here and re-sorts the result instead.
export const FINISHED_RUNS = `
	SELECT r.id AS runId, r.state, r.error, r.cost, p.id, p.key, p.name, t.number,
		strftime('%Y-%m-%dT%H:%M:%SZ', r.started_at) AS startedAt, strftime('%Y-%m-%dT%H:%M:%SZ', r.finished_at) AS finishedAt
	FROM runs r INDEXED BY runs_by_finished_at
	JOIN tickets t ON t.id = r.ticket_id
	JOIN projects p ON p.id = t.project_id
	WHERE p.archived = 0 AND r.state IN ('succeeded', 'failed', 'cancelled')
	ORDER BY r.finished_at DESC, r.id DESC -- finished_at has second resolution; id breaks a tie within the same second
	LIMIT 5`;

/** The last 5 runs that ended for good, across every project, newest first. */
export function recentFinishedRuns(db: DatabaseSync): FinishedRun[] {
	return (db.prepare(FINISHED_RUNS).all() as FinishedRunRow[]).map(finishedRun);
}

function finishedRun(row: FinishedRunRow): FinishedRun {
	return {
		id: row.runId,
		project: projectRef(row),
		ticket: `${row.key}-${row.number}`,
		number: row.number,
		state: row.state,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		cost: row.cost,
		summary: row.state === 'failed' ? (row.error ?? '').split('\n')[0] : null
	};
}

type QuestionRow = {
	id: number;
	question: string;
	options: string;
	createdAt: string;
	number: number;
	title: string;
	projectId: number;
	key: string;
	name: string;
	profile: string | null;
	runId: number | null;
};

// The same open questions the head's Takt title counts, so the queue and the count never disagree.
const OPEN_QUESTION_LIST = `
	SELECT q.id, q.question, q.options, q.created_at AS createdAt, t.number, t.title,
		p.id AS projectId, p.key, p.name, ap.name AS profile, q.run_id AS runId
	FROM questions q
	JOIN tickets t ON t.id = q.ticket_id
	JOIN projects p ON p.id = t.project_id
	LEFT JOIN runs r ON r.id = q.run_id
	LEFT JOIN agent_profiles ap ON ap.id = r.agent_profile_id
	WHERE p.archived = 0 AND ${OPEN_QUESTION}
	ORDER BY q.id`;

/** Every open question across the active projects, oldest first. */
export function openQuestions(db: DatabaseSync): QueuedQuestion[] {
	return (db.prepare(OPEN_QUESTION_LIST).all() as QuestionRow[]).map((row) => ({
		id: row.id,
		ticket: { ref: `${row.key}-${row.number}`, number: row.number, title: row.title },
		project: projectRef({ id: row.projectId, key: row.key, name: row.name }),
		profile: row.profile,
		runId: row.runId,
		askedAt: new Date(`${row.createdAt.replace(' ', 'T')}Z`).toISOString(), // SQLite stores UTC without a zone
		question: row.question,
		options: JSON.parse(row.options)
	}));
}
