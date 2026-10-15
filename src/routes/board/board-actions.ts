import type { ActionResult } from '@sveltejs/kit';
import { failureOf, postAction } from '$lib/form-action';

export type Intent = 'start' | 'accept' | 'giveBack';

/** Moves the ticket; returns the domain's refusal with its way out, if there is one. */
export async function moveTo(ticketId: number, columnId: number): Promise<string | undefined> {
	const fields = { ticketId: String(ticketId), columnId: String(columnId) };
	return failureOf(await postAction('/board?/move', fields));
}

/** Runs one of the human's intents; a refusal comes back as its message with the way out. */
export async function intend(
	ticketId: number,
	action: Intent,
	fields: Record<string, string> = {}
): Promise<{ failure: string } | { result: ActionResult }> {
	const result = await postAction(`/board?/${action}`, { ticketId: String(ticketId), ...fields });
	const failure = failureOf(result);
	return failure ? { failure } : { result };
}

export type Creation = { failure: string } | { ref: string };

export async function create(
	projectId: number,
	title: string,
	columnId?: number
): Promise<Creation> {
	const fields: Record<string, string> = { projectId: String(projectId), title };
	if (columnId) fields.columnId = String(columnId);
	const result = await postAction('/board?/create', fields);
	const failure = failureOf(result);
	if (failure) return { failure };
	return { ref: result.type === 'success' ? String(result.data?.ref) : '' };
}

export async function retitle(ticketId: number, title: string): Promise<string | undefined> {
	return failureOf(await postAction('/board?/rename', { ticketId: String(ticketId), title }));
}

export async function deleteForGood(ticketId: number): Promise<string | undefined> {
	return failureOf(await postAction('/board?/delete', { ticketId: String(ticketId) }));
}
