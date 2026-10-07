import { describe, expect, it } from 'vitest';
import {
	detectStagnation,
	recoveryHint,
	type CallRecord,
	type StallCause,
	type StepRecord
} from './loop-guard';

const step = (number: number, calls: CallRecord[], more: Partial<StepRecord> = {}): StepRecord => ({
	step: number,
	finishReason: calls.length ? 'tool-calls' : 'stop',
	calls,
	...more
});
const failed = (target: string, tool = 'edit'): CallRecord => ({
	tool,
	target,
	isError: true,
	progress: false
});
const read = (target: string, tool = 'read'): CallRecord => ({
	tool,
	target,
	isError: false,
	progress: false
});
const wrote = (target: string): CallRecord => ({
	tool: 'write',
	target,
	isError: false,
	progress: true
});
const thought = (number: number, reasoningTokens: number) =>
	step(number, [read(`file-${number}`)], { reasoningTokens });
const budget = { reasoningBudget: 1000 };

describe('detectStagnation', () => {
	it('finds nothing while the run makes headway', () => {
		const records = [
			step(1, [read('src/a.ts'), read('src/b.ts')]),
			step(2, [failed('src/a.ts'), wrote('src/a.ts')]),
			step(3, [], { finishReason: 'stop', reasoningTokens: 400 })
		];

		expect(detectStagnation(records, budget)).toBeUndefined();
	});

	it('reports a step that hit the output limit as length_stop, so the step never counts as finished', () => {
		const records = [
			step(1, [read('src/a.ts')]),
			step(2, [], { finishReason: 'length', reasoningTokens: 31_800 })
		];

		expect(detectStagnation(records, {})).toEqual({
			kind: 'length_stop',
			cause: 'length_stop',
			reason: 'Step 2 hit the output limit before it finished.',
			stepTokens: 31_800
		});
	});

	describe('stagnation (a): failed calls', () => {
		it('reports 3 failed calls in a row on the same target, also across steps', () => {
			const records = [
				step(1, [read('src/a.ts'), failed('src/a.ts')]),
				step(2, [failed('src/a.ts'), failed('src/a.ts')])
			];

			expect(detectStagnation(records, {})).toEqual({
				kind: 'stagnation',
				cause: 'failing_calls',
				reason: '3 failed calls in a row on "src/a.ts".'
			});
		});

		it('lets two failures pass, and a success or another target ends the row', () => {
			const records = [
				step(1, [failed('src/a.ts'), failed('src/a.ts'), read('src/a.ts')]),
				step(2, [failed('src/a.ts'), failed('src/b.ts'), failed('src/a.ts')])
			];

			expect(detectStagnation(records, {})).toBeUndefined();
		});

		it('takes the tool as the target of calls that name none', () => {
			const moves = [
				failed('', 'move_ticket'),
				failed('', 'move_ticket'),
				failed('', 'move_ticket')
			];

			expect(detectStagnation([step(1, moves)], {})?.reason).toBe(
				'3 failed calls in a row on "move_ticket".'
			);
		});
	});

	describe('stagnation (b): calls without progress', () => {
		const inspections = (count: number) =>
			Array.from({ length: count }, (_, i) => read('src/parser.ts', i % 2 ? 'grep' : 'read'));

		it('reports 6 calls in a row on the same target without progress, whatever tools they use', () => {
			const records = [step(1, inspections(4)), step(2, inspections(2))];

			expect(detectStagnation(records, {})).toEqual({
				kind: 'stagnation',
				cause: 'no_progress',
				reason: '6 calls in a row on "src/parser.ts" without progress.'
			});
		});

		it('lets 5 calls pass, and a successful change ends the row', () => {
			const records = [
				step(1, [...inspections(5), wrote('src/parser.ts')]),
				step(2, inspections(5))
			];

			expect(detectStagnation(records, {})).toBeUndefined();
		});

		it('does not count a failed change as progress', () => {
			const failedWrite: CallRecord = { ...wrote('src/parser.ts'), isError: true, progress: false };
			const records = [
				step(1, [...inspections(3), failedWrite, read('src/parser.ts')]),
				step(2, [read('src/parser.ts')])
			];

			expect(detectStagnation(records, {})?.cause).toBe('no_progress');
		});
	});

	describe('stagnation (c): steps at the reasoning budget', () => {
		it('reports 3 steps in a row that thought up to 95 % of the reasoning budget', () => {
			const records = [thought(1, 950), thought(2, 1000), thought(3, 980)];

			expect(detectStagnation(records, budget)).toEqual({
				kind: 'stagnation',
				cause: 'reasoning_budget',
				reason:
					'3 steps in a row ended at the reasoning budget of 1000 tokens or the output limit.',
				stepTokens: 980
			});
		});

		it('lets a step below 95 % of the budget end the row', () => {
			const records = [thought(1, 1000), thought(2, 949), thought(3, 1000), thought(4, 1000)];

			expect(detectStagnation(records, budget)).toBeUndefined();
		});

		it('counts a step at the output limit as a step at the budget and names the longer pattern', () => {
			const records = [
				thought(1, 990),
				thought(2, 990),
				step(3, [], { finishReason: 'length', reasoningTokens: 200 })
			];

			expect(detectStagnation(records, budget)?.cause).toBe('reasoning_budget');
		});

		it('leaves out rule (c) for a model without a reasoning budget', () => {
			const records = [thought(1, 30_000), thought(2, 30_000), thought(3, 30_000)];

			expect(detectStagnation(records, {})).toBeUndefined();
		});
	});
});

describe('recoveryHint', () => {
	const causes: StallCause[] = ['length_stop', 'failing_calls', 'no_progress', 'reasoning_budget'];

	it('has one fixed English hint of at most 200 characters for each cause', () => {
		const hints = causes.map(recoveryHint);

		expect(new Set(hints).size).toBe(causes.length);
		for (const hint of hints) {
			expect(hint.length).toBeGreaterThan(40);
			expect(hint.length).toBeLessThanOrEqual(200);
			expect(hint).toMatch(/^[\x20-\x7e]+$/);
		}
	});

	it('tells a run stuck on a failing edit to stop inspecting and to rewrite the block instead', () => {
		expect(recoveryHint('failing_calls')).toMatch(/do not repeat or inspect.*rewrite the block/);
	});

	it('tells a run that overthinks not to plan again but to act in a small step', () => {
		for (const cause of ['length_stop', 'reasoning_budget'] as const)
			expect(recoveryHint(cause)).toMatch(/do not re-plan.*smallest next action/);
	});
});
