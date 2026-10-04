/** Whether a live event (of any project, any type) is about this one ticket, for the Run-Akte's live reload. */
export const concernsTicket = (event: Record<string, unknown>, ticketId: number): boolean =>
	event.ticketId === ticketId;

// The trace streams run events and phases itself; reloading the ticket for each would fetch it again every second.
const STREAMED_INTO_TRACE = new Set(['run.event', 'run.phase']);

/** Whether a live event changes what the Run-Akte loads for this ticket, so that it reloads. */
export const reloadsTicket = (event: Record<string, unknown>, ticketId: number): boolean =>
	concernsTicket(event, ticketId) && !STREAMED_INTO_TRACE.has(event.type as string);

/** Whether a live event changes what the board shows; the run events and phases of a working agent do not. */
export const reloadsBoard = (event: Record<string, unknown>): boolean =>
	!STREAMED_INTO_TRACE.has(event.type as string);
