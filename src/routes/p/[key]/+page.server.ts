import { error, fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { createTicket } from '$lib/server/domain/board';
import { DomainError, type Actor } from '$lib/server/domain/core';
import { projectRef } from '$lib/server/live';
import type { ProjectRef } from '$lib/shell/shell.svelte';
import type { Actions, PageServerLoad } from './$types';

const HUMAN: Actor = { kind: 'user' };

export type ProjectPage = { project: ProjectRef; columns: { name: string; role: string }[] };

function requireProject(key: string) {
	const row = db().prepare('SELECT id, key, name FROM projects WHERE key = ?').get(key) as
		{ id: number; key: string; name: string } | undefined;
	if (!row) error(404, `Ein Projekt ${key} gibt es nicht.`);
	return row;
}

// ponytail: name and columns only, no tickets; the board's ticket list replaces this page once it exists.
export const load: PageServerLoad = ({ params }): ProjectPage => {
	const project = requireProject(params.key);
	const columns = db()
		.prepare(
			'SELECT name, role_prompt AS role FROM columns WHERE project_id = ? ORDER BY position, id'
		)
		.all(project.id) as ProjectPage['columns'];
	return { project: projectRef(project), columns };
};

export const actions: Actions = {
	createTicket: async ({ request, params }) => {
		const project = requireProject(params.key);
		const title = String((await request.formData()).get('title') ?? '');
		let number: number;
		try {
			number = createTicket(db(), HUMAN, project.id, { title }).number;
		} catch (err) {
			if (!(err instanceof DomainError)) throw err;
			return fail(400, { title, message: `${err.message} Ausweg: ${err.hint}` });
		}
		redirect(303, `/p/${project.key}/t/${number}`);
	}
};
