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
	openQuestions: number;
	predecessors: string | null;
};

const LAGE_ROWS = `
	SELECT t.id AS ticketId, t.project_id AS projectId, c.step, c.phase, p.variant,
		r.id AS runId, r.state AS runState,
		(SELECT count(*) FROM questions q WHERE q.ticket_id = t.id AND ${OPEN_QUESTION}) AS openQuestions,
		(SELECT group_concat(bp.key || '-' || b.number, ' ')
			FROM ticket_relations rel JOIN tickets b ON b.id = rel.from_ticket_id
			JOIN projects bp ON bp.id = b.project_id JOIN columns bc ON bc.id = b.column_id
			WHERE rel.to_ticket_id = t.id AND rel.type = 'blocks' AND ${PREDECESSOR_OPEN}) AS predecessors
	FROM tickets t JOIN projects p ON p.id = t.project_id JOIN columns c ON c.id = t.column_id
	LEFT JOIN runs r ON r.id = (SELECT max(id) FROM runs WHERE ticket_id = t.id)
	WHERE p.archived = 0 AND (?1 IS NULL OR t.project_id = ?1)
	ORDER BY t.id`;

const runInput = (state: Row['runState']): LageRun | null =>
	state === 'queued' || state === 'running' || state === 'paused' || state === 'failed'
		? state
		: null;

/** The Lage of every ticket in one project, or in every non-archived project, in a constant number of queries. */
export function ticketLagen(db: DatabaseSync, options: { projectId?: number } = {}): TicketLage[] {
	const rows = db.prepare(LAGE_ROWS).all(options.projectId ?? null) as Row[];
	const capacity = rows.some((row) => row.runState === 'queued')
		? waitReasons(db, LIMITS)
		: new Map();
	return rows.map((row) => {
		const { lage, reason } = lageOf({
			phase: row.phase,
			run: runInput(row.runState),
			openQuestions: row.openQuestions,
			pendingApproval: row.runState === 'waiting_approval',
			openProposals: 0,
			openPredecessors: row.predecessors?.split(' ').sort() ?? [],
			autoAccepted: false,
			capacityText: capacity.get(row.runId)?.text ?? null
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
