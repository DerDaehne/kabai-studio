import { describe, expect, it } from 'vitest';
import { advanceSeries } from '$lib/trace/step-series';
import { liveTraceEvent } from '$lib/trace/trace';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import { appendEvent, createProfile, createRun, startRun } from './domain/runs';
import { migrate, openDb } from './db';
import { subscribe, type StudioEvent } from './events';
import { DEFAULT_WINDOW_MINUTES, STEP_MINUTES, stepSeries } from './step-series';

const user: Actor = { kind: 'user' };
const NOW = new Date('2026-10-08T17:00:00Z');

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const ticketId = board.createTicket(db, user, projectId, { title: 'T' }).id;
	const profileId = createProfile(db, user, {
		name: 'P',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const running = () => {
		const id = createRun(db, user, { ticketId, profileId }).id;
		startRun(db, user, id);
		return id;
	};
	const step = (runId: number, at: string, payload: Record<string, unknown> = {}) => {
		const agent: Actor = { kind: 'agent', runId };
		const { seq } = appendEvent(db, agent, runId, {
			type: 'log',
			payload: { kind: 'step', ...payload }
		});
		db.prepare('UPDATE run_events SET created_at = ? WHERE run_id = ? AND seq = ?').run(
			at,
			runId,
			seq
		);
	};
	return { db, running, step };
}

describe('stepSeries', () => {
	it('leaves a minute without any step as a real zero, not a gap', () => {
		const { db, running, step } = setup();
		const runId = running();
		step(runId, '2026-10-08 16:58:00', { tokensIn: 10, tokensOut: 2 });
		// 16:59 has no step at all
		step(runId, '2026-10-08 17:00:00', { tokensIn: 5, tokensOut: 1 });

		const [series] = stepSeries(db, [runId], 3, NOW);
		expect(series.points).toEqual([
			{ minute: '2026-10-08T16:58:00Z', steps: 1, tokensIn: 10, tokensOut: 2 },
			{ minute: '2026-10-08T16:59:00Z', steps: 0, tokensIn: 0, tokensOut: 0 },
			{ minute: '2026-10-08T17:00:00Z', steps: 1, tokensIn: 5, tokensOut: 1 }
		]);
	});

	it('returns every minute empty for a run with no events at all', () => {
		const { db, running } = setup();
		const runId = running();
		const [series] = stepSeries(db, [runId], 2, NOW);
		expect(series.points).toEqual([
			{ minute: '2026-10-08T16:59:00Z', steps: 0, tokensIn: 0, tokensOut: 0 },
			{ minute: '2026-10-08T17:00:00Z', steps: 0, tokensIn: 0, tokensOut: 0 }
		]);
	});

	it('keeps two steps a second apart in the same minute bucket and splits one a second later into the next', () => {
		const { db, running, step } = setup();
		const runId = running();
		step(runId, '2026-10-08 16:59:58');
		step(runId, '2026-10-08 16:59:59');
		step(runId, '2026-10-08 17:00:00');

		const [series] = stepSeries(db, [runId], 2, NOW);
		expect(series.points.map((p) => [p.minute, p.steps])).toEqual([
			['2026-10-08T16:59:00Z', 2],
			['2026-10-08T17:00:00Z', 1]
		]);
	});

	it('sums the tokens of every step within one minute', () => {
		const { db, running, step } = setup();
		const runId = running();
		step(runId, '2026-10-08 17:00:00', { tokensIn: 100, tokensOut: 20 });
		step(runId, '2026-10-08 17:00:30', { tokensIn: 50, tokensOut: 5 });

		const [series] = stepSeries(db, [runId], 1, NOW);
		expect(series.points).toEqual([
			{ minute: '2026-10-08T17:00:00Z', steps: 2, tokensIn: 150, tokensOut: 25 }
		]);
	});

	it('gives an old run (step logged with no token fields) a gap instead of a 0 for tokens', () => {
		const { db, running, step } = setup();
		const runId = running();
		step(runId, '2026-10-08 17:00:00'); // no tokensIn/tokensOut, as an old step-log payload had none

		const [series] = stepSeries(db, [runId], 1, NOW);
		expect(series.points).toEqual([{ minute: '2026-10-08T17:00:00Z', steps: 1 }]);
		expect(series.points[0].tokensIn).toBeUndefined();
	});

	it('does not confuse a tool_call or a non-step log with a step', () => {
		const { db, running, step } = setup();
		const runId = running();
		const at = (seq: number, when: string) =>
			db
				.prepare('UPDATE run_events SET created_at = ? WHERE run_id = ? AND seq = ?')
				.run(when, runId, seq);
		const agent: Actor = { kind: 'agent', runId };
		// pinned into the same minute as the real step below, so a broken kind/type filter would inflate it
		at(
			appendEvent(db, agent, runId, { type: 'log', payload: { kind: 'prompt' } }).seq,
			'2026-10-08 17:00:10'
		);
		at(
			appendEvent(db, agent, runId, {
				type: 'tool_call',
				payload: { step: 1, tool: 'x', args: {} }
			}).seq,
			'2026-10-08 17:00:20'
		);
		step(runId, '2026-10-08 17:00:00', { tokensIn: 1, tokensOut: 1 });

		const [series] = stepSeries(db, [runId], 1, NOW);
		expect(series.points).toEqual([
			{ minute: '2026-10-08T17:00:00Z', steps: 1, tokensIn: 1, tokensOut: 1 }
		]);
	});

	it('answers one run per id, each with its own series', () => {
		const { db, running, step } = setup();
		const a = running();
		const b = running();
		step(a, '2026-10-08 17:00:00', { tokensIn: 1, tokensOut: 1 });
		step(b, '2026-10-08 17:00:00', { tokensIn: 2, tokensOut: 2 });

		const series = stepSeries(db, [a, b], 1, NOW);
		expect(series.map((s) => s.runId)).toEqual([a, b]);
		expect(series[0].points[0].tokensIn).toBe(1);
		expect(series[1].points[0].tokensIn).toBe(2);
	});

	it('returns no runs for an empty id list without touching the database', () => {
		const { db } = setup();
		expect(stepSeries(db, [], DEFAULT_WINDOW_MINUTES, NOW)).toEqual([]);
	});

	it('counts only log events as steps, even when another event type carries kind: step', () => {
		const { db, running, step } = setup();
		const runId = running();
		const agent: Actor = { kind: 'agent', runId };
		const { seq } = appendEvent(db, agent, runId, {
			type: 'intervention',
			payload: { kind: 'step' }
		});
		db.prepare('UPDATE run_events SET created_at = ? WHERE run_id = ? AND seq = ?').run(
			'2026-10-08 17:00:20',
			runId,
			seq
		);
		step(runId, '2026-10-08 17:00:00', { tokensIn: 1, tokensOut: 1 });

		const [series] = stepSeries(db, [runId], 1, NOW);
		expect(series.points).toEqual([
			{ minute: '2026-10-08T17:00:00Z', steps: 1, tokensIn: 1, tokensOut: 1 }
		]);
	});

	it('rejects a window smaller than one minute instead of building an empty, unusable grid', () => {
		const { db } = setup();
		expect(() => stepSeries(db, [1], 0)).toThrow(/windowMinutes/);
		expect(() => stepSeries(db, [1], -5)).toThrow(/windowMinutes/);
	});
});

describe('advanceSeries matches a reload', () => {
	function liveSetup() {
		const { db, running, step } = setup();
		const runId = running();
		const live: StudioEvent[] = [];
		const off = subscribe((e) => {
			if (e.type === 'run.event') live.push(e);
		});
		const liveStep = (at: string, payload: Record<string, unknown>) => {
			step(runId, at, payload);
			return liveTraceEvent(live.at(-1)!);
		};
		return { db, runId, liveStep, off };
	}

	it('a tab that loaded earlier and followed live steps shows the same series as a fresh reload', () => {
		const { db, runId, liveStep, off } = liveSetup();
		liveStep('2026-10-08 16:59:10', { tokensIn: 10, tokensOut: 1 });
		const [loaded] = stepSeries(db, [runId], 30, new Date('2026-10-08T17:00:30Z'));

		const event = liveStep('2026-10-08 17:02:10', { tokensIn: 5, tokensOut: 1 });
		const followed = advanceSeries(loaded, event, new Date('2026-10-08T17:02:10Z'));

		const [reloaded] = stepSeries(db, [runId], 30, new Date('2026-10-08T17:02:40Z'));
		off();
		expect(followed).toEqual(reloaded);
	});

	it('a live step received a moment before the last server minute (client clock behind) stays in order and does not grow the window', () => {
		const { db, runId, liveStep, off } = liveSetup();
		const [loaded] = stepSeries(db, [runId], 30, new Date('2026-10-08T17:00:00.200Z'));
		const event = liveStep('2026-10-08 17:00:00', { tokensIn: 5, tokensOut: 1 });
		const followed = advanceSeries(loaded, event, new Date('2026-10-08T16:59:59.500Z'));
		off();

		const minutes = followed.points.map((p) => p.minute);
		expect(minutes).toEqual([...new Set(minutes)].sort());
		expect(followed.points).toHaveLength(30);
	});
});

describe('query plan', () => {
	it('never scans the whole run_events table: it seeks the primary key once per run id', () => {
		const { db, running, step } = setup();
		const runId = running();
		step(runId, '2026-10-08 17:00:00', { tokensIn: 1, tokensOut: 1 });

		const plan = db
			.prepare(`EXPLAIN QUERY PLAN ${STEP_MINUTES}`)
			.all(JSON.stringify([runId]), '2026-10-08 16:30:00') as { detail: string }[];
		const detail = plan.map((p) => p.detail).join(' | ');
		expect(detail).toContain('run_events');
		expect(detail).not.toMatch(/SCAN run_events/);
	});
});
