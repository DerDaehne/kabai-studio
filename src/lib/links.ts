/** The facets of a Run-Akte in their fixed order; the address names one with `?facet=`. */
export const TICKET_FACETS = ['frage', 'spur', 'akte', 'runs'] as const;
export type TicketFacet = (typeof TICKET_FACETS)[number];

export const isTicketFacet = (value: unknown): value is TicketFacet =>
	TICKET_FACETS.some((facet) => facet === value);

/** The address of a ticket's Run-Akte, optionally pinned to one run and opened on one facet. */
export function ticketHref(
	key: string,
	number: number | string,
	options: { run?: number | null; facet?: TicketFacet } = {}
): string {
	const query = new URLSearchParams();
	if (options.run) query.set('run', String(options.run));
	if (options.facet) query.set('facet', options.facet);
	const search = query.size ? `?${query}` : '';
	return `/p/${key}/t/${number}${search}`;
}

/** Whether a path lies in a Run-Akte; the one pattern that goes with {@link ticketHref}. */
export const isTicketPath = (path: string): boolean => /^\/p\/[^/]+\/t\/\d+/.test(path);

/**
 * The facet in front when a Run-Akte opens: the one `?facet=` names when the ticket has it, else the open question,
 * else the trace of the run `?run=` names, else the file itself.
 */
export function openingFacet(search: URLSearchParams, hasQuestion: boolean): TicketFacet {
	const named = search.get('facet');
	if (isTicketFacet(named) && (named !== 'frage' || hasQuestion)) return named;
	if (hasQuestion) return 'frage';
	return search.has('run') ? 'spur' : 'akte';
}
