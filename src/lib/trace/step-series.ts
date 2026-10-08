import { formatCount } from './trace';
import type { TraceEvent } from './trace';

/**
 * One run's step/token count for one minute of its time series. `tokensIn`/`tokensOut` are `undefined` when any
 * step in that minute has no token fields in its payload (an older run that predates them) — a gap, never a
 * silent zero.
 */
export type SeriesPoint = {
	/** The minute's start, UTC, e.g. `2026-10-08T16:42:00Z`. */
	minute: string;
	steps: number;
	tokensIn?: number;
	tokensOut?: number;
};

export type RunSeries = {
	runId: number;
	points: SeriesPoint[];
};

/** `date` truncated to its minute, in the same form the server buckets `run_events.created_at` into. */
export const minuteKey = (date: Date): string => `${date.toISOString().slice(0, 16)}:00Z`;

const emptyPoint = (minute: string): SeriesPoint => ({
	minute,
	steps: 0,
	tokensIn: 0,
	tokensOut: 0
});

/** Folds one more step into a minute's point; a step without token fields turns the whole minute into a gap. */
function withStep(point: SeriesPoint, payload: Record<string, unknown>): SeriesPoint {
	const tokensIn = typeof payload.tokensIn === 'number' ? payload.tokensIn : undefined;
	const tokensOut = typeof payload.tokensOut === 'number' ? payload.tokensOut : undefined;
	const known = point.tokensIn !== undefined && tokensIn !== undefined;
	return {
		minute: point.minute,
		steps: point.steps + 1,
		tokensIn: known ? point.tokensIn! + tokensIn! : undefined,
		tokensOut: known ? point.tokensOut! + tokensOut! : undefined
	};
}

/**
 * Appends one live step event (`run.event` with `eventType: 'log'`, `payload.kind: 'step'`) to the series' running
 * minute; any other event is ignored. `receivedAt` (not a server timestamp — a live event carries none) decides the
 * minute; a reload after reconnect or `invalidate` replaces the series with the authoritative server one again.
 */
export function advanceSeries(
	series: RunSeries,
	event: TraceEvent,
	receivedAt = new Date()
): RunSeries {
	if (event.type !== 'log' || event.payload.kind !== 'step') return series;
	const minute = minuteKey(receivedAt);
	const last = series.points.at(-1);
	const point = withStep(last?.minute === minute ? last : emptyPoint(minute), event.payload);
	const points = last?.minute === minute ? series.points.slice(0, -1) : series.points;
	return { ...series, points: [...points, point] };
}

const trend = (values: number[]): 'steigend' | 'fallend' | 'gleichbleibend' => {
	if (values.length < 2) return 'gleichbleibend';
	const mid = Math.floor(values.length / 2);
	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	const first = sum(values.slice(0, mid));
	const second = sum(values.slice(mid));
	if (second > first) return 'steigend';
	if (second < first) return 'fallend';
	return 'gleichbleibend';
};

/** The step sparkline announced as a sentence, e.g. "12 Schritte in 30 min, steigend". */
export function stepsSeriesText(points: SeriesPoint[], windowMinutes: number): string {
	const total = points.reduce((sum, p) => sum + p.steps, 0);
	return `${formatCount(total)} Schritte in ${windowMinutes} min, ${trend(points.map((p) => p.steps))}`;
}

/**
 * The token sparkline announced as a sentence; an old run without token data in some or all minutes says so
 * explicitly instead of reporting a lower (or zero) total.
 */
export function tokensSeriesText(points: SeriesPoint[], windowMinutes: number): string {
	const known = points.filter((p) => p.tokensIn !== undefined);
	if (known.length === 0)
		return `Keine Token-Daten für die letzten ${windowMinutes} min (alter Run ohne Aufzeichnung).`;
	const total = known.reduce((sum, p) => sum + (p.tokensIn ?? 0) + (p.tokensOut ?? 0), 0);
	const gap = known.length < points.length ? ' (Teil des Zeitraums ohne Token-Daten)' : '';
	const values = known.map((p) => (p.tokensIn ?? 0) + (p.tokensOut ?? 0));
	return `${formatCount(total)} Tokens in ${windowMinutes} min, ${trend(values)}${gap}`;
}
