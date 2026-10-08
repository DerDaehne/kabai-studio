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

const minuteIndex = (key: string) => Date.parse(key) / 60_000;
const minuteAt = (index: number) => minuteKey(new Date(index * 60_000));

const emptyPoint = (minute: string): SeriesPoint => ({
	minute,
	steps: 0,
	tokensIn: 0,
	tokensOut: 0
});

/** The step's token fields as a pair, or `undefined` the moment either is missing — never a lone `tokensOut`. */
function tokensOf(
	payload: Record<string, unknown>
): { tokensIn: number; tokensOut: number } | undefined {
	const { tokensIn, tokensOut } = payload;
	return typeof tokensIn === 'number' && typeof tokensOut === 'number'
		? { tokensIn, tokensOut }
		: undefined;
}

/** Folds one more step into a minute's point; a step without both token fields turns the whole minute into a gap. */
function withStep(point: SeriesPoint, payload: Record<string, unknown>): SeriesPoint {
	const added = point.tokensIn === undefined ? undefined : tokensOf(payload);
	return {
		minute: point.minute,
		steps: point.steps + 1,
		tokensIn: added && point.tokensIn !== undefined ? point.tokensIn + added.tokensIn : undefined,
		tokensOut:
			added && point.tokensOut !== undefined ? point.tokensOut + added.tokensOut : undefined
	};
}

/** Every minute strictly between `from` and `to` (both exclusive), oldest first, as empty points. */
function fillGap(from: string, to: string): SeriesPoint[] {
	const points: SeriesPoint[] = [];
	for (let i = minuteIndex(from) + 1; i < minuteIndex(to); i++)
		points.push(emptyPoint(minuteAt(i)));
	return points;
}

/**
 * Appends one live step event (`run.event` with `eventType: 'log'`, `payload.kind: 'step'`) to the series, keeping
 * it equal to what reloading `stepSeries` would return: a minute skipped by this event (no event arrived for it)
 * becomes a zero point, and the window slides — the point count never grows past what the series already held, so
 * the oldest points fall off the front as new ones are appended. A step whose minute is not after the last point's
 * minute (e.g. the client clock running a little behind the server, right at a minute boundary) folds into the
 * last point instead of appending out of order. Any other event is ignored.
 */
export function advanceSeries(
	series: RunSeries,
	event: TraceEvent,
	receivedAt = new Date()
): RunSeries {
	if (event.type !== 'log' || event.payload.kind !== 'step') return series;
	const minute = minuteKey(receivedAt);
	const last = series.points.at(-1);
	if (last && minute <= last.minute) {
		return { ...series, points: [...series.points.slice(0, -1), withStep(last, event.payload)] };
	}
	const windowSize = series.points.length;
	const gap = last ? fillGap(last.minute, minute) : [];
	const points = [...series.points, ...gap, withStep(emptyPoint(minute), event.payload)];
	return { ...series, points: windowSize ? points.slice(-windowSize) : points };
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
