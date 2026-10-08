import type { DatabaseSync } from 'node:sqlite';
import { minuteKey, type RunSeries, type SeriesPoint } from '$lib/trace/step-series';

export const DEFAULT_WINDOW_MINUTES = 30;

type StepRow = {
	runId: number;
	minute: string;
	steps: number;
	tokensIn: number | null;
	tokensOut: number | null;
	missing: number;
};

/**
 * One row per run and minute. `run_id IN (...)` seeks the primary key `(run_id, seq)` once per run, then a cheap
 * scan within that run's own rows filters type/kind/time — no index on `run_events(created_at)` is needed for
 * that. The caller picks which run ids to ask for; this query never scans `runs` to find them.
 * Exported only so the query-plan test can run `EXPLAIN QUERY PLAN` on this exact text.
 */
export const STEP_MINUTES = `
	SELECT run_id AS runId,
		strftime('%Y-%m-%dT%H:%M:00Z', created_at) AS minute,
		count(*) AS steps,
		sum(payload ->> '$.tokensIn') AS tokensIn,
		sum(payload ->> '$.tokensOut') AS tokensOut,
		sum(CASE WHEN payload ->> '$.tokensIn' IS NULL THEN 1 ELSE 0 END) AS missing
	FROM run_events
	WHERE run_id IN (SELECT value FROM json_each(?1)) AND type = 'log' AND payload ->> '$.kind' = 'step'
		AND created_at >= ?2
	GROUP BY run_id, minute`;

const sqliteTime = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');

/** Every minute from `windowMinutes` ago up to `now`, oldest first, truncated to its minute start. */
function minuteGrid(now: Date, windowMinutes: number): string[] {
	const end = Math.floor(now.getTime() / 60_000);
	const start = end - windowMinutes + 1;
	return Array.from({ length: windowMinutes }, (_, i) => minuteKey(new Date((start + i) * 60_000)));
}

const rowKey = (runId: number, minute: string) => `${runId}:${minute}`;

/** A minute without a row is empty (no steps, so no tokens either — a real zero, not a gap). */
function pointOf(rows: Map<string, StepRow>, runId: number, minute: string): SeriesPoint {
	const row = rows.get(rowKey(runId, minute));
	if (!row) return { minute, steps: 0, tokensIn: 0, tokensOut: 0 };
	const hasTokens = row.missing === 0;
	return {
		minute,
		steps: row.steps,
		tokensIn: hasTokens ? (row.tokensIn ?? 0) : undefined,
		tokensOut: hasTokens ? (row.tokensOut ?? 0) : undefined
	};
}

/**
 * Per-minute step and token counts for each run id, over the last `windowMinutes` (at least 1, default 30) up to
 * `now`. One query for every run, no N+1. A minute where any step's payload lacks `tokensIn`/`tokensOut` (an older
 * run that predates them) is a token gap for that minute, never a silent zero.
 */
export function stepSeries(
	db: DatabaseSync,
	runIds: number[],
	windowMinutes = DEFAULT_WINDOW_MINUTES,
	now = new Date()
): RunSeries[] {
	if (windowMinutes < 1) throw new Error(`windowMinutes must be at least 1, got ${windowMinutes}`);
	const grid = minuteGrid(now, windowMinutes);
	const rows = runIds.length
		? (db
				.prepare(STEP_MINUTES)
				.all(JSON.stringify(runIds), sqliteTime(new Date(grid[0]))) as StepRow[])
		: [];
	const byKey = new Map(rows.map((row) => [rowKey(row.runId, row.minute), row]));
	return runIds.map((runId) => ({
		runId,
		points: grid.map((minute) => pointOf(byKey, runId, minute))
	}));
}
