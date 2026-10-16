import type { DatabaseSync } from 'node:sqlite';
import { interventionOf, RECOVERY, type Stall } from '../agents/loop-guard';
import type { ExecutorFacts } from '../executors/contract';
import { mask } from '../secrets';
import { addComment, ticket, tasksOf } from './board';
import { DomainError, tx, type Actor } from './core';
import { collectShownAnswer, requestHuman, type QuestionOption } from './questions';
import {
	appendEvent,
	createRun,
	finishRun,
	freshRunsInChain,
	type Intervention,
	type ParkReason,
	type Usage
} from './runs';
import { queueNextStep } from './steps';

type EndedRun = { id: number; ticketId: number; profile: { id: number } };

const SYSTEM: Actor = { kind: 'system' };
const FRESH_RUN_REASON_TEXT = {
	context_budget: 'Kontext-Budget erreicht',
	recovery: 'Stillstand oder Längenlimit'
};
type FreshRunReason = keyof typeof FRESH_RUN_REASON_TEXT;

/** Ends the run as failed with the error's code and way out, and leaves that as a comment on the ticket. */
export function failRun(
	db: DatabaseSync,
	runId: number,
	ticketId: number,
	err: unknown,
	usage?: Usage
) {
	const code = err instanceof DomainError ? err.code : 'executor_error';
	const hint =
		err instanceof DomainError
			? err.hint
			: 'Run-Log prüfen, Ursache beheben und einen neuen Run starten.';
	const error = `[${code}] ${err instanceof Error ? err.message : String(err)}`;
	tx(db, () => {
		finishRun(db, SYSTEM, runId, { state: 'failed', error, usage });
		addComment(
			db,
			{ kind: 'system', runId },
			ticketId,
			mask(`Run ${runId} ist fehlgeschlagen: ${error}\nAusweg: ${hint}`)
		);
	});
}

/**
 * Decides from the facts an executor reported how the run ends, in one transaction: a paused run never stays without its
 * follow-up run or the question to the human, a run that finished its step never without the run for the next one, and
 * a run that ran out of steps never without the failure comment. `park` is why the run was asked to park, if it was.
 */
export function endExecutedRun(
	db: DatabaseSync,
	run: EndedRun,
	facts: ExecutorFacts,
	park?: ParkReason
) {
	tx(db, () => {
		const actor: Actor = { kind: 'agent', runId: run.id };
		if (facts.ending === 'stalled')
			appendEvent(db, actor, run.id, {
				type: 'intervention',
				payload: freshRunIntervention(db, run.id, facts.stall)
			});
		const handoff = facts.lastMessage
			? { text: facts.lastMessage }
			: { text: generatedHandoff(db, run), generated: true };
		appendEvent(db, actor, run.id, { type: 'message', key: 'handoff', payload: handoff });
		const { usage } = facts;
		if (askedQuestion(db, run.id)) return finishRun(db, SYSTEM, run.id, { state: 'paused', usage });
		// the model answered the prompt that showed the answer, even if it showed no other sign of life
		collectShownAnswer(db, run.id);
		const continues = !finishedStep(db, run.id);
		if (continues && facts.ending === 'parked')
			return pauseAndContinue(db, run, usage, parkReason(park));
		if (continues && facts.ending === 'stalled')
			return pauseAndContinue(db, run, usage, { reason: 'recovery' });
		if (continues && facts.ending === 'turn_limit')
			return failRun(db, run.id, run.ticketId, stepLimit(db, run.id), usage);
		finishRun(db, SYSTEM, run.id, { state: 'succeeded', usage });
		queueNextStep(db, run.id);
	});
}

function parkReason(park: ParkReason | undefined): ParkReason {
	if (park) return park;
	throw new Error('The executor reported a parked run, but nobody asked it to park.');
}

function pauseAndContinue(
	db: DatabaseSync,
	run: EndedRun,
	usage: Usage | undefined,
	resume: ParkReason
) {
	finishRun(db, SYSTEM, run.id, { state: 'paused', usage });
	continuePausedRun(db, run, resume);
}

const askedQuestion = (db: DatabaseSync, runId: number) =>
	db.prepare('SELECT 1 FROM questions WHERE run_id = ?').get(runId) !== undefined;

const finishedStep = (db: DatabaseSync, runId: number) =>
	db.prepare("SELECT 1 FROM runs WHERE id = ? AND step_result IN ('done', 'back')").get(runId) !==
	undefined;

function stepLimit(db: DatabaseSync, runId: number) {
	const { steps } = db
		.prepare(
			"SELECT count(*) AS steps FROM run_events WHERE run_id = ? AND type = 'log' AND payload ->> '$.kind' = 'step'"
		)
		.get(runId) as { steps: number };
	return new DomainError(
		'step_limit',
		`Der Run hat nach ${steps} Schritten aufgehört, ohne seinen Schritt mit finish_step abzuschließen.`,
		'Prüfe im Run-Log, ob der Agent finish_step erreicht hat, und erhöhe max_steps im Agent-Profil oder schneide das Ticket kleiner, dann starte einen neuen Run.'
	);
}

/** Counts on the chain's fresh runs; beyond their maximum the human is asked instead of a run started. */
const freshRunIntervention = (db: DatabaseSync, runId: number, stall: Stall) =>
	interventionOf(
		stall,
		freshRunsInChain(db, runId) + 1,
		RECOVERY.freshRunsPerChain,
		`${stall.reason} The run ends with a handoff.`
	);

/** A handoff from the run's events, so that a model ending without a closing text never leaves an empty trace. */
function generatedHandoff(db: DatabaseSync, run: EndedRun): string {
	const { column_step: step } = ticket(db, run.ticketId);
	const openTasks = tasksOf(db, run.ticketId).filter((task) => !task.done);
	return [
		"Summary: the model ended without a closing text; this handoff is generated from the run's events.",
		`Tools: ${toolUse(db, run.id) || 'none'}`,
		`Ticket: ${finishedStep(db, run.id) ? 'moved to' : 'not moved, still in'} ${step}`,
		`Open tasks:${openTasks.length ? '' : ' none'}`,
		...openTasks.map((task) => `- ${task.id}: ${task.title}`)
	].join('\n');
}

/** Each tool with how often the run called it and how often that failed, in the order of first use. */
function toolUse(db: DatabaseSync, runId: number): string {
	const results = db
		.prepare(
			"SELECT payload FROM run_events WHERE run_id = ? AND type = 'tool_result' ORDER BY seq"
		)
		.all(runId)
		.map((e) => JSON.parse(e.payload as string) as { tool: string; isError: boolean });
	const uses = new Map<string, { calls: number; failed: number }>();
	for (const result of results) {
		const use = uses.get(result.tool) ?? { calls: 0, failed: 0 };
		uses.set(result.tool, { calls: use.calls + 1, failed: use.failed + Number(result.isError) });
	}
	return [...uses]
		.map(([tool, { calls, failed }]) => `${tool} ${calls}×${failed ? ` (${failed} failed)` : ''}`)
		.join(', ');
}

/** Queues the run that continues a paused one, or asks the human once its chain has used up its fresh runs. */
export function continuePausedRun(db: DatabaseSync, run: EndedRun, resume: ParkReason) {
	const actor: Actor = { kind: 'system', runId: run.id };
	if (resume.reason === 'quota' || freshRunsInChain(db, run.id) < RECOVERY.freshRunsPerChain) {
		createRun(db, actor, {
			ticketId: run.ticketId,
			profileId: run.profile.id,
			resumedFromRunId: run.id,
			resumeReason: resume.reason,
			notBefore: resume.notBefore
		});
		return;
	}
	askHumanAfterUsedUpChain(db, actor, run, resume.reason);
}

// Fixed wording, chosen by the human once for every escalation; option 3 ends the chain instead of starting a run.
const ESCALATION_OPTIONS: QuestionOption[] = [
	{ label: 'Neuer Versuch mit frischem Kontext und meinem Hinweis' },
	{ label: 'Aufgabe verkleinern: nur den nächsten prüfbaren Schritt' },
	{ label: 'Aufhören: Stand als Kommentar festhalten, Ticket bleibt beim Menschen', stopsRun: true }
];

function ticketPath(db: DatabaseSync, ticketId: number): string {
	const row = db
		.prepare(
			'SELECT p.key AS key, t.number AS number FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.id = ?'
		)
		.get(ticketId) as { key: string; number: number };
	return `/p/${row.key}/t/${row.number}`;
}

function lastIntervention(db: DatabaseSync, runId: number): Intervention | undefined {
	const row = db
		.prepare(
			"SELECT payload FROM run_events WHERE run_id = ? AND type = 'intervention' ORDER BY seq DESC LIMIT 1"
		)
		.get(runId) as { payload: string } | undefined;
	return row && (JSON.parse(row.payload) as Intervention);
}

/** Stage-1 hints share `max = RECOVERY.hintsPerRun`; the final stage-2 entry that ends the run has a different max. */
function hintsGiven(db: DatabaseSync, runId: number): number {
	const { n } = db
		.prepare(
			"SELECT count(*) AS n FROM run_events WHERE run_id = ? AND type = 'intervention' AND payload ->> '$.max' = ?"
		)
		.get(runId, RECOVERY.hintsPerRun) as { n: number };
	return n;
}

function askHumanAfterUsedUpChain(
	db: DatabaseSync,
	actor: Actor,
	run: EndedRun,
	reason: FreshRunReason
) {
	const hints = hintsGiven(db, run.id);
	const lastHint = lastIntervention(db, run.id)?.hint;
	const short = `Run ${run.id} kommt nicht weiter (${FRESH_RUN_REASON_TEXT[reason]}). Wie soll es weitergehen?`;
	const details =
		`Seine Kette hat den frischen Run schon verbraucht (höchstens ${RECOVERY.freshRunsPerChain} je Kette). ${hints} ${hints === 1 ? 'Hinweis' : 'Hinweise'} in diesem Run` +
		(lastHint ? `, zuletzt: „${lastHint}“` : '') +
		'.';
	const link = `${ticketPath(db, run.ticketId)}?run=${run.id}`;
	requestHuman(db, actor, run.ticketId, {
		question: `${short}\n\n${details} Den Stand zeigt die Run-Akte: ${link}.`,
		options: ESCALATION_OPTIONS
	});
}
