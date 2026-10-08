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

const empty: RunSeries = { runId: 1, points: [] };

describe('minuteKey', () => {
	it('truncates a timestamp to the start of its minute, in UTC', () => {
		expect(minuteKey(new Date('2026-10-08T16:42:59.999Z'))).toBe('2026-10-08T16:42:00Z');
	});
});

describe('advanceSeries', () => {
	const t = new Date('2026-10-08T16:42:10Z');

	it('ignores a log event that is not a step (e.g. a model-loading notice)', () => {
		const event: TraceEvent = { seq: 1, type: 'log', key: null, payload: { kind: 'phase' } };
		expect(advanceSeries(empty, event, t)).toBe(empty);
	});

	it('ignores a non-log event even if its payload happens to carry kind: step', () => {
		const event: TraceEvent = { seq: 1, type: 'tool_call', key: null, payload: { kind: 'step' } };
		expect(advanceSeries(empty, event, t)).toBe(empty);
	});

	it('opens the running minute on the first step, with its tokens', () => {
		const series = advanceSeries(empty, stepEvent(1, { tokensIn: 10, tokensOut: 2 }), t);
		expect(series.points).toEqual([
			{ minute: '2026-10-08T16:42:00Z', steps: 1, tokensIn: 10, tokensOut: 2 }
		]);
	});

	it('keeps counting within the same minute instead of opening a second point', () => {
		let series = advanceSeries(empty, stepEvent(1, { tokensIn: 10, tokensOut: 2 }), t);
		series = advanceSeries(
			series,
			stepEvent(2, { tokensIn: 5, tokensOut: 1 }),
			new Date('2026-10-08T16:42:40Z')
		);
		expect(series.points).toEqual([
			{ minute: '2026-10-08T16:42:00Z', steps: 2, tokensIn: 15, tokensOut: 3 }
		]);
	});

	it('starts a new point once the minute rolls over', () => {
		let series = advanceSeries(empty, stepEvent(1, { tokensIn: 10, tokensOut: 2 }), t);
		series = advanceSeries(
			series,
			stepEvent(2, { tokensIn: 5, tokensOut: 1 }),
			new Date('2026-10-08T16:43:05Z')
		);
		expect(series.points).toEqual([
			{ minute: '2026-10-08T16:42:00Z', steps: 1, tokensIn: 10, tokensOut: 2 },
			{ minute: '2026-10-08T16:43:00Z', steps: 1, tokensIn: 5, tokensOut: 1 }
		]);
	});

	it('turns the minute into a gap once one of its steps carries no token fields (an old run)', () => {
		let series = advanceSeries(empty, stepEvent(1, { tokensIn: 10, tokensOut: 2 }), t);
		series = advanceSeries(series, stepEvent(2), new Date('2026-10-08T16:42:40Z'));
		expect(series.points).toEqual([{ minute: '2026-10-08T16:42:00Z', steps: 2 }]);
	});

	it('keeps a minute a gap even once a later step in it does carry tokens', () => {
		let series = advanceSeries(empty, stepEvent(1), t); // no tokens: the earlier step in the minute lacked them
		series = advanceSeries(
			series,
			stepEvent(2, { tokensIn: 10, tokensOut: 2 }),
			new Date('2026-10-08T16:42:40Z')
		);
		expect(series.points).toEqual([{ minute: '2026-10-08T16:42:00Z', steps: 2 }]);
		expect(series.points[0].tokensIn).toBeUndefined();
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
