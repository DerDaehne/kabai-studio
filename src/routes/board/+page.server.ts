import { BOARD_DEPENDENCY, LIVE_DEPENDENCY } from '$lib/live';
import { db } from '$lib/server/db';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import type { DomainError } from '$lib/server/domain/error';
import { translate, type Locale } from '$lib/i18n';
import { acceptTicket, returnTicket, startTicket } from '$lib/server/domain/intents';
import { attempt } from '$lib/server/domain-failure';
import { projectRef } from '$lib/server/live';
import { ticketLagen, type TicketLage } from '$lib/server/lagen';
import { STEP_LABELS, VARIANTS, type Step, type Variant } from '$lib/server/domain/variants';
import { FLOW_COOKIE, type BoardColumn, type BoardTicket, type ColumnPhase } from './list';
import type { RunTraceState } from '$lib/trace/trace';
import type { Actions, PageServerLoad } from './$types';

const HUMAN: Actor = { kind: 'user' };

export type BoardPage = {
	tickets: BoardTicket[];
	/** Every column of every active project, by variant and step order; the expert view shows them and moves along them. */
	columns: BoardColumn[];
	/** The browser's choice: the expert view with the columns instead of the Lagen. */
	flow: boolean;
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
	columnPhase: ColumnPhase;
	columnPosition: number;
	tasksDone: number;
	tasksTotal: number;
	epic: string | null;
	runState: RunTraceState | null;
	profile: string | null;
	updatedAt: string;
};

const TICKETS = `
	SELECT t.id, t.number, t.title, p.id AS projectId, p.key, p.name,
		c.id AS columnId, c.name AS columnName, c.phase AS columnPhase, c.position AS columnPosition,
		(SELECT count(*) FROM tasks k WHERE k.ticket_id = t.id AND k.done_at IS NOT NULL) AS tasksDone,
		(SELECT count(*) FROM tasks k WHERE k.ticket_id = t.id) AS tasksTotal,
		(SELECT ep.key || '-' || e.number FROM ticket_relations r
			JOIN tickets e ON e.id = r.from_ticket_id JOIN projects ep ON ep.id = e.project_id
			WHERE r.to_ticket_id = t.id AND r.type = 'parent_of' AND e.type = 'epic'
			ORDER BY e.id LIMIT 1) AS epic,
		r.state AS runState, a.name AS profile, t.updated_at AS updatedAt
	FROM tickets t JOIN projects p ON p.id = t.project_id JOIN columns c ON c.id = t.column_id
	LEFT JOIN runs r ON r.id = (SELECT max(id) FROM runs WHERE ticket_id = t.id)
	LEFT JOIN agent_profiles a ON a.id = r.agent_profile_id
	WHERE p.archived = 0
	ORDER BY t.id`;

const COLUMNS = `
	SELECT c.id, c.project_id AS projectId, p.variant, c.step, c.name, c.phase, c.position
	FROM columns c JOIN projects p ON p.id = c.project_id WHERE p.archived = 0`;

const STEP_ORDER = Object.keys(STEP_LABELS) as Step[];
const VARIANT_ORDER = Object.keys(VARIANTS) as Variant[];
const stepIndex = (column: BoardColumn) => STEP_ORDER.indexOf(column.step as Step);
const variantIndex = (column: BoardColumn) => VARIANT_ORDER.indexOf(column.variant);

function boardTicket(row: TicketRow, lage: TicketLage): BoardTicket {
	return {
		id: row.id,
		ref: `${row.key}-${row.number}`,
		number: row.number,
		title: row.title,
		project: projectRef({ id: row.projectId, key: row.key, name: row.name }),
		column: {
			id: row.columnId,
			name: row.columnName,
			phase: row.columnPhase,
			position: row.columnPosition
		},
		tasks: { done: row.tasksDone, total: row.tasksTotal },
		epic: row.epic,
		lage: lage.lage,
		reason: lage.reason,
		step: lage.step,
		progress: lage.progress,
		run: row.runState ? { state: row.runState, profile: row.profile } : null,
		updatedAt: row.updatedAt
	};
}

/** Every column once, so the human's moves follow from the columns, not from a lookup per ticket. */
const boardColumns = () =>
	(db().prepare(COLUMNS).all() as BoardColumn[]).sort(
		(a, b) =>
			variantIndex(a) - variantIndex(b) || stepIndex(a) - stepIndex(b) || a.projectId - b.projectId
	);

// A reconnect reloads the live state; the board reloads with it, as it has no replay of the events it missed.
export const load: PageServerLoad = ({ depends, cookies }): BoardPage => {
	depends(LIVE_DEPENDENCY, BOARD_DEPENDENCY);
	const rows = db().prepare(TICKETS).all() as TicketRow[];
	const lagen = new Map(ticketLagen(db()).map((lage) => [lage.ticketId, lage]));
	return {
		tickets: rows.map((row) => boardTicket(row, lagen.get(row.id)!)),
		columns: boardColumns(),
		flow: cookies.get(FLOW_COOKIE) === 'flow'
	};
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

/** The domain's way out for open tasks names the agents' tools; the human gets a sentence that fits the board. */
const humanWayOut = (locale: Locale) => (err: DomainError) =>
	err.code === 'open_tasks'
		? { message: `${err.message} ${translate(locale, 'board.refusal.openTasks')}` }
		: {};

export const actions: Actions = {
	move: async ({ request, locals }) => {
		const form = await request.formData();
		return attempt(
			() =>
				board.moveTicket(db(), HUMAN, numberField(form, 'ticketId'), numberField(form, 'columnId')),
			humanWayOut(locals.locale)
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
	start: async ({ request }) => {
		const form = await request.formData();
		return attempt(() => {
			const { predecessors } = startTicket(db(), HUMAN, numberField(form, 'ticketId'));
			return { predecessors: predecessors.map((predecessor) => predecessor.ref) };
		});
	},
	accept: async ({ request, locals }) => {
		const form = await request.formData();
		return attempt(
			() => acceptTicket(db(), HUMAN, numberField(form, 'ticketId')),
			humanWayOut(locals.locale)
		);
	},
	giveBack: async ({ request }) => {
		const form = await request.formData();
		return attempt(() =>
			returnTicket(db(), HUMAN, numberField(form, 'ticketId'), textField(form, 'comment'))
		);
	},
	delete: async ({ request }) => {
		const form = await request.formData();
		return attempt(() => board.deleteTicket(db(), HUMAN, numberField(form, 'ticketId')));
	}
};
