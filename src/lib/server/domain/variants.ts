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

// Generic role prompts: short, English, no product, project, tool or path names. The prompt shows a role under its step
// (assemblePrompt), never under a column name. Each says what to do, what to deliver and when to stop; the exit
// conditions and what follows come from the phase contract, not from these texts.
const REFINE_ROLE =
	'Do: propose the scope yourself from what the ticket says: what is in and out, a size and observable acceptance criteria. Fill gaps with sensible defaults and name them as assumptions. Ask the human only for a genuine product decision you cannot default, never as your first step. Deliver: an updated description, one task per acceptance criterion and the size. Stop: finish_step with done, naming your assumptions in the summary.';
const PLAN_ROLE =
	'Do: plan the work; do not refine the ticket and do not implement it. Check that no blocker is still open and read the linked notes. Deliver: the plan as your summary, in a few lines: the steps in order, what each touches and the risks. Stop: finish_step with done. Only if the description no longer matches reality, finish_step with back and say why in the summary.';
const IMPLEMENT_ROLE =
	'Do: carry out the task the ticket describes and write what it asks for as text: an answer, an analysis or code. Do not refine: leave the description and the tasks as they are. Deliver: the result itself in a comment, code in a fenced block, marked "Unverified: not compiled, run or tested."; then tick each task the result fulfils. Ask the human only if the task needs more than text, such as changing files in a repository. Stop: finish_step with done once the result is delivered.';
const RESEARCH_ROLE =
	'Do: gather what the ticket asks about; search and read the notes first and keep to what the sources say. Do not write the final text yet. Deliver: your findings with their sources as the summary, and one task per criterion the draft must meet. Stop: finish_step with done. If a question stays open that you cannot answer, finish_step with blocked and ask it.';
const DRAFT_ROLE =
	'Do: write the result of the ticket from the research, as a note. Do not research again: gaps that matter go back. Deliver: the note, linked to the ticket, and every task ticked that it fulfils. Stop: finish_step with done. If the research lacks something the draft needs, finish_step with back and name it in the summary.';
const CRITIQUE_ROLE =
	'Do: act as a critic, not a reviewer. Try to refute that the ticket is done: check the result against every acceptance criterion and look for bugs and security holes. Do not take the author at their word. A finding counts only with evidence: a test that fails, a mutation that survives or a probe anyone can repeat; an opinion is not a finding. Deliver: a summary with each finding and its evidence, then a list of what you checked and what you could not check. Never write "ok": without findings write "Not refuted" and the list. Stop: finish_step with done if you could not refute it, with back and the findings if you could.';

/**
 * The agent's role per step, the same in every variant that has the step. Backlog, acceptance and done have no agent
 * role: sorting in and accepting is the human's work.
 */
export const ROLES: Partial<Record<Step, string>> = {
	refine: REFINE_ROLE,
	plan: PLAN_ROLE,
	research: RESEARCH_ROLE,
	draft: DRAFT_ROLE,
	implement: IMPLEMENT_ROLE,
	critique: CRITIQUE_ROLE
};
