import type { DatabaseSync } from 'node:sqlite';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import { attempt } from '$lib/server/domain-failure';
import { projectRef } from '$lib/server/live';
import { ticketMoves, type TicketMove } from '$lib/server/ticket-view';
import { LIVE_DEPENDENCY } from '$lib/shell/live.svelte';
import { nextMove } from '$lib/ticket-move';
import { BOARD_DEPENDENCY, type BoardTicket, type ColumnKind, type StepTarget } from './list';
import type { Actions, PageServerLoad } from './$types';

const HUMAN: Actor = { kind: 'user' };

export type BoardPage = {
	tickets: BoardTicket[];
	/** The role prompt of every column, by column id. */
	roles: Record<number, string>;
};

type TicketRow = {
	id: number;
	number: number;
	title: string;
	projectId: number;
	key: string;
	name: string;
	columnId: number;
	columnName: string;
	columnKind: ColumnKind;
	columnPosition: number;
	tasksDone: number;
	tasksTotal: number;
	epic: string | null;
};

const TICKETS = `
	SELECT t.id, t.number, t.title, p.id AS projectId, p.key, p.name,
		c.id AS columnId, c.name AS columnName, c.kind AS columnKind, c.position AS columnPosition,
		(SELECT count(*) FROM tasks k WHERE k.ticket_id = t.id AND k.done_at IS NOT NULL) AS tasksDone,
		(SELECT count(*) FROM tasks k WHERE k.ticket_id = t.id) AS tasksTotal,
		(SELECT ep.key || '-' || e.number FROM ticket_relations r
			JOIN tickets e ON e.id = r.from_ticket_id JOIN projects ep ON ep.id = e.project_id
			WHERE r.to_ticket_id = t.id AND r.type = 'parent_of' AND e.type = 'epic'
			ORDER BY e.id LIMIT 1) AS epic
	FROM tickets t JOIN projects p ON p.id = t.project_id JOIN columns c ON c.id = t.column_id
	WHERE p.archived = 0
	ORDER BY t.id`;

const stepTarget = (move: TicketMove | undefined): StepTarget | undefined =>
	move && { columnId: move.columnId, name: move.name, blockers: move.blockers };

function boardTicket(db: DatabaseSync, row: TicketRow): BoardTicket {
	const moves = ticketMoves(db, HUMAN, row.id, row.projectId);
	return {
		id: row.id,
		ref: `${row.key}-${row.number}`,
		number: row.number,
		title: row.title,
		project: projectRef({ id: row.projectId, key: row.key, name: row.name }),
		column: {
			id: row.columnId,
			name: row.columnName,
			kind: row.columnKind,
			position: row.columnPosition
		},
		tasks: { done: row.tasksDone, total: row.tasksTotal },
		epic: row.epic,
		next: {
			forward: stepTarget(nextMove(moves, row.columnPosition, true)),
			back: stepTarget(nextMove(moves, row.columnPosition, false))
		}
	};
}

function roles(db: DatabaseSync): Record<number, string> {
	const rows = db
		.prepare(
			'SELECT c.id, c.role_prompt AS role FROM columns c JOIN projects p ON p.id = c.project_id WHERE p.archived = 0'
		)
		.all() as { id: number; role: string }[];
	return Object.fromEntries(rows.map((row) => [row.id, row.role]));
}

// A reconnect reloads the live state; the board reloads with it, as it has no replay of the events it missed.
export const load: PageServerLoad = ({ depends }): BoardPage => {
	depends(LIVE_DEPENDENCY, BOARD_DEPENDENCY);
	const rows = db().prepare(TICKETS).all() as TicketRow[];
	return { tickets: rows.map((row) => boardTicket(db(), row)), roles: roles(db()) };
};

const numberField = (form: FormData, name: string) => Number(form.get(name));
const textField = (form: FormData, name: string) => String(form.get(name) ?? '');

function createTicket(form: FormData) {
	const column = form.get('columnId');
	const { id } = board.createTicket(db(), HUMAN, numberField(form, 'projectId'), {
		title: textField(form, 'title'),
		column_id: column === null ? undefined : Number(column)
	});
	return { ref: board.ticket(db(), id).ref };
}

export const actions: Actions = {
	move: async ({ request }) => {
		const form = await request.formData();
		return attempt(() =>
			board.moveTicket(db(), HUMAN, numberField(form, 'ticketId'), numberField(form, 'columnId'))
		);
	},
	create: async ({ request }) => {
		const form = await request.formData();
		return attempt(() => createTicket(form));
	},
	rename: async ({ request }) => {
		const form = await request.formData();
		const title = textField(form, 'title');
		return attempt(() => board.updateTicket(db(), HUMAN, numberField(form, 'ticketId'), { title }));
	},
	delete: async ({ request }) => {
		const form = await request.formData();
		return attempt(() => board.deleteTicket(db(), HUMAN, numberField(form, 'ticketId')));
	}
};
