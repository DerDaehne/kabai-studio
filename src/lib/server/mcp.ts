import {
	createMcpHandler,
	fromJsonSchema,
	McpServer,
	type AuthInfo,
	type CallToolResult,
	type JsonSchemaType,
	type StandardSchemaWithJSON
} from '@modelcontextprotocol/server';
import type { DatabaseSync } from 'node:sqlite';
import * as board from './domain/board';
import { DomainError, tx, type Actor } from './domain/core';
import { once } from './domain/idempotency';
import * as notes from './domain/notes';
import { collectAnswer, requestHuman, type QuestionOption } from './domain/questions';
import { runForToken } from './domain/runs';
import { mask } from './secrets';

/** Who calls the tools and what they may touch. Each endpoint builds it per request from its own authentication. */
type ToolContext = {
	actor: Actor;
	/** Reads stay within this project. */
	projectId: number;
	/** "Your ticket": the only ticket the tools write to, and what get_ticket shows by default. */
	ticketId: number;
};
type ToolError = { error: string; message: string; hint: string };
type ChildTicket = { ref?: string; title: string; description?: string; tasks?: string[]; waits_for?: string[] };
type AgentMove = { columnId: number; name: string; refusals: ToolError[] };

const RECENT_COMMENTS = 10;
const COMMENT_PREVIEW = 1500;
const MAX_TEXT = 20_000;
const MAX_TITLE = 200;
const MAX_ITEMS = 50;
const MAX_REF = 20;
const MAX_SLUG = 100;
const UNAUTHORIZED = {
	error: 'unauthorized',
	hint: 'Sende den Run-Token als „Authorization: Bearer <token>“. Ein Token gilt nur, solange sein Run läuft.'
};

/** A refusal that is already phrased for the agent: tool names and concrete ids instead of domain function names. */
class Refusal extends Error {
	readonly body: ToolError;

	constructor(body: ToolError) {
		super(body.message);
		this.body = body;
	}
}

const object = (properties: Record<string, JsonSchemaType>, required?: string[]): JsonSchemaType => ({
	type: 'object',
	properties,
	...(required && { required }),
	additionalProperties: false
});
const text = (maxLength: number): JsonSchemaType => ({ type: 'string', minLength: 1, maxLength });
const list = (items: JsonSchemaType): JsonSchemaType => ({ type: 'array', items, minItems: 1, maxItems: MAX_ITEMS });
const tags: JsonSchemaType = { type: 'array', items: text(50), maxItems: 20 };
const idempotencyKey: JsonSchemaType = { ...text(100), description: 'retry-safe: a repeat with this key returns the first result' };
type Idempotent = { idempotency_key?: string };

type ToolDefinition<Args> = { description: string; inputSchema: StandardSchemaWithJSON<Args, Args> };
const define = <Args>(description: string, schema: JsonSchemaType): ToolDefinition<Args> => ({ description, inputSchema: fromJsonSchema<Args>(schema) });

// Built once per process: the SDK caches one compiled validator per schema object and never evicts it.
const TOOLS = {
	get_ticket: define<{ ticket?: string; comment?: number }>(
		"Your ticket: tasks, recent comments, relations, allowed moves, the human's latest answer. Another ticket of your project by ref; one full comment by id.",
		object({ ticket: { type: 'string', maxLength: MAX_REF, description: 'e.g. STU-12; default: your ticket' }, comment: { type: 'integer' } })
	),
	create_child_tickets: define<{ items: ChildTicket[] } & Idempotent>(
		'Create child tickets of your ticket, all or none. waits_for: tickets like STU-3, or $ref of an item in this call.',
		object(
			{
				items: list(
					object(
						{
							ref: { type: 'string', maxLength: MAX_REF, description: 'local name, used as $ref' },
							title: text(MAX_TITLE),
							description: { type: 'string', maxLength: MAX_TEXT },
							tasks: list(text(MAX_TITLE)),
							waits_for: list({ type: 'string', maxLength: MAX_REF + 1 })
						},
						['title']
					)
				),
				idempotency_key: idempotencyKey
			},
			['items']
		)
	),
	link_tickets: define<{ waits_for?: string[]; blocks?: string[] }>(
		'Link your ticket: waits_for = it waits for these tickets; blocks = these wait for it.',
		object({ waits_for: list({ type: 'string', maxLength: MAX_REF }), blocks: list({ type: 'string', maxLength: MAX_REF }) })
	),
	approve_review: define<Record<string, never>>('Approve the review of your ticket: only in a review column, never your own work.', object({})),
	list_workable: define<{ column_id?: number }>(
		'Tickets of your project that can start now: no blocks predecessor still open. Optionally one column only.',
		object({ column_id: { type: 'integer' } })
	),
	notes_search: define<{ query: string; kind?: notes.NoteKind }>(
		'Search the notes (knowledge base); words are taken literally. Returns slugs and snippets.',
		object({ query: text(200), kind: { enum: ['note', 'adr', 'hub'] } }, ['query'])
	),
	notes_get: define<{ slug: string }>('One note: body, tags, version (for notes_update), links, tickets.', object({ slug: text(MAX_SLUG) }, ['slug'])),
	notes_create: define<{ slug: string; title: string; body: string; kind?: notes.NoteKind; tags?: string[] }>(
		'Create a note in your project. [[slug]] in the body links that note.',
		object(
			{
				slug: { ...text(MAX_SLUG), description: 'kebab-case, permanent' },
				title: text(MAX_TITLE),
				body: { type: 'string', maxLength: MAX_TEXT },
				kind: { enum: ['note', 'adr', 'hub'] },
				tags
			},
			['slug', 'title', 'body']
		)
	),
	notes_update: define<{ slug: string; expected_version: number; title?: string; body?: string; tags?: string[] }>(
		'Change a note of your project (global notes are read-only). expected_version: its version from notes_get; if it moved on, someone else changed the note meanwhile.',
		object(
			{ slug: text(MAX_SLUG), expected_version: { type: 'integer' }, title: text(MAX_TITLE), body: { type: 'string', maxLength: MAX_TEXT }, tags },
			['slug', 'expected_version']
		)
	),
	notes_link: define<{ slug: string; type: notes.NoteLinkType; target: string }>(
		'Link two notes: slug <type> target, e.g. new-adr supersedes old-adr. slug (and a superseded target) must be a note of your project.',
		object({ slug: text(MAX_SLUG), type: { enum: ['references', 'contains', 'supersedes', 'contradicts'] }, target: text(MAX_SLUG) }, ['slug', 'type', 'target'])
	),
	link_note_to_ticket: define<{ slug: string; relation: Exclude<notes.NoteTicketRelation, 'verified_by'> }>(
		'Link a note to your ticket; documents = it describes what the ticket built.',
		object({ slug: text(MAX_SLUG), relation: { enum: ['documents', 'created_by', 'references'] } }, ['slug', 'relation'])
	),
	update_ticket: define<{ title?: string; description?: string; docs_required?: boolean }>(
		'Change title, description or docs_required (a linked note is needed before done) of your ticket.',
		object({ title: text(MAX_TITLE), description: { type: 'string', maxLength: MAX_TEXT }, docs_required: { type: 'boolean' } })
	),
	add_tasks: define<{ titles: string[] } & Idempotent>(
		'Add acceptance criteria as tasks to your ticket.',
		object({ titles: list(text(MAX_TITLE)), idempotency_key: idempotencyKey }, ['titles'])
	),
	complete_tasks: define<{ task_ids: number[] }>(
		'Mark tasks of your ticket done. Returns the ids still open.',
		object({ task_ids: list({ type: 'integer' }) }, ['task_ids'])
	),
	add_comment: define<{ text: string } & Idempotent>(
		'Add a work-log comment to your ticket.',
		object({ text: text(MAX_TEXT), idempotency_key: idempotencyKey }, ['text'])
	),
	move_ticket: define<{ column_id: number }>('Move your ticket to a column from allowed_moves.', object({ column_id: { type: 'integer' } }, ['column_id'])),
	request_human: define<{ question: string; options?: QuestionOption[] }>(
		'Ask the human and wait: moves your ticket to human intervention. Offer 1-3 decidable options when possible. End your turn afterwards.',
		object(
			{
				question: text(2000),
				options: {
					type: 'array',
					maxItems: 3,
					items: object({ label: text(100), effect: { type: 'string', maxLength: 200, description: 'what choosing it leads to' } }, ['label'])
				}
			},
			['question']
		)
	)
};
type ToolName = keyof typeof TOOLS;
type ArgsOf<Name extends ToolName> = (typeof TOOLS)[Name] extends ToolDefinition<infer Args> ? Args : never;

/** Serves the studio MCP endpoint. Every request authenticates with the bearer token of a running run. */
export function mcpEndpoint(db: DatabaseSync): (request: Request) => Promise<Response> {
	const handler = createMcpHandler(({ authInfo }) => studioServer(db, contextOf(authInfo)));
	return async (request) => {
		const token = /^Bearer +(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
		const run = token ? runForToken(db, token) : undefined;
		if (!token || !run) return Response.json(UNAUTHORIZED, { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
		const context: ToolContext = { actor: { kind: 'agent', runId: run.runId }, projectId: run.projectId, ticketId: run.ticketId };
		return handler.fetch(request, { authInfo: { token, clientId: `run-${run.runId}`, scopes: [], extra: context } });
	};
}

function contextOf(authInfo: AuthInfo | undefined): ToolContext {
	if (!authInfo?.extra) throw new Error('studio MCP server built without an authenticated caller');
	return authInfo.extra as ToolContext;
}

/** Secret values are masked in everything the agent reads back. */
const reply = (value: unknown, isError = false): CallToolResult => ({
	content: [{ type: 'text', text: JSON.stringify(mask(value)) }],
	...(isError && { isError })
});

function studioServer(db: DatabaseSync, ctx: ToolContext): McpServer {
	const server = new McpServer({ name: 'kabai-studio', version: '1' });

	/** Inputs are masked before they are stored, so a secret an agent pastes never lands in the database. */
	function tool<Name extends ToolName>(name: Name, work: (args: ArgsOf<Name>) => unknown) {
		server.registerTool(name, TOOLS[name] as ToolDefinition<ArgsOf<Name>>, async (args: ArgsOf<Name>) => {
			try {
				const input = mask(args);
				const { idempotency_key: key, ...request } = input as Idempotent;
				return reply(key === undefined ? work(input) : once(db, ctx.actor, key, { tool: name, ...request }, () => work(input)));
			} catch (err) {
				if (err instanceof Refusal) return reply(err.body, true);
				if (err instanceof DomainError) return reply({ error: err.code, message: err.message, hint: toolHint(db, ctx, name, err.code) ?? err.hint }, true);
				throw mask(err);
			}
		});
	}

	tool('get_ticket', ({ ticket, comment }) => (comment === undefined ? ticketView(db, ctx, ticket) : fullComment(db, ctx, comment)));

	tool('update_ticket', ({ title, description, docs_required }) => {
		board.updateTicket(db, ctx.actor, ctx.ticketId, { title, description, docs_required: docs_required === undefined ? undefined : docs_required ? 1 : 0 });
		return { ref: board.ticket(db, ctx.ticketId).ref };
	});

	tool('create_child_tickets', ({ items }) => createChildTickets(db, ctx, items));

	tool('link_tickets', ({ waits_for = [], blocks = [] }) => {
		if (!waits_for.length && !blocks.length)
			throw new Refusal({
				error: 'nothing_to_link',
				message: 'link_tickets ohne waits_for und blocks verknüpft nichts.',
				hint: 'Nenne in waits_for die Tickets, auf die dein Ticket wartet, oder in blocks die, die auf dein Ticket warten.'
			});
		return tx(db, () => {
			for (const ref of waits_for) board.linkRelation(db, ctx.actor, ticketIdOf(db, ctx, ref), ctx.ticketId, 'blocks');
			for (const ref of blocks) board.linkRelation(db, ctx.actor, ctx.ticketId, ticketIdOf(db, ctx, ref), 'blocks');
			return { ref: board.ticket(db, ctx.ticketId).ref };
		});
	});

	tool('list_workable', ({ column_id }) => workableView(db, ctx, column_id));

	tool('approve_review', () => {
		board.approveReview(db, ctx.actor, ctx.ticketId);
		return { review_approved: true };
	});

	tool('notes_search', ({ query, kind }) => ({
		notes: notes
			.searchNotes(db, query, { kind, visibleIn: ctx.projectId })
			.map((n) => ({ slug: n.slug, title: n.title, kind: n.kind, ...(n.status !== null && { status: n.status }), snippet: n.snippet, chars: n.bodyChars }))
	}));

	tool('notes_get', ({ slug }) => noteView(db, ctx, slug));

	tool('notes_create', ({ slug, title, body, kind, tags }) => {
		refuseTakenSlug(db, ctx, slug);
		const { id, warnings } = notes.createNote(db, ctx.actor, { slug, title, body, kind, tags, projectIds: [ctx.projectId] }, { visibleIn: ctx.projectId });
		return { version: noteVersion(db, id), ...(warnings.length > 0 && { warnings }) };
	});

	tool('notes_update', ({ slug, expected_version, ...patch }) => {
		const id = ownNoteIdOf(db, ctx, slug);
		const { warnings } = notes.updateNote(db, ctx.actor, id, patch, expected_version, { visibleIn: ctx.projectId });
		return { version: noteVersion(db, id), ...(warnings.length > 0 && { warnings }) };
	});

	tool('notes_link', ({ slug, type, target }) => {
		const from = ownNoteIdOf(db, ctx, slug);
		// superseding marks the target note as replaced, so it changes the target too
		const to = type === 'supersedes' ? ownNoteIdOf(db, ctx, target) : noteIdOf(db, ctx, target);
		notes.linkNote(db, ctx.actor, from, to, type);
		return { linked: true };
	});

	tool('link_note_to_ticket', ({ slug, relation }) => {
		notes.linkTicket(db, ctx.actor, noteIdOf(db, ctx, slug), ctx.ticketId, relation);
		return { linked: true };
	});

	tool('add_tasks', ({ titles }) => ({ task_ids: board.addTasks(db, ctx.actor, ctx.ticketId, titles).ids }));

	tool('complete_tasks', ({ task_ids }) => {
		board.completeTasks(db, ctx.actor, ctx.ticketId, task_ids);
		return { open_task_ids: openTaskIds(db, ctx.ticketId) };
	});

	tool('add_comment', ({ text }) => ({ comment_id: board.addComment(db, ctx.actor, ctx.ticketId, text).id }));

	tool('move_ticket', ({ column_id }) => moveOwnTicket(db, ctx, column_id));

	tool('request_human', (q) => {
		const { id, column } = requestHuman(db, ctx.actor, ctx.ticketId, q);
		return { question_id: id, column };
	});

	return server;
}

/** Tool-level way out for domain errors whose domain hint names domain functions or does not fit the calling tool. */
function toolHint(db: DatabaseSync, ctx: ToolContext, tool: ToolName, code: string): string | undefined {
	switch (code) {
		case 'requires_human':
			return tool === 'request_human'
				? 'Das Ticket kann nur der Mensch verschieben; stell deine Frage mit add_comment.'
				: 'Diesen Schritt macht nur der Mensch. Lass das Ticket, wo es ist; brauchst du eine Entscheidung, frag mit request_human.';
		case 'open_tasks':
			return `Schließe die Tasks mit complete_tasks ab: task_ids [${openTaskIds(db, ctx.ticketId).join(', ')}].`;
		case 'open_children':
			return 'Erst müssen die Kind-Tickets fertig sein; hängt es an ihnen, frag mit request_human.';
		case 'docs_required':
			return 'Vor dem Abschluss muss eine Note mit dem Ticket verknüpft sein; bitte den Menschen mit request_human darum.';
		case 'transition_not_allowed':
			return 'get_ticket zeigt die erreichbaren Spalten unter allowed_moves.';
		case 'not_in_review':
			return 'Freigeben gehört zur Review-Rolle; halte dein Ergebnis mit add_comment fest.';
		case 'self_approval':
			return 'Eigene Arbeit gibt ein anderer Run oder der Mensch frei; halte dein Ergebnis mit add_comment fest.';
		case 'conflict':
			return 'Lies die Note mit notes_get neu und wende deine Änderung auf deren aktuelle version an.';
		case 'cycle':
			return 'Prüfe die Richtung von waits_for und blocks: Ein Ticket kann nicht, auch nicht über andere, auf sich selbst warten.';
	}
}

const openTaskIds = (db: DatabaseSync, ticketId: number) =>
	db
		.prepare('SELECT id FROM tasks WHERE ticket_id = ? AND done_at IS NULL ORDER BY position, id')
		.all(ticketId)
		.map((r) => r.id as number);

/** Domain moves plus the rule only agents get: a blocked ticket must not enter a work column. */
function agentMoves(db: DatabaseSync, ctx: ToolContext): AgentMove[] {
	const waitingFor = board.blockingPredecessors(db, ctx.ticketId);
	return board.allowedMoves(db, ctx.ticketId, ctx.actor).map((m) => ({
		columnId: m.columnId,
		name: m.name,
		refusals: [
			...(m.kind === 'normal' && waitingFor.length ? [blockedRefusal(db, ctx, waitingFor)] : []),
			...m.blockers.map((b) => ({ error: b.code, message: b.message, hint: toolHint(db, ctx, 'move_ticket', b.code) ?? b.hint }))
		]
	}));
}

function blockedRefusal(db: DatabaseSync, ctx: ToolContext, waitingFor: board.Predecessor[]): ToolError {
	const { setting } = db.prepare('SELECT blocks_satisfied_at AS setting FROM projects WHERE id = ?').get(ctx.projectId) as { setting: 'done' | 'review_ok' };
	const refs = waitingFor.map((p) => p.ref).join(', ');
	return {
		error: 'blocked',
		message: `${board.ticket(db, ctx.ticketId).ref} wartet auf ${refs} (blocks_satisfied_at = ${setting}).`,
		hint:
			`Ein Vorgänger gilt als erledigt, sobald er in einer done-Spalte liegt${setting === 'review_ok' ? ' oder freigegeben ist' : ''}. ` +
			`Agents starten keine blockierten Tickets: warte auf ${refs} oder frag mit request_human.`
	};
}

function moveOwnTicket(db: DatabaseSync, ctx: ToolContext, columnId: number) {
	const own = board.ticket(db, ctx.ticketId);
	if (own.column_id === columnId) return { column: own.column_name };
	const moves = agentMoves(db, ctx);
	const move = moves.find((m) => m.columnId === columnId);
	if (!move)
		throw new Refusal({
			error: 'transition_not_allowed',
			message: `Spalte ${columnId} ist von „${own.column_name}“ aus nicht erreichbar.`,
			hint: `Erreichbar: ${moves.map((m) => `column_id ${m.columnId} (${m.name})`).join(', ')}.`
		});
	if (move.refusals.length)
		throw new Refusal({
			error: move.refusals[0].error,
			message: move.refusals.map((r) => r.message).join(' '),
			hint: move.refusals.map((r) => r.hint).join(' ')
		});
	board.moveTicket(db, ctx.actor, ctx.ticketId, columnId);
	return { column: move.name };
}

/** Creates all children with their tasks first, then the blocks relations, so a $ref may point to a later item. */
function createChildTickets(db: DatabaseSync, ctx: ToolContext, items: ChildTicket[]) {
	return tx(db, () => {
		const idByRef = new Map<string, number>();
		const ids = items.map((item, index) =>
			forItem(index, () => {
				if (item.ref !== undefined && idByRef.has(item.ref))
					throw new Refusal({ error: 'duplicate_ref', message: `ref „${item.ref}“ kommt mehrfach vor.`, hint: 'Gib jedem Item einen eigenen ref.' });
				const { id } = board.createTicket(db, ctx.actor, ctx.projectId, { title: item.title, description: item.description });
				if (item.tasks) board.addTasks(db, ctx.actor, id, item.tasks);
				board.linkRelation(db, ctx.actor, ctx.ticketId, id, 'parent_of');
				if (item.ref !== undefined) idByRef.set(item.ref, id);
				return id;
			})
		);
		items.forEach((item, index) =>
			forItem(index, () => {
				for (const predecessor of item.waits_for ?? []) board.linkRelation(db, ctx.actor, localOrTicketId(db, ctx, idByRef, predecessor), ids[index], 'blocks');
			})
		);
		return { refs: ids.map((id) => board.ticket(db, id).ref) };
	});
}

/** At most MAX_ITEMS tickets, so a large backlog does not flood a small model's context; `more` says what was left out. */
function workableView(db: DatabaseSync, ctx: ToolContext, columnId?: number) {
	const columnName = new Map(db.prepare('SELECT id, name FROM columns WHERE project_id = ?').all(ctx.projectId).map((c) => [c.id as number, c.name as string]));
	const rows = board.workableTickets(db, ctx.projectId, columnId);
	return {
		tickets: rows.slice(0, MAX_ITEMS).map((t) => ({ ref: t.ref, title: t.title, column: columnName.get(t.column_id), ...(t.assignee && { assignee: t.assignee }) })),
		...(rows.length > MAX_ITEMS && { more: rows.length - MAX_ITEMS })
	};
}

/** Names the item a refusal concerns, so the agent knows which one to fix. */
function forItem<T>(index: number, work: () => T): T {
	try {
		return work();
	} catch (err) {
		const where = `items[${index}]: `;
		if (err instanceof Refusal) throw new Refusal({ ...err.body, message: where + err.body.message });
		if (err instanceof DomainError) throw new DomainError(err.code, where + err.message, err.hint);
		throw err;
	}
}

function localOrTicketId(db: DatabaseSync, ctx: ToolContext, idByRef: Map<string, number>, ref: string): number {
	if (!ref.startsWith('$')) return ticketIdOf(db, ctx, ref);
	const id = idByRef.get(ref.slice(1));
	if (id === undefined)
		throw new Refusal({
			error: 'unknown_ref',
			message: `„${ref}“ ist kein ref eines Items in diesem Aufruf.`,
			hint: `Gib dem Item, auf das gewartet wird, ref: "${ref.slice(1)}", oder nenne ein vorhandenes Ticket wie „STU-12“.`
		});
	return id;
}

/** A ticket ref is only resolved within the caller's project, so "OTH-1" never silently reads STU-1. */
function ticketIdOf(db: DatabaseSync, ctx: ToolContext, ref: string): number {
	const { key } = db.prepare('SELECT key FROM projects WHERE id = ?').get(ctx.projectId) as { key: string };
	const [, refKey, number] = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(ref.trim()) ?? [];
	const found =
		refKey?.toUpperCase() === key
			? (db.prepare('SELECT id FROM tickets WHERE project_id = ? AND number = ?').get(ctx.projectId, Number(number)) as { id: number } | undefined)
			: undefined;
	if (!found)
		throw new Refusal({
			error: 'not_found',
			message: `„${ref}“ ist kein Ticket deines Projekts ${key}.`,
			hint: `Lesbar sind die Tickets aus ${key}, per Referenz wie „${key}-12“.`
		});
	return found.id;
}

const RELATION_KEYS: Record<string, string> = {
	'blocks:in': 'waits_for',
	'blocks:out': 'blocks',
	'parent_of:in': 'parent',
	'parent_of:out': 'children',
	'relates_to:in': 'related',
	'relates_to:out': 'related',
	'duplicate_of:out': 'duplicate_of',
	'duplicate_of:in': 'duplicated_by'
};

/** Relations named from this ticket's point of view, so their direction cannot be misread. Other projects show only the ref. */
function relationsOf(db: DatabaseSync, ctx: ToolContext, ticketId: number) {
	const blocking = new Set(board.blockingPredecessors(db, ticketId).map((p) => p.id));
	const rows = db
		.prepare(
			`SELECT r.type, r.from_ticket_id = ?1 AS outgoing, o.id, o.project_id, op.key || '-' || o.number AS ref, o.title, oc.name AS "column"
			FROM ticket_relations r JOIN tickets o ON o.id = iif(r.from_ticket_id = ?1, r.to_ticket_id, r.from_ticket_id)
			JOIN projects op ON op.id = o.project_id JOIN columns oc ON oc.id = o.column_id
			WHERE ?1 IN (r.from_ticket_id, r.to_ticket_id) ORDER BY o.project_id, o.number`
		)
		.all(ticketId) as { type: string; outgoing: 0 | 1; id: number; project_id: number; ref: string; title: string; column: string }[];
	const relations: Record<string, object[]> = {};
	for (const r of rows) {
		const key = RELATION_KEYS[`${r.type}:${r.outgoing ? 'out' : 'in'}`];
		const other = r.project_id === ctx.projectId ? { ref: r.ref, title: r.title, column: r.column } : { ref: r.ref, other_project: true };
		(relations[key] ??= []).push(key === 'waits_for' ? { ...other, blocking: blocking.has(r.id) } : other);
	}
	return relations;
}

/** Notes resolve by slug among the caller's project notes and the global ones, so a note of another project stays out of reach. */
function noteIdOf(db: DatabaseSync, ctx: ToolContext, slug: string): number {
	const id = visibleNoteId(db, ctx, slug);
	if (id === undefined)
		throw new Refusal({
			error: 'not_found',
			message: `Eine Note „${slug}“ gibt es in deinem Projekt nicht.`,
			hint: 'notes_search findet vorhandene Notes; eine neue legst du mit notes_create an.'
		});
	return id;
}

const visibleNoteId = (db: DatabaseSync, ctx: ToolContext, slug: string) =>
	(db.prepare(`SELECT id FROM notes n WHERE slug = ?1 AND ${notes.noteVisibleIn('?2')}`).get(slug, ctx.projectId) as { id: number } | undefined)?.id;

const isOwnNote = (db: DatabaseSync, ctx: ToolContext, noteId: number) =>
	db.prepare('SELECT 1 FROM note_projects WHERE note_id = ? AND project_id = ?').get(noteId, ctx.projectId) !== undefined;

/** A run changes only notes of its own project; the global ones belong to the human and stay read-only for runs. */
function ownNoteIdOf(db: DatabaseSync, ctx: ToolContext, slug: string): number {
	const id = noteIdOf(db, ctx, slug);
	if (!isOwnNote(db, ctx, id))
		throw new Refusal({
			error: 'note_read_only',
			message: `Die Note „${slug}“ ist global; ein Run ändert nur Notes seines Projekts.`,
			hint: 'Lesen und verweisen darfst du; eine Änderung schlägst du dem Menschen mit request_human vor.'
		});
	return id;
}

/** Names a taken slug without the internal note id, with a way out that fits what the run may do with that note. */
function refuseTakenSlug(db: DatabaseSync, ctx: ToolContext, slug: string) {
	if (!db.prepare('SELECT 1 FROM notes WHERE slug = ?').get(slug)) return;
	const id = visibleNoteId(db, ctx, slug);
	if (id === undefined)
		throw new Refusal({ error: 'slug_taken', message: `Der Slug „${slug}“ ist schon vergeben.`, hint: 'Wähle einen anderen Slug, der dein Thema genauer benennt.' });
	if (isOwnNote(db, ctx, id))
		throw new Refusal({ error: 'slug_taken', message: `Die Note „${slug}“ gibt es schon.`, hint: 'Lies sie mit notes_get und ändere sie mit notes_update.' });
	throw new Refusal({
		error: 'slug_taken',
		message: `Die Note „${slug}“ gibt es schon als globale Note.`,
		hint: 'Lies sie mit notes_get; eine Änderung schlägst du dem Menschen mit request_human vor, sonst wähle einen anderen Slug.'
	});
}

const noteVersion = (db: DatabaseSync, noteId: number) => (db.prepare('SELECT version FROM notes WHERE id = ?').get(noteId) as { version: number }).version;

const NOTE_LINK_KEYS: Record<string, string> = {
	'references:out': 'references',
	'references:in': 'referenced_by',
	'contains:out': 'contains',
	'contains:in': 'contained_in',
	'supersedes:out': 'supersedes',
	'supersedes:in': 'superseded_by',
	'contradicts:out': 'contradicts',
	'contradicts:in': 'contradicted_by'
};

type NoteRow = { slug: string; title: string; kind: string; status: string | null; archived: 0 | 1; tags: string[]; version: number; body: string };

/** A note with its links named from its own point of view, like the relations of a ticket. */
function noteView(db: DatabaseSync, ctx: ToolContext, slug: string) {
	const id = noteIdOf(db, ctx, slug);
	const n = notes.getNote(db, id) as NoteRow;
	const links = db
		.prepare(
			`SELECT l.type, l.from_note_id = ?1 AS outgoing, n.slug FROM note_links l JOIN notes n ON n.id = iif(l.from_note_id = ?1, l.to_note_id, l.from_note_id)
			WHERE ?1 IN (l.from_note_id, l.to_note_id) AND ${notes.noteVisibleIn('?2')} ORDER BY n.slug`
		)
		.all(id, ctx.projectId) as { type: string; outgoing: 0 | 1; slug: string }[];
	const linked: Record<string, string[]> = {};
	for (const l of links) (linked[NOTE_LINK_KEYS[`${l.type}:${l.outgoing ? 'out' : 'in'}`]] ??= []).push(l.slug);
	const tickets = db
		.prepare(
			`SELECT p.key || '-' || t.number AS ref, nt.relation FROM note_tickets nt JOIN tickets t ON t.id = nt.ticket_id JOIN projects p ON p.id = t.project_id
			WHERE nt.note_id = ? ORDER BY t.project_id, t.number, nt.relation`
		)
		.all(id);
	return {
		slug: n.slug,
		title: n.title,
		kind: n.kind,
		...(n.status !== null && { status: n.status }),
		...(n.archived === 1 && { archived: true }),
		tags: n.tags,
		version: n.version,
		body: n.body,
		...linked,
		...(tickets.length > 0 && { tickets })
	};
}

/** The notes linked to a ticket that the caller can read; archived ones no longer document anything. */
const linkedNotes = (db: DatabaseSync, ctx: ToolContext, ticketId: number) =>
	db
		.prepare(
			`SELECT n.slug, n.title, nt.relation FROM note_tickets nt JOIN notes n ON n.id = nt.note_id
			WHERE nt.ticket_id = ?1 AND n.archived = 0 AND ${notes.noteVisibleIn('?2')} ORDER BY n.slug, nt.relation`
		)
		.all(ticketId, ctx.projectId);

type CommentRow = { id: number; by: string; at: string; text: string };

/** Long comments are cut so that one oversized write does not inflate every later read of the ticket. */
function recentComments(db: DatabaseSync, ticketId: number) {
	const rows = db
		.prepare('SELECT id, author AS "by", created_at AS "at", body AS text FROM comments WHERE ticket_id = ? ORDER BY id DESC LIMIT ?')
		.all(ticketId, RECENT_COMMENTS) as CommentRow[];
	return rows
		.reverse()
		.map((c) => (c.text.length > COMMENT_PREVIEW ? { ...c, text: `${c.text.slice(0, COMMENT_PREVIEW)}…`, more: `get_ticket {"comment": ${c.id}}` } : c));
}

function fullComment(db: DatabaseSync, ctx: ToolContext, commentId: number): CommentRow {
	const comment = db
		.prepare('SELECT c.id, c.author AS "by", c.created_at AS "at", c.body AS text FROM comments c JOIN tickets t ON t.id = c.ticket_id WHERE c.id = ? AND t.project_id = ?')
		.get(commentId, ctx.projectId) as CommentRow | undefined;
	if (!comment)
		throw new Refusal({
			error: 'not_found',
			message: `Kommentar ${commentId} gibt es in deinem Projekt nicht.`,
			hint: 'Die Kommentar-IDs stehen in get_ticket unter comments.'
		});
	return comment;
}

/** Everything an agent needs about a ticket in one answer; for its own ticket also the allowed moves and the latest question. */
function ticketView(db: DatabaseSync, ctx: ToolContext, ref?: string) {
	const id = ref === undefined ? ctx.ticketId : ticketIdOf(db, ctx, ref);
	const t = db
		.prepare(
			`SELECT p.key || '-' || t.number AS ref, t.title, t.type, c.name AS "column", t.description, t.docs_required, t.review_approved_at
			FROM tickets t JOIN projects p ON p.id = t.project_id JOIN columns c ON c.id = t.column_id WHERE t.id = ?`
		)
		.get(id) as { ref: string; title: string; type: string; column: string; description: string; docs_required: 0 | 1; review_approved_at: string | null };
	const ticketNotes = linkedNotes(db, ctx, id);
	const view = {
		ref: t.ref,
		title: t.title,
		type: t.type,
		column: t.column,
		description: t.description,
		docs_required: t.docs_required === 1,
		review_approved: t.review_approved_at !== null,
		tasks: (db.prepare('SELECT id, title, done_at IS NOT NULL AS done FROM tasks WHERE ticket_id = ? ORDER BY position, id').all(id) as { id: number; title: string; done: 0 | 1 }[]).map(
			(k) => ({ id: k.id, title: k.title, done: k.done === 1 })
		),
		comments: recentComments(db, id),
		...relationsOf(db, ctx, id),
		...(ticketNotes.length > 0 && { notes: ticketNotes })
	};
	if (id !== ctx.ticketId) return view;
	const latest = collectAnswer(db, ctx.actor, id);
	return {
		...view,
		allowed_moves: agentMoves(db, ctx).map((m) => ({
			column_id: m.columnId,
			name: m.name,
			...(m.refusals.length > 0 && { blocked: m.refusals.map((r) => r.message).join(' ') })
		})),
		...(latest &&
			(latest.answer
				? { human_answer: { question_id: latest.id, question: latest.question, options: latest.options, answer: latest.answer } }
				: { pending_question: { question_id: latest.id, question: latest.question } }))
	};
}
