import type { DatabaseSync } from 'node:sqlite';
import type { RunStart, RunTab, StartProfile } from '$lib/runs/run-control';
import type { ProjectRef } from '$lib/shell/shell.svelte';
import type { RunTrace, TraceEvent } from '$lib/trace/trace';
import * as board from './domain/board';
import { awaitsResume } from './domain/halt';
import type { Actor } from './domain/core';
import { latestOpenQuestion, type LatestQuestion } from './domain/questions';
import { projectRef } from './live';
import { relationsOf, tasksOf, type RelatedTicket, type ToolContext } from './mcp';
import { listProfiles, waitReason, type RunState } from './domain/runs';
import { LIMITS } from './runner';

export type TicketComment = {
	id: number;
	authorKind: 'user' | 'agent' | 'system';
	author: string;
	body: string;
	createdAt: string;
	runId: number | null;
};

export type TicketMove = {
	columnId: number;
	name: string;
	kind: board.Kind;
	/** Board position of the target column, so the ticket page can tell `>`/`<` apart without a second lookup. */
	position: number;
	blockers: board.Blocker[];
};

export type TicketDetail = {
	id: number;
	ref: string;
	project: ProjectRef;
	title: string;
	description: string;
	type: 'ticket' | 'epic';
	column: { id: number; name: string; position: number };
	tasks: ReturnType<typeof tasksOf>;
	comments: TicketComment[];
	relations: Record<string, RelatedTicket[]>;
	moves: TicketMove[];
	openQuestion?: LatestQuestion;
};

type TicketExtra = {
	title: string;
	description: string;
	projectKey: string;
	projectName: string;
	columnPosition: number;
};

/** Fields `board.ticket` leaves out (it exists for rule checks, not display): editable content and the project/column names. */
function ticketExtra(db: DatabaseSync, t: board.Ticket): TicketExtra {
	return db
		.prepare(
			`SELECT t.title, t.description, p.key AS projectKey, p.name AS projectName, c.position AS columnPosition
			FROM tickets t JOIN projects p ON p.id = t.project_id JOIN columns c ON c.id = t.column_id
			WHERE t.id = ?`
		)
		.get(t.id) as TicketExtra;
}

const columnPositions = (db: DatabaseSync, projectId: number) =>
	new Map(
		(
			db.prepare('SELECT id, position FROM columns WHERE project_id = ?').all(projectId) as {
				id: number;
				position: number;
			}[]
		).map((c) => [c.id, c.position])
	);

/** Every column the actor can move the ticket to, with its board position and what still blocks the move. */
export function ticketMoves(
	db: DatabaseSync,
	actor: Actor,
	ticketId: number,
	projectId: number
): TicketMove[] {
	const positions = columnPositions(db, projectId);
	return board.allowedMoves(db, ticketId, actor).map((m) => ({
		columnId: m.columnId,
		name: m.name,
		kind: m.kind,
		position: positions.get(m.columnId)!,
		blockers: m.blockers
	}));
}

function commentsOf(db: DatabaseSync, ticketId: number): TicketComment[] {
	return db
		.prepare(
			`SELECT id, author_kind AS authorKind, author, body, created_at AS createdAt, run_id AS runId
			FROM comments WHERE ticket_id = ? ORDER BY id`
		)
		.all(ticketId) as TicketComment[];
}

/**
 * Everything the Run-Akte shows about one ticket: reuses `board.ticket`/`allowedMoves` for the rules and
 * `relationsOf`/`tasksOf` (mcp.ts) for the same reading an agent gets from `get_ticket` (the AX requirement that
 * human and agent see the same truth).
 */
export function ticketDetail(db: DatabaseSync, actor: Actor, ticketId: number): TicketDetail {
	const t = board.ticket(db, ticketId);
	const extra = ticketExtra(db, t);
	const ctx: ToolContext = { actor, projectId: t.project_id, ticketId: t.id };
	return {
		id: t.id,
		ref: t.ref,
		project: projectRef({ id: t.project_id, key: extra.projectKey, name: extra.projectName }),
		title: extra.title,
		description: extra.description,
		type: t.type,
		column: { id: t.column_id, name: t.column_name, position: extra.columnPosition },
		tasks: tasksOf(db, t.id),
		comments: commentsOf(db, t.id),
		relations: relationsOf(db, ctx, t.id),
		moves: ticketMoves(db, actor, t.id, t.project_id),
		openQuestion: latestOpenQuestion(db, t.id)
	};
}

/** Resolves a deep-link's `[key]/t/[number]` to a ticket id; `undefined` is the caller's cue for a 404. */
export function findTicketId(db: DatabaseSync, key: string, number: number): number | undefined {
	const row = db
		.prepare(
			'SELECT t.id AS id FROM tickets t JOIN projects p ON p.id = t.project_id WHERE p.key = ? AND t.number = ?'
		)
		.get(key.toUpperCase(), number) as { id: number } | undefined;
	return row?.id;
}

/** The run `runId` names, or the ticket's newest run; `undefined` when the ticket has no such run. */
export function runTrace(db: DatabaseSync, ticketId: number, runId?: number): RunTrace | undefined {
	const run = db
		.prepare(
			'SELECT id, state, error, halted FROM runs WHERE ticket_id = ?1 AND (?2 IS NULL OR id = ?2) ORDER BY id DESC LIMIT 1'
		)
		.get(ticketId, runId ?? null) as
		{ id: number; state: RunState; error: string | null; halted: 0 | 1 } | undefined;
	if (!run) return undefined;
	return {
		id: run.id,
		state: run.state,
		failure: run.state === 'failed' ? failureOf(db, run.id, run.error ?? '') : undefined,
		continuedBy: continuingRun(db, run.id),
		waitsForAnswer:
			db.prepare('SELECT 1 FROM questions WHERE run_id = ? AND answer IS NULL').get(run.id) !==
			undefined,
		halted: run.halted === 1,
		events: eventsOf(db, run.id)
	};
}

function eventsOf(db: DatabaseSync, runId: number): TraceEvent[] {
	const rows = db
		.prepare(
			'SELECT seq, type, idempotency_key AS key, payload FROM run_events WHERE run_id = ? ORDER BY seq'
		)
		.all(runId) as (Omit<TraceEvent, 'payload'> & { payload: string })[];
	return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

/** A cancelled follow-up (an answer taken back) continues nothing. */
function continuingRun(db: DatabaseSync, runId: number): number | undefined {
	const row = db
		.prepare(
			"SELECT id FROM runs WHERE resumed_from_run_id = ? AND state <> 'cancelled' ORDER BY id DESC LIMIT 1"
		)
		.get(runId) as { id: number } | undefined;
	return row?.id;
}

// The runner stores `[code] message` as the error and adds the way out only to its failure comment.
const ERROR_FORMAT = /^\[([^\]]+)\] ([\s\S]*)$/;
const WAY_OUT = '\nAusweg: ';

function failureOf(db: DatabaseSync, runId: number, error: string): RunTrace['failure'] {
	const [, code = '', message = error] = ERROR_FORMAT.exec(error) ?? [];
	const comment = db
		.prepare(
			"SELECT body FROM comments WHERE run_id = ? AND author_kind = 'system' AND instr(body, ?) > 0 ORDER BY id DESC LIMIT 1"
		)
		.get(runId, WAY_OUT) as { body: string } | undefined;
	const wayOut = comment ? comment.body.slice(comment.body.indexOf(WAY_OUT) + WAY_OUT.length) : '';
	return { code, message, wayOut };
}

const iso = (column: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${column})`;

type RunTabRow = Omit<RunTab, 'halted' | 'resumable'> & { halted: 0 | 1; resumable: 0 | 1 };

/** The runs of a ticket, newest first, as the run tabs show them; a queued one says why it waits. */
export function runTabs(db: DatabaseSync, ticketId: number): RunTab[] {
	const rows = db
		.prepare(
			`SELECT r.id, r.state, p.name AS profile, ${iso('r.started_at')} AS startedAt,
				${iso('r.finished_at')} AS finishedAt, r.tokens_in AS tokensIn, r.tokens_out AS tokensOut, r.cost,
				r.resumed_from_run_id AS resumedFrom, r.resume_reason AS resumeReason, r.halted,
				${awaitsResume('r')} AS resumable
			FROM runs r LEFT JOIN agent_profiles p ON p.id = r.agent_profile_id
			WHERE r.ticket_id = ? ORDER BY r.id DESC`
		)
		.all(ticketId) as RunTabRow[];
	return rows.map((row) => {
		const tab = { ...row, halted: row.halted === 1, resumable: row.resumable === 1 };
		return tab.state === 'queued'
			? { ...tab, waitText: waitReason(db, tab.id, LIMITS)?.text }
			: tab;
	});
}

/** The profiles to start a run with; preselected is the one the newest run of the project used, else the first. */
export function runStart(db: DatabaseSync, projectId: number): RunStart {
	const profiles = listProfiles(db).map(({ id, name }) => ({ id, name }) as StartProfile);
	const lastUsed = db
		.prepare(
			`SELECT r.agent_profile_id AS id FROM runs r JOIN tickets t ON t.id = r.ticket_id
			WHERE t.project_id = ? AND r.agent_profile_id IS NOT NULL ORDER BY r.id DESC LIMIT 1`
		)
		.get(projectId) as { id: number } | undefined;
	return { profiles, preselected: lastUsed?.id ?? profiles[0]?.id };
}

export const isRunOf = (db: DatabaseSync, ticketId: number, runId: number): boolean =>
	db.prepare('SELECT 1 FROM runs WHERE id = ? AND ticket_id = ?').get(runId, ticketId) !==
	undefined;
