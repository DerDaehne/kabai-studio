import { redirect } from '@sveltejs/kit';
import { LIVE_DEPENDENCY, type ProjectRef } from '$lib/live';
import { db } from '$lib/server/db';
import { domainFail } from '$lib/server/domain-failure';
import { createProject } from '$lib/server/domain/board';
import { DEFAULT_VARIANT } from '$lib/variant';
import type { Actor } from '$lib/server/domain/core';
import { VARIANTS } from '$lib/server/domain/variants';
import type { Step, Variant } from '$lib/variant';
import { OPEN_QUESTION, projectRef } from '$lib/server/live';
import type { Actions, PageServerLoad } from './$types';

const HUMAN: Actor = { kind: 'user' };

export type ProjectRow = ProjectRef & {
	variant: Variant;
	openQuestions: number;
	archived: boolean;
};

/** The form field a domain error of `createProject` concerns. */
const FIELD_OF: Record<string, 'name' | 'key' | 'variant'> = {
	empty_name: 'name',
	name_taken: 'name',
	invalid_key: 'key',
	key_taken: 'key',
	invalid_variant: 'variant'
};

const PROJECTS = `
	SELECT p.id, p.key, p.name, p.archived, p.variant,
		(SELECT count(*) FROM questions q JOIN tickets t ON t.id = q.ticket_id
			WHERE t.project_id = p.id AND ${OPEN_QUESTION}) AS openQuestions
	FROM projects p ORDER BY p.key`;

type Row = { id: number; key: string; name: string; archived: 0 | 1 } & Pick<
	ProjectRow,
	'variant' | 'openQuestions'
>;

const variantSteps = (): { variant: Variant; steps: readonly Step[] }[] =>
	(Object.keys(VARIANTS) as Variant[]).map((variant) => ({ variant, steps: VARIANTS[variant] }));

// Creating a project or answering a question elsewhere reloads the live state, and this list with it.
export const load: PageServerLoad = ({ depends }) => {
	depends(LIVE_DEPENDENCY);
	const rows = db().prepare(PROJECTS).all() as Row[];
	return {
		variants: variantSteps(),
		projects: rows.map((row): ProjectRow => ({
			...projectRef(row),
			variant: row.variant,
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
		const variant = String(form.get('variant') ?? DEFAULT_VARIANT);
		try {
			// the domain rejects an unknown value; the cast only lets it reach that check
			createProject(db(), HUMAN, { key, name }, variant as Variant);
		} catch (err) {
			return domainFail(err, (e) => ({
				field: FIELD_OF[e.code] ?? 'name',
				message: `${e.message} Ausweg: ${e.hint}`,
				name,
				key,
				variant
			}));
		}
		redirect(303, `/p/${key}`);
	}
};
