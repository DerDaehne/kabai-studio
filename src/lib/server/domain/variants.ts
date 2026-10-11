/** Every step a column can be; `columns.step` holds one, and the database derives the phase from it. */
export type Step =
	| 'backlog'
	| 'refine'
	| 'plan'
	| 'implement'
	| 'research'
	| 'draft'
	| 'critique'
	| 'acceptance'
	| 'done';
export type Phase = 'open' | 'work' | 'acceptance' | 'done';
export type Variant = 'software' | 'knowledge' | 'direct';

/** The steps of each variant in board order; a project stores only its variant. */
export const VARIANTS: Record<Variant, readonly Step[]> = {
	software: ['backlog', 'refine', 'plan', 'implement', 'critique', 'acceptance', 'done'],
	knowledge: ['backlog', 'research', 'draft', 'critique', 'acceptance', 'done'],
	direct: ['backlog', 'implement', 'critique', 'acceptance', 'done']
};

/** The column name of each step. */
export const STEP_LABELS: Record<Step, string> = {
	backlog: 'Backlog',
	refine: 'Präzisieren',
	plan: 'Planen',
	implement: 'Umsetzen',
	research: 'Recherchieren',
	draft: 'Entwerfen',
	critique: 'Kritik',
	acceptance: 'Abnahme',
	done: 'Fertig'
};

// Generic role prompts: short, English, no product, project, tool or path names — an agent's role comes from the
// prompt's role block (assemblePrompt), built from this text, never from the column name. Each says what to do, what
// to deliver and when to stop.
const REFINE_ROLE =
	'Do: propose the scope yourself from what the ticket says: what is in and out, a rough effort and observable acceptance criteria. Fill gaps with sensible defaults and name them as assumptions. Ask the human only for a genuine product decision you cannot default, never as your first step. Deliver: an updated description and one task per acceptance criterion. Stop: move the ticket on to Ready.';
const READY_ROLE =
	'Do: pick the ticket up; do not refine it. Check that no blocker is still open. Deliver: a pickup comment with your plan in one or two sentences. Stop: move the ticket to In Arbeit right away. Only if the description no longer matches reality, send it back to Refine with a comment saying why.';
const IN_PROGRESS_ROLE =
	'Do: carry out the task the ticket describes and write what it asks for as text: an answer, an analysis or code. Do not refine: leave the description and the tasks as they are. Deliver: the result itself in a comment, code in a fenced block, marked "Unverified: not compiled, run or tested."; then tick each task the result fulfils. Ask the human only if the task needs more than text, such as changing files in a repository. Stop: move the ticket to Review once the result is delivered.';
const REVIEW_ROLE =
	'Do: check the delivered result against the acceptance criteria, not against your own taste. Deliver: a comment with one finding per unmet criterion, or a short "Review ok". Stop: with findings, send the ticket back to In Arbeit; without, approve it and move it on to Abnahme.';

/**
 * The agent's role per step, the same in every variant that has the step. Backlog, acceptance and done have no agent
 * role: sorting in and accepting is the human's work.
 *
 * ponytail: research and draft have no role text yet, so their runs get no role block; they arrive with the phase
 * contract.
 */
export const ROLES: Partial<Record<Step, string>> = {
	refine: REFINE_ROLE,
	plan: READY_ROLE,
	implement: IN_PROGRESS_ROLE,
	critique: REVIEW_ROLE
};
