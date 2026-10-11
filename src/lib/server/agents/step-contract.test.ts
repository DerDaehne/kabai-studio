import { describe, expect, it } from 'vitest';
import * as board from '../domain/board';
import type { Column } from '../domain/board';
import { migrate, openDb } from '../db';
import { EXIT_CHECKS, backStep } from '../domain/steps';
import { ROLES, STEP_LABELS, VARIANTS, type Step, type Variant } from '../domain/variants';
import { stepContract } from './step-contract';

const user = { kind: 'user' } as const;

function columnsOf(variant: Variant): Column[] {
	const db = openDb(':memory:');
	migrate(db);
	const id = board.createProject(db, user, { key: 'STU', name: 'Studio' }, variant).id;
	return board.columns(db, id);
}

const workSteps = (variant: Variant) => VARIANTS[variant].filter((step) => ROLES[step]);
const lineOf = (contract: string, label: string) =>
	contract.split('\n').find((line) => line.startsWith(`${label}: `)) ?? '';

describe('the phase contract of a step', () => {
	for (const variant of Object.keys(VARIANTS) as Variant[]) {
		it.each(workSteps(variant))(`in ${variant}: %s shows goal, done-when and then`, (step) => {
			const contract = stepContract(step, columnsOf(variant));
			expect(contract).toMatchSnapshot();
			expect(contract.split('\n').map((line) => line.split(':')[0])).toEqual([
				expect.stringMatching(/^## Step/),
				'Goal',
				'Done when',
				'Then',
				'Finish with finish_step'
			]);
		});
	}

	it('counts the position among the work and acceptance steps of the variant', () => {
		expect(stepContract('plan', columnsOf('software'))).toContain('## Step: plan (2 of 5)');
		expect(stepContract('critique', columnsOf('software'))).toContain('## Step: critique (4 of 5)');
		expect(stepContract('draft', columnsOf('knowledge'))).toContain('## Step: draft (2 of 4)');
		expect(stepContract('implement', columnsOf('direct'))).toContain('## Step: implement (1 of 3)');
	});

	it.each(Object.keys(EXIT_CHECKS))(
		'renders the done-when of %s from the exit checks finish_step runs',
		(step) => {
			const expected =
				EXIT_CHECKS[step as Step]!.map((check) => check.requires).join('; ') ||
				'your summary says what you did and what is open';
			const variant = VARIANTS.software.includes(step as Step) ? 'software' : 'knowledge';
			const contract = stepContract(step as Step, columnsOf(variant));
			expect(lineOf(contract, 'Done when')).toBe(`Done when: ${expected}`);
		}
	);

	it('names who works next: a fresh agent in work, the human at acceptance', () => {
		const cols = columnsOf('software');
		expect(lineOf(stepContract('refine', cols), 'Then')).toBe(
			'Then: a fresh agent works the next step, plan'
		);
		expect(lineOf(stepContract('critique', cols), 'Then')).toBe('Then: a human accepts the result');
	});

	it('offers back only where the variant has a step to return to', () => {
		expect(lineOf(stepContract('critique', columnsOf('software')), 'Finish with finish_step')).toBe(
			'Finish with finish_step: done, back (to implement), or blocked (your question).'
		);
		expect(lineOf(stepContract('refine', columnsOf('software')), 'Finish with finish_step')).toBe(
			'Finish with finish_step: done, or blocked (your question).'
		);
		expect(backStep('implement', VARIANTS.direct)).toBeUndefined();
		expect(backStep('implement', VARIANTS.software)).toBe('refine');
	});

	it('names no column, only the step keys', () => {
		for (const variant of Object.keys(VARIANTS) as Variant[]) {
			const cols = columnsOf(variant);
			for (const step of workSteps(variant)) {
				const contract = stepContract(step, cols);
				for (const label of Object.values(STEP_LABELS)) expect(contract).not.toContain(label);
				expect(contract).not.toMatch(/column|move_ticket|allowed move/i);
			}
		}
	});

	it('gives backlog, acceptance and done no contract', () => {
		const cols = columnsOf('software');
		for (const step of ['backlog', 'acceptance', 'done'] as const)
			expect(stepContract(step, cols)).toBe('');
	});
});
