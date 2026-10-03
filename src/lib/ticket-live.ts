/** Whether a live event (of any project, any type) is about this one ticket, for the Run-Akte's live reload. */
export const concernsTicket = (event: Record<string, unknown>, ticketId: number): boolean =>
	event.ticketId === ticketId;
