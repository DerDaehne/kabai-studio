import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createProject } from '$lib/server/domain/board';
import { DomainError, type Actor } from '$lib/server/domain/core';
import { OPEN_QUESTION, projectRef } from '$lib/server/live';
import { LIVE_DEPENDENCY } from '$lib/shell/live.svelte';
import type { ProjectRef } from '$lib/shell/shell.svelte';
import type { Actions, PageServerLoad } from './$types';

const HUMAN: Actor = { kind: 'user' };

export type ProjectRow = ProjectRef & { columns: number; openQuestions: number; archived: boolean };

/** The form field a domain error of `createProject` concerns. */
const FIELD_OF: Record<string, 'name' | 'key'> = {
	empty_name: 'name',
	name_taken: 'name',
	invalid_key: 'key',
	key_taken: 'key'
};

const PROJECTS = `
	SELECT p.id, p.key, p.name, p.archived,
		(SELECT count(*) FROM columns c WHERE c.project_id = p.id) AS columns,
		(SELECT count(*) FROM questions q JOIN tickets t ON t.id = q.ticket_id
			WHERE t.project_id = p.id AND ${OPEN_QUESTION}) AS openQuestions
	FROM projects p ORDER BY p.key`;

type Row = { id: number; key: string; name: string; archived: 0 | 1 } & Pick<
	ProjectRow,
	'columns' | 'openQuestions'
>;

// Creating a project or answering a question elsewhere reloads the live state, and this list with it.
export const load: PageServerLoad = ({ depends }) => {
	depends(LIVE_DEPENDENCY);
	const rows = db().prepare(PROJECTS).all() as Row[];
	return {
		projects: rows.map((row): ProjectRow => ({
			...projectRef(row),
			columns: row.columns,
			openQuestions: row.openQuestions,
			archived: row.archived === 1
		}))
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const key = String(form.get('key') ?? '')
			.trim()
			.toUpperCase();
		try {
			createProject(db(), HUMAN, { key, name });
		} catch (err) {
			if (!(err instanceof DomainError)) throw err;
			const message = `${err.message} Ausweg: ${err.hint}`;
			return fail(400, { field: FIELD_OF[err.code] ?? 'name', message, name, key });
		}
		redirect(303, `/p/${key}`);
	}
};
