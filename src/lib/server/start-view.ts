import type { DatabaseSync } from 'node:sqlite';
import type { ProjectRef } from '$lib/live';
import type { SeriesPoint } from '$lib/trace/step-series';
import type { TraceEvent } from '$lib/trace/trace';
import { rank, waitReason } from './domain/runs';
import { projectRef, recentFinishedRuns, type FinishedRun } from './live';
import { LIMITS } from './runner';
import { stepSeries } from './step-series';
import { splitError, wayOutsOf } from './ticket-view';

/** A queued run as the operations section lists it, in the order the runner will claim it. */
export type QueuedRun = {
	id: number;
	project: ProjectRef;
	ticket: string;
	number: number;
	profile: string;
	/** Why it does not run yet, in the words the Run-Akte uses. */
	waitText: string;
	/** ISO timestamp of a retry delay; null when the run may start at the next claim. */
	notBefore: string | null;
};

/** A run an agent works on right now, with the tail of its events for the trace section and its step series. */
export type RunTrack = {
	id: number;
	startedAt: string;
	events: TraceEvent[];
	series: SeriesPoint[];
};

export type FinishedRunWithWayOut = FinishedRun & { failure?: { code: string; wayOut: string } };

export type StartView = {
	queued: QueuedRun[];
	finished: FinishedRunWithWayOut[];
	tracks: RunTrack[];
	today: { tokens: number; cost: number };
};

// ponytail: the operations section shows the first 10 queued runs and asks waitReason once per row; page the list
// and fold the wait reason into the query once queues grow longer than that.
const QUEUED_SHOWN = 10;
// ponytail: a running run's trace is rebuilt from its newest 200 events, enough for the last 5 steps of any run seen
// so far; read the events back step by step once a step can carry more calls than that.
const TAIL_EVENTS = 200;

const iso = (column: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${column})`;

export const QUEUED_RUNS = `
	SELECT r.id AS runId, r.not_before AS notBefore, ap.name AS profile, p.id, p.key, p.name, t.number
	FROM runs r
	JOIN agent_profiles ap ON ap.id = r.agent_profile_id
	JOIN tickets t ON t.id = r.ticket_id
	JOIN projects p ON p.id = t.project_id
	WHERE r.state = 'queued' AND p.archived = 0
	ORDER BY ${rank('r.priority')}, r.id
	LIMIT ${QUEUED_SHOWN}`;

export const TRACKED_RUNS = `
	SELECT r.id, ${iso('r.started_at')} AS startedAt
	FROM runs r
	JOIN tickets t ON t.id = r.ticket_id
	JOIN projects p ON p.id = t.project_id
	WHERE r.state IN ('running', 'waiting_approval') AND p.archived = 0
	ORDER BY r.id`;

const tailQuery = (runCount: number) => `
	SELECT run_id AS runId, seq, type, idempotency_key AS key, payload FROM (
		SELECT *, row_number() OVER (PARTITION BY run_id ORDER BY seq DESC) AS newest FROM run_events
		WHERE run_id IN (${Array(runCount).fill('?').join(', ')}))
	WHERE newest <= ${TAIL_EVENTS} ORDER BY runId, seq`;

// ponytail: "today" counts runs that finished or started since local midnight, a run running across midnight
// with all its tokens; split usage per step once a day boundary has to be exact.
export const TODAY_USAGE = `
	SELECT coalesce(sum(tokens_in + tokens_out), 0) AS tokens, coalesce(sum(cost), 0) AS cost FROM (
		SELECT tokens_in, tokens_out, cost FROM runs
		WHERE state IN ('succeeded', 'failed', 'cancelled') AND finished_at >= ?1
		UNION ALL
		SELECT tokens_in, tokens_out, cost FROM runs
		WHERE state IN ('running', 'waiting_approval', 'paused') AND started_at >= ?1)`;

type QueuedRow = { runId: number; notBefore: string | null; profile: string; id: number } & {
	key: string;
	name: string;
	number: number;
};

function queuedRuns(db: DatabaseSync): QueuedRun[] {
	return (db.prepare(QUEUED_RUNS).all() as QueuedRow[]).map((row) => ({
		id: row.runId,
		project: projectRef(row),
		ticket: `${row.key}-${row.number}`,
		number: row.number,
		profile: row.profile,
		waitText: waitReason(db, row.runId, LIMITS)?.text ?? '',
		notBefore: row.notBefore
	}));
}

function tailEvents(db: DatabaseSync, runIds: number[]): Map<number, TraceEvent[]> {
	const rows = db.prepare(tailQuery(runIds.length)).all(...runIds) as (Omit<
		TraceEvent,
		'payload'
	> & {
		runId: number;
		payload: string;
	})[];
	const byRun = new Map<number, TraceEvent[]>(runIds.map((id) => [id, []]));
	for (const { runId, ...row } of rows)
		byRun.get(runId)!.push({ ...row, payload: JSON.parse(row.payload) });
	return byRun;
}

function runTracks(db: DatabaseSync, now: Date): RunTrack[] {
	const runs = db.prepare(TRACKED_RUNS).all() as { id: number; startedAt: string }[];
	const series = stepSeries(
		db,
		runs.map((run) => run.id),
		undefined,
		now
	);
	const events = tailEvents(
		db,
		runs.map((run) => run.id)
	);
	return runs.map((run, i) => ({
		...run,
		events: events.get(run.id)!,
		series: series[i].points
	}));
}

/** SQLite's `CURRENT_TIMESTAMP` form (UTC) of the server's local midnight before `now`. */
function localMidnight(now: Date): string {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	return midnight.toISOString().slice(0, 19).replace('T', ' ');
}

function withWayOuts(db: DatabaseSync, finished: FinishedRun[]): FinishedRunWithWayOut[] {
	const wayOuts = wayOutsOf(
		db,
		finished.filter((run) => run.state === 'failed').map((run) => run.id)
	);
	return finished.map((run) =>
		run.state === 'failed'
			? {
					...run,
					failure: { code: splitError(run.summary ?? '').code, wayOut: wayOuts.get(run.id) ?? '' }
				}
			: run
	);
}

/** Everything the start view shows beyond the live state the root layout already loads. */
export function startView(db: DatabaseSync, now = new Date()): StartView {
	return {
		queued: queuedRuns(db),
		finished: withWayOuts(db, recentFinishedRuns(db)),
		tracks: runTracks(db, now),
		today: db.prepare(TODAY_USAGE).get(localMidnight(now)) as StartView['today']
	};
}
