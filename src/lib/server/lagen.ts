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
import { LIMITS } from './runner';

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
	runInStep: number;
	approving: number;
	running: number;
	openQuestions: number;
	predecessors: string | null;
};

const LAGE_ROWS = `
	SELECT t.id AS ticketId, t.project_id AS projectId, c.step, c.phase, p.variant,
		r.id AS runId, r.state AS runState, r.column_id IS t.column_id AS runInStep,
		EXISTS (SELECT 1 FROM runs a WHERE a.ticket_id = t.id AND a.state = 'waiting_approval') AS approving,
		EXISTS (SELECT 1 FROM runs a WHERE a.ticket_id = t.id AND a.state = 'running') AS running,
		(SELECT count(*) FROM questions q WHERE q.ticket_id = t.id AND ${OPEN_QUESTION}) AS openQuestions,
		(SELECT group_concat(bp.key || '-' || b.number, ' ')
			FROM ticket_relations rel JOIN tickets b ON b.id = rel.from_ticket_id
			JOIN projects bp ON bp.id = b.project_id JOIN columns bc ON bc.id = b.column_id
			WHERE rel.to_ticket_id = t.id AND rel.type = 'blocks' AND ${PREDECESSOR_OPEN}) AS predecessors
	FROM tickets t JOIN projects p ON p.id = t.project_id JOIN columns c ON c.id = t.column_id
	LEFT JOIN runs r ON r.id = (SELECT max(id) FROM runs WHERE ticket_id = t.id)
	WHERE p.archived = 0 AND (?1 IS NULL OR t.project_id = ?1)
	ORDER BY t.id`;

/**
 * A ticket can hold more than one run: a run that works counts even when a newer one waits, while a failed, paused or
 * queued run counts only as the newest, and a failure only while the ticket is still in the step it failed in.
 */
function runInput(row: Row): LageRun | null {
	const { runState: state } = row;
	if (state === 'failed') return row.runInStep ? 'failed' : null;
	if (row.running) return 'running';
	return state === 'queued' || state === 'paused' ? state : null;
}

/** The Lage of every ticket in one project, or in every non-archived project, in a constant number of queries. */
export function ticketLagen(db: DatabaseSync, options: { projectId?: number } = {}): TicketLage[] {
	const rows = db.prepare(LAGE_ROWS).all(options.projectId ?? null) as Row[];
	const capacity = rows.some((row) => runInput(row) === 'queued')
		? waitReasons(db, LIMITS)
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
