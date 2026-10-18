import { error, redirect } from '@sveltejs/kit';
import type { ProjectRef } from '$lib/live';
import { ticketHref } from '$lib/links';
import { db } from '$lib/server/db';
import { domainFail } from '$lib/server/domain-failure';
import { createTicket } from '$lib/server/domain/board';
import type { Actor } from '$lib/server/domain/core';
import { VARIANTS, type Step, type Variant } from '$lib/server/domain/variants';
import { projectRef } from '$lib/server/live';
import type { Actions, PageServerLoad } from './$types';

const HUMAN: Actor = { kind: 'user' };

export type ProjectPage = { project: ProjectRef; variant: Variant; steps: readonly Step[] };

function requireProject(key: string) {
	const row = db().prepare('SELECT id, key, name, variant FROM projects WHERE key = ?').get(key) as
		{ id: number; key: string; name: string; variant: Variant } | undefined;
	if (!row) error(404, `Ein Projekt ${key} gibt es nicht.`);
	return row;
}

// ponytail: name and steps only, no tickets; the board's ticket list replaces this page once it exists.
export const load: PageServerLoad = ({ params }): ProjectPage => {
	const project = requireProject(params.key);
	return {
		project: projectRef(project),
		variant: project.variant,
		steps: VARIANTS[project.variant]
	};
};

export const actions: Actions = {
	createTicket: async ({ request, params }) => {
		const project = requireProject(params.key);
		const title = String((await request.formData()).get('title') ?? '');
		let number: number;
		try {
			number = createTicket(db(), HUMAN, project.id, { title }).number;
		} catch (err) {
			return domainFail(err, (e) => ({ title, message: `${e.message} Ausweg: ${e.hint}` }));
		}
		redirect(303, ticketHref(project.key, number));
	}
};
