import { error, redirect } from '@sveltejs/kit';
import { domainFail } from '$lib/server/domain-failure';
import * as board from '$lib/server/domain/board';
import { tx, type Actor } from '$lib/server/domain/core';
import { db } from '$lib/server/db';
import { createRun, prioritizeRun } from '$lib/server/domain/runs';
import { runner } from '$lib/server/runner';
import {
	findTicketId,
	isRunOf,
	runStart,
	runTabs,
	runTrace,
	ticketDetail
} from '$lib/server/ticket-view';
import { LIVE_DEPENDENCY } from '$lib/shell/live.svelte';
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

export const load: PageServerLoad = ({ params, url, depends }) => {
	const id = requireTicketId(params);
	// a reconnect reloads the live state; the trace has no replay of the run events it missed, so it reloads with it
	depends(ticketDependency(id), LIVE_DEPENDENCY);
	const ticket = ticketDetail(db(), HUMAN, id);
	return {
		ticket,
		trace: selectedTrace(id, url),
		runs: runTabs(db(), id),
		start: runStart(db(), ticket.project.id)
	};
};

const notThisTicketsRun = (run: string): never =>
	error(404, `Run ${run} gehört nicht zu diesem Ticket.`);

/** The run `?run=<id>` names (what a run tab links to), otherwise the ticket's newest; none before its first run. */
function selectedTrace(ticketId: number, url: URL) {
	const selected = url.searchParams.get('run');
	if (selected === null) return runTrace(db(), ticketId);
	const trace = /^\d+$/.test(selected) ? runTrace(db(), ticketId, Number(selected)) : undefined;
	if (!trace) notThisTicketsRun(selected);
	return trace;
}

/**
 * Runs a mutation; a rule violation becomes a form error with message and hint instead of a crash (errors offer
 * a way out). `action` tags the failure so the page shows it only at the form that caused it — several forms
 * share one `form` prop.
 */
function mutate(action: string, fn: () => void) {
	try {
		fn();
	} catch (err) {
		return domainFail(err, (e) => ({ action, code: e.code, message: e.message, hint: e.hint }));
	}
}

const field = (form: FormData, name: string) => String(form.get(name) ?? '');

/** A run the human starts goes ahead of background work in the queue; both steps or neither. */
function startForHuman(ticketId: number, profileId: number) {
	tx(db(), () => {
		const { id } = createRun(db(), HUMAN, { ticketId, profileId });
		prioritizeRun(db(), HUMAN, id);
	});
}

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
	start: async ({ request, params, url }) => {
		const id = requireTicketId(params);
		const profileId = Number(field(await request.formData(), 'profileId'));
		const refused = mutate('start', () => startForHuman(id, profileId));
		if (refused) return refused;
		redirect(303, url.pathname); // without ?run= the trace shows the newest run, the one just started
	},
	stop: async ({ request, params }) => {
		const id = requireTicketId(params);
		const runId = field(await request.formData(), 'runId');
		if (!isRunOf(db(), id, Number(runId))) notThisTicketsRun(runId);
		return mutate('stop', () => runner().cancel(Number(runId), HUMAN));
	},
	delete: async ({ params }) => {
		const id = requireTicketId(params);
		board.deleteTicket(db(), HUMAN, id);
		redirect(303, '/board');
	}
};
