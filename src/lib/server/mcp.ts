import { createMcpHandler, fromJsonSchema, McpServer, type AuthInfo, type CallToolResult, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { DatabaseSync } from 'node:sqlite';
import * as board from './domain/board';
import { actorLabel, DomainError, type Actor } from './domain/core';
import { collectAnswer, requestHuman, type QuestionOption } from './domain/questions';
import { runForToken } from './domain/runs';

/** What a run token grants: writes to its own ticket, reads across its project. */
type RunScope = { runId: number; ticketId: number; projectId: number };
type ToolError = { error: string; message: string; hint: string };
type AgentMove = { columnId: number; name: string; refusals: ToolError[] };

const RECENT_COMMENTS = 10;
const UNAUTHORIZED = {
	error: 'unauthorized',
	hint: 'Sende den Run-Token als „Authorization: Bearer <token>“. Ein Token gilt nur, solange sein Run läuft.'
};

/** A refusal that is already phrased for the agent: tool names and concrete ids instead of domain function names. */
class Refusal extends Error {
	constructor(readonly body: ToolError) {
		super(body.message);
	}
}

/** Serves the studio MCP endpoint. Every request authenticates with the bearer token of a running run. */
export function mcpEndpoint(db: DatabaseSync): (request: Request) => Promise<Response> {
	const handler = createMcpHandler(({ authInfo }) => studioServer(db, runScopeOf(authInfo)));
	return async (request) => {
		const token = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
		const run = token ? runForToken(db, token) : undefined;
		if (!token || !run) return Response.json(UNAUTHORIZED, { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
		return handler.fetch(request, { authInfo: { token, clientId: `run-${run.runId}`, scopes: [], extra: run } });
	};
}

function runScopeOf(authInfo: AuthInfo | undefined): RunScope {
	if (!authInfo?.extra) throw new Error('studio MCP server built without an authenticated run');
	return authInfo.extra as RunScope;
}

const object = (properties: Record<string, JsonSchemaType>, required?: string[]): JsonSchemaType => ({
	type: 'object',
	properties,
	...(required && { required }),
	additionalProperties: false
});

const reply = (value: unknown, isError = false): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError && { isError }) });

function studioServer(db: DatabaseSync, run: RunScope): McpServer {
	const actor: Actor = { kind: 'agent', runId: run.runId };
	const server = new McpServer({ name: 'kabai-studio', version: '1' });

	function tool<Args>(name: string, description: string, schema: JsonSchemaType, work: (args: Args) => unknown) {
		server.registerTool(name, { description, inputSchema: fromJsonSchema<Args>(schema) }, async (args) => {
			try {
				return reply(work(args));
			} catch (err) {
				if (err instanceof Refusal) return reply(err.body, true);
				if (err instanceof DomainError) return reply({ error: err.code, message: err.message, hint: toolHint(db, run, name, err.code) ?? err.hint }, true);
				throw err;
			}
		});
	}

	/** Writes happen in the run's name, so the run becomes the ticket's assignee. */
	function write<T>(work: () => T): T {
		const result = work();
		assignToRun(db, run, actor);
		return result;
	}

	tool<{ ticket?: number }>(
		'get_ticket',
		"Your ticket: tasks, recent comments, relations, allowed moves, the human's latest answer. Other tickets of your project by number.",
		object({ ticket: { type: 'integer', description: 'e.g. 12 for STU-12; default: your ticket' } }),
		({ ticket }) => ticketView(db, run, actor, ticket)
	);

	tool<{ title?: string; description?: string; docs_required?: boolean }>(
		'update_ticket',
		'Change title, description or docs_required (a linked note is needed before done) of your ticket.',
		object({ title: { type: 'string', minLength: 1 }, description: { type: 'string' }, docs_required: { type: 'boolean' } }),
		({ title, description, docs_required }) =>
			write(() => {
				board.updateTicket(db, actor, run.ticketId, { title, description, docs_required: docs_required === undefined ? undefined : docs_required ? 1 : 0 });
				return { ref: ticketRef(db, run.ticketId) };
			})
	);

	tool<{ titles: string[] }>(
		'add_tasks',
		'Add acceptance criteria as tasks to your ticket.',
		object({ titles: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 } }, ['titles']),
		({ titles }) => write(() => ({ task_ids: board.addTasks(db, actor, run.ticketId, titles).ids }))
	);

	tool<{ task_ids: number[] }>(
		'complete_tasks',
		'Mark tasks of your ticket done. Returns the ids still open.',
		object({ task_ids: { type: 'array', items: { type: 'integer' }, minItems: 1 } }, ['task_ids']),
		({ task_ids }) =>
			write(() => {
				board.completeTasks(db, actor, run.ticketId, task_ids);
				return { open_task_ids: openTaskIds(db, run.ticketId) };
			})
	);

	tool<{ text: string }>(
		'add_comment',
		'Add a work-log comment to your ticket.',
		object({ text: { type: 'string', minLength: 1 } }, ['text']),
		({ text }) => write(() => ({ comment_id: board.addComment(db, actor, run.ticketId, text).id }))
	);

	tool<{ column_id: number }>(
		'move_ticket',
		'Move your ticket to a column from allowed_moves.',
		object({ column_id: { type: 'integer' } }, ['column_id']),
		({ column_id }) => write(() => moveOwnTicket(db, run, actor, column_id))
	);

	tool<{ question: string; options?: QuestionOption[] }>(
		'request_human',
		'Ask the human and wait: moves your ticket to human intervention. Offer 1-3 decidable options when possible. End your turn afterwards.',
		object(
			{
				question: { type: 'string', minLength: 1 },
				options: {
					type: 'array',
					maxItems: 3,
					items: object({ label: { type: 'string', minLength: 1 }, effect: { type: 'string', description: 'what choosing it leads to' } }, ['label'])
				}
			},
			['question']
		),
		(q) =>
			write(() => {
				const { id, column } = requestHuman(db, actor, run.ticketId, q);
				return { question_id: id, column };
			})
	);

	return server;
}

/** Tool-level way out for domain errors whose domain hint names domain functions or does not fit the calling tool. */
function toolHint(db: DatabaseSync, run: RunScope, tool: string, code: string): string | undefined {
	switch (code) {
		case 'requires_human':
			return tool === 'request_human'
				? 'Das Ticket kann nur der Mensch verschieben; stell deine Frage mit add_comment.'
				: 'Diesen Schritt macht nur der Mensch. Lass das Ticket, wo es ist; brauchst du eine Entscheidung, frag mit request_human.';
		case 'open_tasks':
			return `Schließe die Tasks mit complete_tasks ab: task_ids [${openTaskIds(db, run.ticketId).join(', ')}].`;
		case 'open_children':
			return 'Erst müssen die Kind-Tickets fertig sein; hängt es an ihnen, frag mit request_human.';
		case 'docs_required':
			return 'Vor dem Abschluss muss eine Note mit dem Ticket verknüpft sein; bitte den Menschen mit request_human darum.';
		case 'transition_not_allowed':
			return 'get_ticket zeigt die erreichbaren Spalten unter allowed_moves.';
	}
}

const openTaskIds = (db: DatabaseSync, ticketId: number) =>
	db
		.prepare('SELECT id FROM tasks WHERE ticket_id = ? AND done_at IS NULL ORDER BY position, id')
		.all(ticketId)
		.map((r) => r.id as number);

const ticketRef = (db: DatabaseSync, ticketId: number) =>
	(db.prepare(`SELECT p.key || '-' || t.number AS ref FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(ticketId) as { ref: string }).ref;

function assignToRun(db: DatabaseSync, run: RunScope, actor: Actor) {
	const label = actorLabel(actor);
	const { assignee } = db.prepare('SELECT assignee FROM tickets WHERE id = ?').get(run.ticketId) as { assignee: string | null };
	if (assignee !== label) board.updateTicket(db, actor, run.ticketId, { assignee: label });
}

/** Domain moves plus the rule only agents get: a blocked ticket must not enter a work column. */
function agentMoves(db: DatabaseSync, run: RunScope, actor: Actor): AgentMove[] {
	const waitingFor = board.blockingPredecessors(db, run.ticketId);
	return board.allowedMoves(db, run.ticketId, actor).map((m) => ({
		columnId: m.columnId,
		name: m.name,
		refusals: [
			...(m.kind === 'normal' && waitingFor.length ? [blockedRefusal(db, run, waitingFor)] : []),
			...m.blockers.map((b) => ({ error: b.code, message: b.message, hint: toolHint(db, run, 'move_ticket', b.code) ?? b.hint }))
		]
	}));
}

function blockedRefusal(db: DatabaseSync, run: RunScope, waitingFor: board.Predecessor[]): ToolError {
	const { setting } = db.prepare('SELECT blocks_satisfied_at AS setting FROM projects WHERE id = ?').get(run.projectId) as { setting: 'done' | 'review_ok' };
	const refs = waitingFor.map((p) => p.ref).join(', ');
	return {
		error: 'blocked',
		message: `${ticketRef(db, run.ticketId)} wartet auf ${refs} (blocks_satisfied_at = ${setting}).`,
		hint:
			`Ein Vorgänger gilt als erledigt, sobald er in einer done-Spalte liegt${setting === 'review_ok' ? ' oder freigegeben ist' : ''}. ` +
			`Agents starten keine blockierten Tickets: warte auf ${refs} oder frag mit request_human.`
	};
}

function moveOwnTicket(db: DatabaseSync, run: RunScope, actor: Actor, columnId: number) {
	const current = db.prepare('SELECT c.id, c.name FROM tickets t JOIN columns c ON c.id = t.column_id WHERE t.id = ?').get(run.ticketId) as { id: number; name: string };
	if (current.id === columnId) return { column: current.name };
	const moves = agentMoves(db, run, actor);
	const move = moves.find((m) => m.columnId === columnId);
	if (!move)
		throw new Refusal({
			error: 'transition_not_allowed',
			message: `Spalte ${columnId} ist von „${current.name}“ aus nicht erreichbar.`,
			hint: `Erreichbar: ${moves.map((m) => `column_id ${m.columnId} (${m.name})`).join(', ')}.`
		});
	if (move.refusals.length)
		throw new Refusal({
			error: move.refusals[0].error,
			message: move.refusals.map((r) => r.message).join(' '),
			hint: move.refusals.map((r) => r.hint).join(' ')
		});
	board.moveTicket(db, actor, run.ticketId, columnId);
	return { column: move.name };
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

/** Relations named from this ticket's point of view, so their direction cannot be misread. */
function relationsOf(db: DatabaseSync, ticketId: number) {
	const blocking = new Set(board.blockingPredecessors(db, ticketId).map((p) => p.id));
	const rows = db
		.prepare(
			`SELECT r.type, r.from_ticket_id = ?1 AS outgoing, o.id, op.key || '-' || o.number AS ref, o.title, oc.name AS "column"
			FROM ticket_relations r JOIN tickets o ON o.id = iif(r.from_ticket_id = ?1, r.to_ticket_id, r.from_ticket_id)
			JOIN projects op ON op.id = o.project_id JOIN columns oc ON oc.id = o.column_id
			WHERE ?1 IN (r.from_ticket_id, r.to_ticket_id) ORDER BY o.project_id, o.number`
		)
		.all(ticketId) as { type: string; outgoing: 0 | 1; id: number; ref: string; title: string; column: string }[];
	const relations: Record<string, object[]> = {};
	for (const r of rows) {
		const key = RELATION_KEYS[`${r.type}:${r.outgoing ? 'out' : 'in'}`];
		const other = { ref: r.ref, title: r.title, column: r.column };
		(relations[key] ??= []).push(key === 'waits_for' ? { ...other, blocking: blocking.has(r.id) } : other);
	}
	return relations;
}

/** Everything a run needs about a ticket in one answer; for its own ticket also the allowed moves and the human's answer. */
function ticketView(db: DatabaseSync, run: RunScope, actor: Actor, number?: number) {
	const t = db
		.prepare(
			`SELECT t.id, p.key || '-' || t.number AS ref, t.title, t.type, c.name AS "column", t.description, t.docs_required, t.review_approved_at
			FROM tickets t JOIN projects p ON p.id = t.project_id JOIN columns c ON c.id = t.column_id
			WHERE t.project_id = ?1 AND iif(?2 IS NULL, t.id = ?3, t.number = ?2)`
		)
		.get(run.projectId, number ?? null, run.ticketId) as
		| { id: number; ref: string; title: string; type: string; column: string; description: string; docs_required: 0 | 1; review_approved_at: string | null }
		| undefined;
	if (!t)
		throw new Refusal({
			error: 'not_found',
			message: `Ticket ${number} gibt es in deinem Projekt nicht.`,
			hint: 'Nutze die Nummer aus einer Ticket-Referenz, z. B. 12 für STU-12.'
		});
	const view = {
		ref: t.ref,
		title: t.title,
		type: t.type,
		column: t.column,
		description: t.description,
		docs_required: t.docs_required === 1,
		review_approved: t.review_approved_at !== null,
		tasks: (db.prepare('SELECT id, title, done_at IS NOT NULL AS done FROM tasks WHERE ticket_id = ? ORDER BY position, id').all(t.id) as { id: number; title: string; done: 0 | 1 }[]).map(
			(k) => ({ id: k.id, title: k.title, done: k.done === 1 })
		),
		comments: db
			.prepare('SELECT author AS "by", created_at AS "at", body AS text FROM comments WHERE ticket_id = ? ORDER BY id DESC LIMIT ?')
			.all(t.id, RECENT_COMMENTS)
			.reverse(),
		...relationsOf(db, t.id)
	};
	if (t.id !== run.ticketId) return view;
	const answered = collectAnswer(db, actor, t.id);
	return {
		...view,
		allowed_moves: agentMoves(db, run, actor).map((m) => ({
			column_id: m.columnId,
			name: m.name,
			...(m.refusals.length > 0 && { blocked: m.refusals.map((r) => r.message).join(' ') })
		})),
		...(answered && { human_answer: { question: answered.question, options: answered.options, answer: answered.answer } })
	};
}
