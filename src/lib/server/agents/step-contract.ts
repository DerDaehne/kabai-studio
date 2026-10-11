import { exitRequirements, backStep } from '../domain/steps';
import { ROLES, type Step } from '../domain/variants';
import type { Column } from '../domain/board';

/** Steps the agent or the human works on, counted for "n of m"; backlog and done are not part of the work. */
const isCounted = (c: Column) => c.phase === 'work' || c.phase === 'acceptance';

function thenText(next: Column | undefined): string {
	if (next?.phase === 'work') return `a fresh agent works the next step, ${next.step}`;
	if (next?.phase === 'acceptance') return 'a human accepts the result';
	return 'the ticket is done';
}

/**
 * The agent's contract for the step: goal, exit conditions and what follows, with no column names or ids. The exit
 * conditions come from the same table finish_step checks. A step without an agent role has no contract.
 */
export function stepContract(step: Step, cols: Column[]): string {
	const role = ROLES[step];
	if (!role) return '';
	const counted = cols.filter(isCounted);
	const position = counted.findIndex((c) => c.step === step) + 1;
	const next = cols[cols.findIndex((c) => c.step === step) + 1];
	const back = backStep(
		step,
		cols.map((c) => c.step)
	);
	const requirements = exitRequirements(step);
	return [
		`## Step: ${step} (${position} of ${counted.length})`,
		`Goal: ${role}`,
		`Done when: ${requirements.length ? requirements.join('; ') : 'your summary says what you did and what is open'}`,
		`Then: ${thenText(next)}`,
		`Finish with finish_step: done, ${back ? `back (to ${back}), ` : ''}or blocked (your question).`
	].join('\n');
}
