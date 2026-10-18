import type { DatabaseSync } from 'node:sqlite';
import {
	lageOf,
	progressOf,
	type Lage,
	type LagePhase,
	type LageReason,
	type LageRun,
	type Progress
} from '$lib/lage';
import { PREDECESSOR_OPEN } from './domain/board';
import { OPEN_QUESTION } from './domain/core';
import { waitReasons } from './domain/runs';
import { VARIANTS, type Step, type Variant } from './domain/variants';
import { limits } from './runner';

export type TicketLage = {
	ticketId: number;
	projectId: number;
	step: Step;
	variant: Variant;
	lage: Lage;
	reason: LageReason;
	progress: Progress;
};

type Row = {
	ticketId: number;
	projectId: number;
	step: Step;
	phase: LagePhase;
	variant: Variant;
	runId: number | null;
	runState: LageRun | 'waiting_approval' | 'succeeded' | 'cancelled' | null;
	failureStands: number;
	stepLeftOpen: number;
	approving: number;
	running: number;
	openQuestions: number;
	predecessors: string | null;
};

/**
 * A failure stands while the ticket is still in the step the run failed in, or while the run's own finish_step moved it
 * to the next work step last: then the chain stopped and nobody has acted since. A move by the human clears it.
 */
const FAILURE_STANDS = `(r.column_id IS t.column_id
	OR (c.phase = 'work' AND t.moved_by ->> '$.runId' IS r.id))`;

/** The run ended without finish_step and the ticket still stands in its step, so nothing carries it on. */
const STEP_LEFT_OPEN = `(r.state = 'succeeded' AND r.step_result IS NULL AND r.column_id IS t.column_id)`;

const LAGE_ROWS = `
	SELECT t.id AS ticketId, t.project_id AS projectId, c.step, c.phase, p.variant,
		r.id AS runId, r.state AS runState, ${FAILURE_STANDS} AS failureStands, ${STEP_LEFT_OPEN} AS stepLeftOpen,
		EXISTS (SELECT 1 FROM runs a WHERE a.ticket_id = t.id AND a.state = 'waiting_approval') AS approving,
		EXISTS (SELECT 1 FROM runs a WHERE a.ticket_id = t.id AND a.state = 'running') AS running,
		(SELECT count(*) FROM questions q WHERE q.ticket_id = t.id AND ${OPEN_QUESTION}) AS openQuestions,
		(SELECT group_concat(bp.key || '-' || b.number, ' ')
			FROM ticket_relations rel JOIN tickets b ON b.id = rel.from_ticket_id
			JOIN projects bp ON bp.id = b.project_id JOIN columns bc ON bc.id = b.column_id
			WHERE rel.to_ticket_id = t.id AND rel.type = 'blocks' AND ${PREDECESSOR_OPEN}) AS predecessors
	FROM tickets t JOIN projects p ON p.id = t.project_id JOIN columns c ON c.id = t.column_id
	LEFT JOIN runs r ON r.id = (SELECT max(id) FROM runs WHERE ticket_id = t.id)
	WHERE p.archived = 0 AND (?1 IS NULL OR t.project_id = ?1) AND (?2 IS NULL OR t.id = ?2)
	ORDER BY t.id`;

/**
 * A ticket can hold more than one run: a run that works counts even when a newer one waits, while a failed, paused,
 * queued or stalled run counts only as the newest, and a failure only while it stands.
 */
function runInput(row: Row): LageRun | null {
	const { runState: state } = row;
	if (state === 'failed' && row.failureStands) return 'failed';
	if (row.running) return 'running';
	if (row.stepLeftOpen) return 'stalled';
	return state === 'queued' || state === 'paused' ? state : null;
}

function lagenOf(
	db: DatabaseSync,
	projectId: number | null,
	ticketId: number | null
): TicketLage[] {
	const rows = db.prepare(LAGE_ROWS).all(projectId, ticketId) as Row[];
	const capacity = rows.some((row) => runInput(row) === 'queued')
		? waitReasons(db, limits())
		: new Map();
	return rows.map((row) => {
		const { lage, reason } = lageOf({
			phase: row.phase,
			run: runInput(row),
			openQuestions: row.openQuestions,
			pendingApproval: row.approving === 1,
			openProposals: 0,
			openPredecessors: row.predecessors?.split(' ').sort() ?? [],
			autoAccepted: false,
			capacity: capacity.get(row.runId)?.causes ?? null
		});
		return {
			ticketId: row.ticketId,
			projectId: row.projectId,
			step: row.step,
			variant: row.variant,
			lage,
			reason,
			progress: progressOf(VARIANTS[row.variant], row.step)
		};
	});
}

/** The Lage of every ticket in one project, or in every non-archived project, in a constant number of queries. */
export const ticketLagen = (db: DatabaseSync, options: { projectId?: number } = {}): TicketLage[] =>
	lagenOf(db, options.projectId ?? null, null);

/** The Lage of one ticket; `undefined` when it does not exist or its project is archived. */
export const ticketLage = (db: DatabaseSync, ticketId: number): TicketLage | undefined =>
	lagenOf(db, null, ticketId)[0];
