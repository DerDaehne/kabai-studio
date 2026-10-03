import { error, fail, redirect } from '@sveltejs/kit';
import * as board from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import { DomainError } from '$lib/server/domain/error';
import { db } from '$lib/server/db';
import { findTicketId, ticketDetail } from '$lib/server/ticket-view';
import type { Actions, PageServerLoad } from './$types';

// Studio has one owner account; every action in the Run-Akte acts for the human (see CLAUDE.md "Architecture guardrails").
const HUMAN: Actor = { kind: 'user' };

/** The dependency the ticket page's load registers, so a matching live event can `invalidate()` it by id alone. */
const ticketDependency = (id: number) => `studio:ticket:${id}`;

function requireTicketId(params: { key: string; number: string }): number {
	const number = Number(params.number);
	const id = Number.isInteger(number) ? findTicketId(db(), params.key, number) : undefined;
	if (id === undefined) error(404, `Ticket ${params.key}-${params.number} gibt es nicht.`);
	return id;
}

export const load: PageServerLoad = ({ params, depends }) => {
	const id = requireTicketId(params);
	depends(ticketDependency(id));
	return { ticket: ticketDetail(db(), HUMAN, id) };
};

/**
 * Runs a mutation; a rule violation becomes a form error with message and hint instead of a crash (UX 5). `action`
 * tags the failure so the page shows it only at the form that caused it — several forms share one `form` prop.
 */
function mutate(action: string, fn: () => void) {
	try {
		fn();
	} catch (err) {
		if (err instanceof DomainError)
			return fail(400, { action, code: err.code, message: err.message, hint: err.hint });
		throw err;
	}
}

const field = (form: FormData, name: string) => String(form.get(name) ?? '');

export const actions: Actions = {
	update: async ({ request, params }) => {
		const id = requireTicketId(params);
		const form = await request.formData();
		return mutate('update', () =>
			board.updateTicket(db(), HUMAN, id, {
				title: field(form, 'title'),
				description: field(form, 'description')
			})
		);
	},
	addTask: async ({ request, params }) => {
		const id = requireTicketId(params);
		const title = field(await request.formData(), 'title');
		return mutate('addTask', () => board.addTask(db(), HUMAN, id, title));
	},
	completeTask: async ({ request }) => {
		const taskId = Number(field(await request.formData(), 'taskId'));
		return mutate('completeTask', () => board.completeTask(db(), HUMAN, taskId));
	},
	reopenTask: async ({ request }) => {
		const taskId = Number(field(await request.formData(), 'taskId'));
		return mutate('reopenTask', () => board.reopenTask(db(), HUMAN, taskId));
	},
	renameTask: async ({ request }) => {
		const form = await request.formData();
		const taskId = Number(field(form, 'taskId'));
		return mutate('taskDialog', () =>
			board.updateTask(db(), HUMAN, taskId, field(form, 'title'), field(form, 'reason'))
		);
	},
	deleteTask: async ({ request }) => {
		const form = await request.formData();
		const taskId = Number(field(form, 'taskId'));
		return mutate('taskDialog', () => board.deleteTask(db(), HUMAN, taskId, field(form, 'reason')));
	},
	addComment: async ({ request, params }) => {
		const id = requireTicketId(params);
		const body = field(await request.formData(), 'body');
		return mutate('addComment', () => board.addComment(db(), HUMAN, id, body));
	},
	move: async ({ request, params }) => {
		const id = requireTicketId(params);
		const columnId = Number(field(await request.formData(), 'columnId'));
		return mutate('move', () => board.moveTicket(db(), HUMAN, id, columnId));
	},
	delete: async ({ params }) => {
		const id = requireTicketId(params);
		board.deleteTicket(db(), HUMAN, id);
		redirect(303, '/board');
	}
};
