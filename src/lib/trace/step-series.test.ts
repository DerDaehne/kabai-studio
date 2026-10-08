import { describe, expect, it } from 'vitest';
import type { TraceEvent } from './trace';
import {
	advanceSeries,
	minuteKey,
	stepsSeriesText,
	tokensSeriesText,
	type RunSeries
} from './step-series';

// As the live stream hands it to advanceSeries: already unwrapped via liveTraceEvent, so `type` is the inner
// `eventType` ('log'), not the outer 'run.event'.
const stepEvent = (seq: number, payload: Record<string, unknown> = {}): TraceEvent => ({
	seq,
	type: 'log',
	key: null,
	payload: { kind: 'step', step: seq, ...payload }
});

const zeroPoint = (minute: string) => ({ minute, steps: 0, tokensIn: 0, tokensOut: 0 });

// A 3-minute window as `stepSeries` would load it, ending at the current minute — the realistic starting point
// for `advanceSeries`, which is always called on a series a load already brought to its full window length.
const loaded = (): RunSeries => ({
	runId: 1,
	points: [
		zeroPoint('2026-10-08T16:40:00Z'),
		zeroPoint('2026-10-08T16:41:00Z'),
		zeroPoint('2026-10-08T16:42:00Z')
	]
});

describe('minuteKey', () => {
	it('truncates a timestamp to the start of its minute, in UTC', () => {
		expect(minuteKey(new Date('2026-10-08T16:42:59.999Z'))).toBe('2026-10-08T16:42:00Z');
	});
});

describe('advanceSeries', () => {
	const t = new Date('2026-10-08T16:42:10Z');

	it('ignores a log event that is not a step (e.g. a model-loading notice)', () => {
		const series = loaded();
		const event: TraceEvent = { seq: 1, type: 'log', key: null, payload: { kind: 'phase' } };
		expect(advanceSeries(series, event, t)).toBe(series);
	});

	it('ignores a non-log event even if its payload happens to carry kind: step', () => {
		const series = loaded();
		const event: TraceEvent = { seq: 1, type: 'tool_call', key: null, payload: { kind: 'step' } };
		expect(advanceSeries(series, event, t)).toBe(series);
	});

	it('folds the first live step into the already-loaded running minute, length unchanged', () => {
		const series = advanceSeries(loaded(), stepEvent(1, { tokensIn: 10, tokensOut: 2 }), t);
		expect(series.points).toEqual([
			zeroPoint('2026-10-08T16:40:00Z'),
			zeroPoint('2026-10-08T16:41:00Z'),
			{ minute: '2026-10-08T16:42:00Z', steps: 1, tokensIn: 10, tokensOut: 2 }
		]);
	});

	it('keeps counting within the same minute instead of opening a second point', () => {
		let series = advanceSeries(loaded(), stepEvent(1, { tokensIn: 10, tokensOut: 2 }), t);
		series = advanceSeries(
			series,
			stepEvent(2, { tokensIn: 5, tokensOut: 1 }),
			new Date('2026-10-08T16:42:40Z')
		);
		expect(series.points.at(-1)).toEqual({
			minute: '2026-10-08T16:42:00Z',
			steps: 2,
			tokensIn: 15,
			tokensOut: 3
		});
		expect(series.points).toHaveLength(3);
	});

	it('opens a new point for the next minute and slides the window, dropping the oldest point', () => {
		const series = advanceSeries(
			loaded(),
			stepEvent(1, { tokensIn: 5, tokensOut: 1 }),
			new Date('2026-10-08T16:43:05Z')
		);
		expect(series.points).toEqual([
			zeroPoint('2026-10-08T16:41:00Z'),
			zeroPoint('2026-10-08T16:42:00Z'),
			{ minute: '2026-10-08T16:43:00Z', steps: 1, tokensIn: 5, tokensOut: 1 }
		]);
	});

	it('fills a minute skipped entirely with a zero point, still sliding the window by one', () => {
		const series = advanceSeries(
			loaded(),
			stepEvent(1, { tokensIn: 5, tokensOut: 1 }),
			new Date('2026-10-08T16:44:05Z') // 16:43 never happened
		);
		expect(series.points).toEqual([
			zeroPoint('2026-10-08T16:42:00Z'),
			zeroPoint('2026-10-08T16:43:00Z'),
			{ minute: '2026-10-08T16:44:00Z', steps: 1, tokensIn: 5, tokensOut: 1 }
		]);
	});

	it('folds a step whose minute is not after the last point into the last point instead of appending out of order', () => {
		// e.g. the client clock running a little behind the server, right at a minute boundary
		const series = advanceSeries(
			loaded(),
			stepEvent(1, { tokensIn: 5, tokensOut: 1 }),
			new Date('2026-10-08T16:41:50Z') // a minute before the series' last point (16:42)
		);
		expect(series.points).toEqual([
			zeroPoint('2026-10-08T16:40:00Z'),
			zeroPoint('2026-10-08T16:41:00Z'),
			{ minute: '2026-10-08T16:42:00Z', steps: 1, tokensIn: 5, tokensOut: 1 }
		]);
	});

	it('turns the minute into a gap once one of its steps carries no token fields (an old run)', () => {
		let series = advanceSeries(loaded(), stepEvent(1), t);
		series = advanceSeries(
			series,
			stepEvent(2, { tokensIn: 10, tokensOut: 2 }),
			new Date('2026-10-08T16:42:40Z')
		);
		expect(series.points.at(-1)).toEqual({ minute: '2026-10-08T16:42:00Z', steps: 2 });
	});

	it('keeps a minute a gap even once a later step in it does carry tokens', () => {
		let series = advanceSeries(loaded(), stepEvent(1), t); // no tokens: the earlier step in the minute lacked them
		series = advanceSeries(
			series,
			stepEvent(2, { tokensIn: 10, tokensOut: 2 }),
			new Date('2026-10-08T16:42:40Z')
		);
		expect(series.points.at(-1)!.tokensIn).toBeUndefined();
	});

	it('treats a step with only one of the two token fields as having neither, never producing NaN', () => {
		const series = advanceSeries(loaded(), stepEvent(1, { tokensIn: 10 }), t);
		const point = series.points.at(-1)!;
		expect(point.tokensIn).toBeUndefined();
		expect(point.tokensOut).toBeUndefined();
	});
});

describe('stepsSeriesText', () => {
	it('sums the steps and reads a rising trend when the second half outweighs the first', () => {
		const points = [
			{ minute: 'a', steps: 1 },
			{ minute: 'b', steps: 2 },
			{ minute: 'c', steps: 4 },
			{ minute: 'd', steps: 5 }
		];
		expect(stepsSeriesText(points, 30)).toBe('12 Schritte in 30 min, steigend');
	});

	it('reads a falling trend when the second half has fewer steps', () => {
		const points = [
			{ minute: 'a', steps: 5 },
			{ minute: 'b', steps: 1 }
		];
		expect(stepsSeriesText(points, 30)).toBe('6 Schritte in 30 min, fallend');
	});

	it('reads a steady trend when both halves are equal', () => {
		const points = [
			{ minute: 'a', steps: 2 },
			{ minute: 'b', steps: 2 }
		];
		expect(stepsSeriesText(points, 30)).toBe('4 Schritte in 30 min, gleichbleibend');
	});
});

describe('tokensSeriesText', () => {
	it('announces a gap instead of a 0 total when no minute has token data (an old run)', () => {
		const points = [
			{ minute: 'a', steps: 3 },
			{ minute: 'b', steps: 2 }
		];
		expect(tokensSeriesText(points, 30)).toBe(
			'Keine Token-Daten für die letzten 30 min (alter Run ohne Aufzeichnung).'
		);
	});

	it('sums the known minutes and notes the gap when only part of the window has token data', () => {
		const points = [
			{ minute: 'a', steps: 3 },
			{ minute: 'b', steps: 2, tokensIn: 100, tokensOut: 20 }
		];
		expect(tokensSeriesText(points, 30)).toBe(
			'120 Tokens in 30 min, gleichbleibend (Teil des Zeitraums ohne Token-Daten)'
		);
	});

	it('sums every minute with no gap note once the whole window has token data', () => {
		const points = [
			{ minute: 'a', steps: 1, tokensIn: 50, tokensOut: 10 },
			{ minute: 'b', steps: 1, tokensIn: 150, tokensOut: 30 }
		];
		expect(tokensSeriesText(points, 30)).toBe('240 Tokens in 30 min, steigend');
	});
});
