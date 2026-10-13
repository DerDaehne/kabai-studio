/** Every step a column can be; `columns.step` holds one, and the database derives the phase from it. */
export type Step =
	| 'backlog'
	| 'refine'
	| 'plan'
	| 'implement'
	| 'research'
	| 'draft'
	| 'critique'
	| 'acceptance'
	| 'done';
export type Variant = 'software' | 'knowledge' | 'direct';

export const DEFAULT_VARIANT: Variant = 'software';
