import type { DatabaseSync } from 'node:sqlite';
import {
	appendComment,
	blockingPredecessors,
	columns,
	hasLinkedNote,
	ticket,
	writeApproval,
	writeMove,
	type Column,
	type Ticket
} from './board';
import { DomainError, OPEN_QUESTION, tx, type Actor } from './core';
import { requestHuman, type QuestionOption } from './questions';
import { createRun, pendingRun } from './runs';
import type { Step } from './variants';

export type StepResult = 'done' | 'back' | 'blocked';
/** Where the ticket stands after a finished step: `run` = a fresh run works the next step, `human` = it waits for the human. */
export type StepOutcome = { next: Step; then: 'run' | 'human'; question_id?: number };

type Unmet = { missing: string; hint: string };
/** One exit condition: `requires` is the line the prompt shows as "Done when", `unmet` the check finish_step runs. */
type ExitCheck = { requires: string; unmet: (db: DatabaseSync, t: Ticket) => Unmet | undefined };

const ticketText = (db: DatabaseSync, t: Ticket) =>
	db.prepare('SELECT description, size FROM tickets WHERE id = ?').get(t.id) as {
		description: string;
		size: string | null;
	};

const taskCount = (db: DatabaseSync, t: Ticket) =>
	(db.prepare('SELECT count(*) AS n FROM tasks WHERE ticket_id = ?').get(t.id) as { n: number }).n;

const openAgentTaskIds = (db: DatabaseSync, t: Ticket) =>
	db
		.prepare(
			"SELECT id FROM tasks WHERE ticket_id = ? AND owner = 'agent' AND done_at IS NULL ORDER BY position, id"
		)
		.all(t.id)
		.map((r) => r.id as number);

const hasTasks: ExitCheck = {
	requires: 'the ticket has at least one task, one per acceptance criterion',
	unmet: (db, t) =>
		taskCount(db, t) > 0
			? undefined
			: { missing: 'keine Tasks', hint: 'add_tasks mit einem Task je Akzeptanzkriterium' }
};

const hasSize: ExitCheck = {
	requires: 'the ticket has a size (XS, S, M, L or XL)',
	unmet: (db, t) =>
		ticketText(db, t).size
			? undefined
			: { missing: 'keine Größe', hint: 'update_ticket mit size (XS, S, M, L oder XL)' }
};

const hasDescription: ExitCheck = {
	requires: 'the description is not empty',
	unmet: (db, t) =>
		ticketText(db, t).description.trim()
			? undefined
			: { missing: 'keine Beschreibung', hint: 'update_ticket mit description' }
};

const agentTasksDone: ExitCheck = {
	requires: 'all tasks are ticked',
	unmet: (db, t) => {
		const open = openAgentTaskIds(db, t);
		if (!open.length) return undefined;
		return {
			missing: `offene Tasks ${open.join(', ')}`,
			hint: `complete_tasks mit task_ids [${open.join(', ')}]; einen Task, den du nicht erfüllen kannst, meldest du mit finish_step result blocked`
		};
	}
};

const unmetLinkedNote = (db: DatabaseSync, t: Ticket) =>
	hasLinkedNote(db, t.id)
		? undefined
		: { missing: 'keine verknüpfte Note', hint: 'notes_create, dann link_note_to_ticket' };

const linkedNote: ExitCheck = {
	requires: 'a note is linked to the ticket (notes_create, then link_note_to_ticket)',
	unmet: unmetLinkedNote
};

const linkedNoteIfRequired: ExitCheck = {
	requires: 'if the ticket requires documentation, a note is linked to it',
	unmet: (db, t) => (t.docs_required ? unmetLinkedNote(db, t) : undefined)
};

/** The exit conditions of each work step: finish_step with done passes only when none of them is unmet. */
export const EXIT_CHECKS: Partial<Record<Step, ExitCheck[]>> = {
	refine: [hasTasks, hasSize, hasDescription],
	plan: [],
	implement: [agentTasksDone, linkedNoteIfRequired],
	research: [hasTasks],
	draft: [agentTasksDone, linkedNote],
	critique: []
};

/** The "Done when" lines of a step, rendered from the checks finish_step runs. */
export const exitRequirements = (step: Step): string[] =>
	(EXIT_CHECKS[step] ?? []).map((check) => check.requires);

/** Where back leads from steps other than critique, which always returns to the step before it. */
const BACK_TO: Partial<Record<Step, Step>> = {
	plan: 'refine',
	implement: 'refine',
	draft: 'research'
};

/** The step finish_step with back returns to, or undefined if the step in this list of steps has none. */
export function backStep(step: Step, steps: readonly Step[]): Step | undefined {
	const target = step === 'critique' ? steps[steps.indexOf(step) - 1] : BACK_TO[step];
	return target !== undefined && steps.includes(target) ? target : undefined;
}

/**
 * Ends the step of the calling run in one transaction: checks the exit conditions (done), writes the summary as the
 * run's handoff, moves the ticket on or back, and in critique approves (done) or returns the findings (back). blocked
 * turns the summary into a question and leaves the ticket where it is. A repeat after the step has ended writes nothing
 * and reports where the ticket stands.
 */
export function finishStep(
	db: DatabaseSync,
	actor: Actor,
	ticketId: number,
	input: { result: StepResult; summary: string }
): StepOutcome {
	return tx(db, (emit) => {
		const t = ticket(db, ticketId);
		const runColumn = runColumnOf(db, actor);
		if (runColumn === null) throw stepNotCurrent(t);
		if (t.column_id !== runColumn) return outcomeOf(t.column_step, t.column_phase);
		assertFinishable(t, input.summary);
		if (input.result === 'blocked') return block(db, actor, t, { question: input.summary });
		if (input.result === 'back' && t.column_step === 'critique' && roundsUsedUp(db, t))
			return block(db, actor, t, disputeQuestion(db, t, input.summary));
		const cols = columns(db, t.project_id);
		const to = input.result === 'done' ? nextColumn(db, t, cols) : backColumn(t, cols);
		if (input.result === 'done' && t.column_step === 'critique') writeApproval(db, emit, actor, t);
		appendComment(db, emit, actor, t, input.summary);
		writeMove(db, emit, actor, t, to, cols);
		recordStepResult(db, actor, input.result);
		return outcomeOf(to.step, to.phase);
	});
}

const recordStepResult = (db: DatabaseSync, actor: Actor, result: StepResult) =>
	db.prepare('UPDATE runs SET step_result = ? WHERE id = ?').run(result, actor.runId!);

/**
 * The chain: after a run finished its step with done or back, queues the run for the work step the ticket is in now,
 * with the same profile and a fresh context. Nothing is queued once the ticket left the work phase, while it has an
 * open question, while another run of it is active or waiting, or while an open `blocks` predecessor stands before it.
 */
export function queueNextStep(db: DatabaseSync, runId: number): { id: number } | undefined {
	return tx(db, () => {
		const run = db
			.prepare('SELECT ticket_id, agent_profile_id, step_result FROM runs WHERE id = ?')
			.get(runId) as FinishedRun | undefined;
		if (!run || run.agent_profile_id === null) return undefined;
		if (run.step_result !== 'done' && run.step_result !== 'back') return undefined;
		const t = ticket(db, run.ticket_id);
		if (
			t.column_phase !== 'work' ||
			hasOpenQuestion(db, t.id) ||
			pendingRun(db, t.id) ||
			blockingPredecessors(db, t.id).length > 0
		)
			return undefined;
		const actor: Actor = { kind: 'system', runId };
		return createRun(db, actor, {
			ticketId: t.id,
			profileId: run.agent_profile_id,
			trigger: 'on_enter'
		});
	});
}

type FinishedRun = {
	ticket_id: number;
	agent_profile_id: number | null;
	step_result: StepResult | null;
};

export const hasOpenQuestion = (db: DatabaseSync, ticketId: number) =>
	db
		.prepare(`SELECT 1 FROM questions q WHERE q.ticket_id = ? AND ${OPEN_QUESTION}`)
		.get(ticketId) !== undefined;

const outcomeOf = (step: Step, phase: Column['phase']): StepOutcome => ({
	next: step,
	then: phase === 'work' ? 'run' : 'human'
});

/** The column the run was started for: its step ends with finish_step, so a later one is a repeat. */
function runColumnOf(db: DatabaseSync, actor: Actor): number | null {
	if (actor.runId === undefined)
		throw new DomainError(
			'requires_run',
			'Einen Schritt beendet nur der Run, der ihn bearbeitet.',
			'Der Mensch verschiebt das Ticket mit moveTicket.'
		);
	const run = db.prepare('SELECT column_id FROM runs WHERE id = ?').get(actor.runId) as
		{ column_id: number | null } | undefined;
	return run?.column_id ?? null;
}

/** A run whose column is gone has no step to finish; the summary is not saved, so the error says so. */
const stepNotCurrent = (t: Ticket) =>
	new DomainError(
		'step_not_current',
		`Der Schritt dieses Runs existiert nicht mehr; ${t.ref} liegt jetzt in „${t.column_name}“. Deine summary wurde nicht gespeichert.`,
		`Beende deinen Zug; das Ticket liegt im Schritt „${t.column_name}“.`
	);

function assertFinishable(t: Ticket, summary: string) {
	if (t.column_phase !== 'work')
		throw new DomainError(
			'not_in_work',
			`${t.ref} liegt in „${t.column_name}“; dort gibt es keinen Schritt für Agents.`,
			'Do not call finish_step again; answer without a tool call. The human continues from here.'
		);
	if (!summary.trim())
		throw new DomainError(
			'empty_summary',
			'Die summary ist leer.',
			'Schreib in summary, was du getan hast und was offen ist; sie wird zum Handoff im Ticket.'
		);
}

/** The run's own open question stands for a blocked step already reported, so a repeat asks nothing twice. */
function block(
	db: DatabaseSync,
	actor: Actor,
	t: Ticket,
	question: { question: string; options?: QuestionOption[] }
): StepOutcome {
	const asked = db
		.prepare(
			'SELECT id FROM questions WHERE run_id = ? AND answer IS NULL ORDER BY id DESC LIMIT 1'
		)
		.get(actor.runId!) as { id: number } | undefined;
	const questionId = asked?.id ?? requestHuman(db, actor, t.id, question).id;
	recordStepResult(db, actor, 'blocked');
	return { next: t.column_step, then: 'human', question_id: questionId };
}

/** Rounds of findings the critique may send back before the dispute goes to the human. */
export const CRITIQUE_ROUNDS = 2;

// The human starting a run or answering a question ends the dispute so far; resumes after a park or a halt do not.
const STARTED_BY_HUMAN = `(trigger = 'manual' OR (trigger = 'resume' AND resume_reason IS NULL))`;

/** The findings of the critique runs that sent the ticket back since the human last acted on it, newest first. */
function findingsSinceHuman(db: DatabaseSync, t: Ticket): string[] {
	return db
		.prepare(
			`SELECT (SELECT body FROM comments WHERE run_id = r.id ORDER BY id DESC LIMIT 1) AS body
			FROM runs r JOIN columns c ON c.id = r.column_id
			WHERE r.ticket_id = ?1 AND r.step_result = 'back' AND c.step = 'critique'
				AND r.id > coalesce((SELECT max(id) FROM runs WHERE ticket_id = ?1 AND ${STARTED_BY_HUMAN}), 0)
			ORDER BY r.id DESC`
		)
		.all(t.id)
		.map((r) => String(r.body ?? ''));
}

const roundsUsedUp = (db: DatabaseSync, t: Ticket) =>
	findingsSinceHuman(db, t).length >= CRITIQUE_ROUNDS;

// Fixed wording like the runner's escalation; the answer resumes the critique run, which follows the chosen option.
const DISPUTE_OPTIONS: QuestionOption[] = [
	{ label: 'Der Kritik folgen: noch eine Runde, mit meinem Hinweis' },
	{ label: 'Dem Autor folgen: die Kritik schließt mit done ab' },
	{ label: 'Aufhören: Ticket bleibt beim Menschen', stopsRun: true }
];

function disputeQuestion(db: DatabaseSync, t: Ticket, findings: string) {
	const [previous] = findingsSinceHuman(db, t);
	const question =
		`Autor und Kritiker sind sich nach ${CRITIQUE_ROUNDS} Runden nicht einig: ` +
		`Die Kritik schickt ${t.ref} zum ${CRITIQUE_ROUNDS + 1}. Mal zurück.\n\n` +
		`Befunde der Runde davor:\n${previous}\n\nBefunde jetzt:\n${findings}\n\nWie soll es weitergehen?`;
	return { question, options: DISPUTE_OPTIONS };
}

function nextColumn(db: DatabaseSync, t: Ticket, cols: Column[]): Column {
	assertExitConditions(db, t);
	const next = cols[cols.findIndex((c) => c.id === t.column_id) + 1];
	if (next.phase === 'work') assertNoBlockingPredecessor(db, t);
	return next;
}

function assertNoBlockingPredecessor(db: DatabaseSync, t: Ticket) {
	const open = blockingPredecessors(db, t.id);
	if (!open.length) return;
	const refs = open.map((p) => p.ref).join(', ');
	throw new DomainError(
		'blocked_by_predecessor',
		`${t.ref} wartet auf ${refs} (blocks); es darf nicht in den nächsten Arbeitsschritt.`,
		`Beende den Schritt mit finish_step result blocked und nenne ${refs} in summary; der Mensch entscheidet.`
	);
}

function assertExitConditions(db: DatabaseSync, t: Ticket) {
	const unmet = (EXIT_CHECKS[t.column_step] ?? [])
		.map((check) => check.unmet(db, t))
		.filter((u) => u !== undefined);
	if (!unmet.length) return;
	throw new DomainError(
		'step_incomplete',
		`${t.ref} ist im Schritt „${t.column_name}“ noch nicht fertig: ${unmet.map((u) => u.missing).join('; ')}.`,
		`${unmet.map((u) => u.hint).join('; ')}. Danach finish_step mit done.`
	);
}

function backColumn(t: Ticket, cols: Column[]): Column {
	const step = backStep(
		t.column_step,
		cols.map((c) => c.step)
	);
	const target = cols.find((c) => c.step === step);
	if (target) return target;
	throw new DomainError(
		'back_not_possible',
		`Aus „${t.column_name}“ führt kein Schritt zurück.`,
		'Brauchst du etwas, das dieser Schritt nicht liefern kann, dann finish_step mit result blocked und deiner Frage in summary.'
	);
}
