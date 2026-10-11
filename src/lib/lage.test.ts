import { describe, expect, it } from 'vitest';
import { lageOf, progressOf, type LageInput, type LagePhase, type LageRun } from './lage';

const base: LageInput = {
	phase: 'work',
	run: null,
	openQuestions: 0,
	pendingApproval: false,
	openProposals: 0,
	openPredecessors: [],
	autoAccepted: false,
	capacity: null
};
const lage = (input: Partial<LageInput>) => lageOf({ ...base, ...input });

describe('lageOf, row by row', () => {
	it('puts a ticket in a done column under „Fertig“, marked when it was accepted automatically', () => {
		expect(lage({ phase: 'done' })).toEqual({ lage: 'done', reason: { kind: 'done' } });
		expect(lage({ phase: 'done', autoAccepted: true }).reason).toEqual({ kind: 'auto_accepted' });
	});

	it('makes an open question a „Wartet auf dich“ of kind question', () => {
		expect(lage({ openQuestions: 1 })).toEqual({ lage: 'waiting', reason: { kind: 'question' } });
	});

	it('makes a run that waits for a tool approval a „Wartet auf dich“ of kind approval', () => {
		expect(lage({ pendingApproval: true })).toEqual({
			lage: 'waiting',
			reason: { kind: 'approval' }
		});
	});

	it('makes an open proposal a „Wartet auf dich“ of kind proposal', () => {
		expect(lage({ openProposals: 2 })).toEqual({ lage: 'waiting', reason: { kind: 'proposal' } });
	});

	it('makes a failed newest run a „Wartet auf dich“ of kind failure', () => {
		expect(lage({ run: 'failed' })).toEqual({ lage: 'waiting', reason: { kind: 'failure' } });
	});

	it('puts a ticket in an acceptance column under „Zur Abnahme“', () => {
		expect(lage({ phase: 'acceptance' })).toEqual({
			lage: 'acceptance',
			reason: { kind: 'acceptance' }
		});
	});

	it('puts a ticket with a running run under „In Arbeit“', () => {
		expect(lage({ run: 'running' })).toEqual({ lage: 'working', reason: { kind: 'working' } });
	});

	it('puts every other ticket under „Offen“', () => {
		expect(lage({}).lage).toBe('open');
	});
});

describe('lageOf, precedence', () => {
	it('ranks „Fertig“ before everything else', () => {
		const all = { openQuestions: 1, pendingApproval: true, run: 'failed' as const };
		expect(lage({ phase: 'done', ...all }).lage).toBe('done');
	});

	it('ranks an open question before the acceptance of the ticket', () => {
		expect(lage({ phase: 'acceptance', openQuestions: 1 }).reason).toEqual({ kind: 'question' });
	});

	it('ranks a tool approval before „In Arbeit“', () => {
		expect(lage({ run: 'running', pendingApproval: true })).toEqual({
			lage: 'waiting',
			reason: { kind: 'approval' }
		});
	});

	it('ranks question, approval, proposal and failure in that order', () => {
		const all = {
			openQuestions: 1,
			pendingApproval: true,
			openProposals: 1,
			run: 'failed' as const
		};
		expect(lage(all).reason.kind).toBe('question');
		expect(lage({ ...all, openQuestions: 0 }).reason.kind).toBe('approval');
		expect(lage({ ...all, openQuestions: 0, pendingApproval: false }).reason.kind).toBe('proposal');
		expect(
			lage({ ...all, openQuestions: 0, pendingApproval: false, openProposals: 0 }).reason.kind
		).toBe('failure');
	});

	it('ranks a failed run before the acceptance of the ticket', () => {
		expect(lage({ phase: 'acceptance', run: 'failed' }).lage).toBe('waiting');
	});

	it('ranks a running run before open predecessors', () => {
		expect(lage({ run: 'running', openPredecessors: ['STU-1'] }).lage).toBe('working');
	});
});

describe('the reason a ticket is „Offen“', () => {
	it('names the open predecessors by ref, before anything else', () => {
		expect(
			lage({ run: 'queued', capacity: [{ code: 'claim' }], openPredecessors: ['STU-1', 'STU-2'] })
				.reason
		).toEqual({
			kind: 'predecessors',
			refs: ['STU-1', 'STU-2']
		});
	});

	it('takes the capacity causes of a queued run from the read model', () => {
		const causes = [{ code: 'ahead' as const, count: 2 }];
		expect(lage({ run: 'queued', capacity: causes }).reason).toEqual({ kind: 'capacity', causes });
	});

	it('says paused for a run the human halted', () => {
		expect(lage({ run: 'paused' }).reason).toEqual({ kind: 'paused' });
	});

	it('says not prioritized for a ticket in an open phase', () => {
		expect(lage({ phase: 'open' }).reason).toEqual({ kind: 'not_prioritized' });
	});

	it('says ready for a work step without a run', () => {
		expect(lage({ phase: 'work' }).reason).toEqual({ kind: 'ready' });
	});
});

describe('progressOf', () => {
	const software = ['backlog', 'refine', 'plan', 'implement', 'critique', 'acceptance', 'done'];
	const knowledge = ['backlog', 'research', 'draft', 'critique', 'acceptance', 'done'];
	const direct = ['backlog', 'implement', 'critique', 'acceptance', 'done'];

	it('counts the work and acceptance steps of the variant, without backlog and done', () => {
		expect(progressOf(software, 'implement')).toEqual({ index: 3, total: 5 });
		expect(progressOf(knowledge, 'draft')).toEqual({ index: 2, total: 4 });
		expect(progressOf(direct, 'acceptance')).toEqual({ index: 3, total: 3 });
	});

	it('is at the start in backlog and complete in done', () => {
		expect(progressOf(software, 'backlog')).toEqual({ index: 0, total: 5 });
		expect(progressOf(direct, 'done')).toEqual({ index: 3, total: 3 });
	});
});

describe('every combination of inputs', () => {
	const phases: LagePhase[] = ['open', 'work', 'acceptance', 'done'];
	const runs: (LageRun | null)[] = [null, 'queued', 'running', 'paused', 'failed'];
	const flags = [false, true];

	const crossed = <T>(axes: T[][]): T[][] =>
		axes.reduce<T[][]>((rows, axis) => rows.flatMap((row) => axis.map((v) => [...row, v])), [[]]);

	function inputs(): LageInput[] {
		const axes = [phases, runs, [0, 1], flags, [0, 1], [[], ['STU-1']], flags] as unknown[][];
		return crossed(axes).map(
			([phase, run, openQuestions, pendingApproval, openProposals, refs, autoAccepted]) => ({
				phase: phase as LagePhase,
				run: run as LageRun | null,
				openQuestions: openQuestions as number,
				pendingApproval: pendingApproval as boolean,
				openProposals: openProposals as number,
				openPredecessors: refs as string[],
				autoAccepted: autoAccepted as boolean,
				capacity: run === 'queued' ? [{ code: 'claim' }] : null
			})
		);
	}

	it('gives „Offen“ a reason that says something and „Wartet auf dich“ a kind, never empty', () => {
		let seen = 0;
		for (const input of inputs()) {
			const { lage: result, reason } = lageOf(input);
			expect(reason.kind).toBeTruthy();
			if (reason.kind === 'predecessors') expect(reason.refs.length).toBeGreaterThan(0);
			if (reason.kind === 'capacity') expect(reason.causes.length).toBeGreaterThan(0);
			if (result === 'open')
				expect(['predecessors', 'capacity', 'paused', 'not_prioritized', 'ready']).toContain(
					reason.kind
				);
			if (result === 'waiting')
				expect(['question', 'approval', 'proposal', 'failure']).toContain(reason.kind);
			seen++;
		}
		expect(seen).toBe(4 * 5 * 2 * 2 * 2 * 2 * 2);
	});

	it('is never „Offen“ or „In Arbeit“ while a question is open', () => {
		for (const input of inputs()) {
			if (input.openQuestions > 0 && input.phase !== 'done')
				expect(lageOf(input).lage).toBe('waiting');
		}
	});
});
