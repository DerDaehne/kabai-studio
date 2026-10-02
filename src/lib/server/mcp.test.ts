import { McpServer } from '@modelcontextprotocol/server';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import * as questions from './domain/questions';
import * as runs from './domain/runs';
import { mcpEndpoint } from './mcp';
import { setSecret } from './secrets';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };
type Serve = ReturnType<typeof mcpEndpoint>;

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const col = Object.fromEntries(db.prepare('SELECT name, id FROM columns WHERE project_id = ?').all(projectId).map((r) => [r.name, r.id])) as Record<string, number>;
	const profileId = runs.createProfile(db, user, { name: 'Test', executor: 'builtin', provider: 'openai-compatible', model: 'm' }).id;
	const ticket = (title = 'T') => board.createTicket(db, user, projectId, { title }).id;
	/** Sets up a state directly, without going through the rules. */
	const place = (id: number, column: string) => db.prepare('UPDATE tickets SET column_id = ? WHERE id = ?').run(col[column], id);
	const columnOf = (id: number) => db.prepare('SELECT c.name FROM tickets t JOIN columns c ON c.id = t.column_id WHERE t.id = ?').get(id)?.name;
	const startRun = (ticketId: number, resumedFromRunId?: number) => {
		const runId = runs.createRun(db, user, { ticketId, profileId, resumedFromRunId }).id;
		return { runId, token: runs.startRun(db, system, runId).token };
	};
	const serve = mcpEndpoint(db);
	const call = (token: string, name: string, args: object = {}) => callTool(serve, token, name, args);
	return { db, projectId, col, ticket, place, columnOf, startRun, serve, call };
}

let requestId = 0;
function rpc(serve: Serve, token: string | undefined, method: string, params?: object) {
	const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	return serve(new Request('http://127.0.0.1:3000/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }) }));
}

async function messageOf(response: Response) {
	const text = await response.text();
	const isStream = response.headers.get('content-type')?.startsWith('text/event-stream');
	const json = isStream ? text.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length) : text;
	return JSON.parse(json);
}

const resultOf = async (response: Response) => (await messageOf(response)).result;

/** Everything a tool can write, to show that a refused call changed nothing. */
const writableRows = (db: DatabaseSync) =>
	JSON.stringify(['comments', 'tickets', 'tasks', 'questions', 'ticket_relations'].map((table) => db.prepare(`SELECT * FROM ${table}`).all()));

/** What the agent sees of a tool call: the error flag and the text, parsed when it is JSON. */
async function callTool(serve: Serve, token: string, name: string, args: object) {
	const result = await resultOf(await rpc(serve, token, 'tools/call', { name, arguments: args }));
	const text = result.content[0].text as string;
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { isError: result.isError === true, body };
}

const DOMAIN_FUNCTION_NAMES = /\b(completeTask|deleteTask|allowedMoves|workableTickets|unlinkRelation|createNote|linkTicket|moveTicket|addTask)\b/;

describe('run token', () => {
	it('answers 401 without a token or with an unknown one', async () => {
		const { serve, startRun, ticket } = setup();
		startRun(ticket());
		for (const token of [undefined, '', 'unknown-token']) {
			const response = await rpc(serve, token, 'tools/list');
			expect(response.status).toBe(401);
			expect(response.headers.get('www-authenticate')).toContain('Bearer');
			expect(await response.json()).toMatchObject({ error: 'unauthorized', hint: expect.stringContaining('Bearer') });
		}
	});

	it('accepts the token while the run is active and answers 401 once the run has ended', async () => {
		const { db, serve, startRun, ticket } = setup();
		const id = ticket();
		const first = startRun(id);
		expect((await rpc(serve, first.token, 'tools/list')).status).toBe(200);
		runs.setRunState(db, system, first.runId, 'waiting_approval');
		expect((await rpc(serve, first.token, 'tools/list')).status).toBe(200);
		runs.setRunState(db, system, first.runId, 'running');
		runs.finishRun(db, system, first.runId, { state: 'paused' });
		expect((await rpc(serve, first.token, 'tools/list')).status).toBe(401);

		const second = startRun(id, first.runId);
		runs.finishRun(db, system, second.runId, { state: 'succeeded' });
		expect((await rpc(serve, second.token, 'tools/list')).status).toBe(401);
	});

	it('answers 401 once the run was cancelled or has failed', async () => {
		const { db, serve, startRun, ticket } = setup();
		const id = ticket();
		for (const end of [{ state: 'cancelled' }, { state: 'failed', error: 'executor crashed' }] as const) {
			const { runId, token } = startRun(id);
			expect((await rpc(serve, token, 'tools/list')).status).toBe(200);
			runs.finishRun(db, system, runId, end);
			expect((await rpc(serve, token, 'tools/list')).status).toBe(401);
		}
	});
});

describe('scope of a run', () => {
	it('reads every ticket of its project by ref, but none of another project and no bare number', async () => {
		const { db, call, startRun, ticket } = setup();
		const own = ticket('Eigenes');
		ticket('Nachbar');
		const other = board.createProject(db, user, { key: 'OTH', name: 'Anderes' }).id;
		for (let i = 0; i < 3; i++) board.createTicket(db, user, other, { title: 'Fremd' });
		const { token } = startRun(own);

		const neighbour = await call(token, 'get_ticket', { ticket: 'STU-2' });
		expect(neighbour.body).toMatchObject({ ref: 'STU-2', title: 'Nachbar' });
		expect(neighbour.body).not.toHaveProperty('allowed_moves');
		expect((await call(token, 'get_ticket', { ticket: 'stu-2' })).body.ref).toBe('STU-2');
		for (const ref of ['OTH-1', 'OTH-3', 'STU-9', '3']) {
			const refused = await call(token, 'get_ticket', { ticket: ref });
			expect(refused).toMatchObject({ isError: true, body: { error: 'not_found', hint: expect.stringContaining('STU-12') } });
		}
		expect((await call(token, 'get_ticket', { ticket: 3 })).isError).toBe(true);
	});

	it('refuses writes to other tickets: foreign task ids and a ticket parameter are rejected', async () => {
		const { db, call, startRun, ticket } = setup();
		const [own, neighbour] = [ticket('Eigenes'), ticket('Nachbar')];
		const [foreignTask] = board.addTasks(db, user, neighbour, ['Fremd']).ids;
		const { token } = startRun(own);

		const complete = await call(token, 'complete_tasks', { task_ids: [foreignTask] });
		expect(complete).toMatchObject({ isError: true, body: { error: 'not_found', message: expect.stringContaining(String(foreignTask)) } });
		expect(db.prepare('SELECT done_at FROM tasks WHERE id = ?').get(foreignTask)?.done_at).toBeNull();

		const update = await call(token, 'update_ticket', { ticket: 'STU-2', title: 'Gekapert' });
		expect(update.isError).toBe(true);
		expect(db.prepare('SELECT title FROM tickets ORDER BY id').all().map((r) => r.title)).toEqual(['Eigenes', 'Nachbar']);
	});
});

describe('get_ticket', () => {
	it('shows tasks with ids, the last ten comments, relations as waits_for/blocks, allowed moves and the approval state', async () => {
		const { db, call, startRun, ticket, place } = setup();
		const [open, finished, own, successor, epic] = [ticket('Offen'), ticket('Fertig'), ticket('Eigenes'), ticket('Danach'), ticket('Epic')];
		place(finished, 'Done');
		board.linkRelation(db, user, open, own, 'blocks');
		board.linkRelation(db, user, finished, own, 'blocks');
		board.linkRelation(db, user, own, successor, 'blocks');
		board.linkRelation(db, user, epic, own, 'parent_of');
		const [a, b] = board.addTasks(db, user, own, ['A', 'B']).ids;
		board.completeTask(db, user, a);
		for (let i = 1; i <= 12; i++) board.addComment(db, user, own, `Kommentar ${i}`);
		const { token } = startRun(own);

		const { body } = await call(token, 'get_ticket');
		expect(body).toMatchObject({ ref: 'STU-3', title: 'Eigenes', column: 'Backlog', review_approved: false });
		expect(body.tasks).toEqual([
			{ id: a, title: 'A', done: true },
			{ id: b, title: 'B', done: false }
		]);
		expect(body.comments.map((c: { text: string }) => c.text)).toEqual(Array.from({ length: 10 }, (_, i) => `Kommentar ${i + 3}`));
		expect(body.comments[0]).toMatchObject({ by: 'user', at: expect.any(String) });
		expect(body.waits_for).toEqual([
			{ ref: 'STU-1', title: 'Offen', column: 'Backlog', blocking: true },
			{ ref: 'STU-2', title: 'Fertig', column: 'Done', blocking: false }
		]);
		expect(body.blocks).toEqual([{ ref: 'STU-4', title: 'Danach', column: 'Backlog' }]);
		expect(body.parent).toEqual([{ ref: 'STU-5', title: 'Epic', column: 'Backlog' }]);
		expect(body.allowed_moves).toEqual([
			{ column_id: expect.any(Number), name: 'In Arbeit', blocked: 'STU-3 wartet auf STU-1 (blocks_satisfied_at = done).' },
			{ column_id: expect.any(Number), name: 'Human Intervention' }
		]);

		board.approveReview(db, user, own);
		expect((await call(token, 'get_ticket')).body.review_approved).toBe(true);
	});
});

describe('move_ticket for agents', () => {
	it('refuses a work column while a predecessor is open and names it and blocks_satisfied_at', async () => {
		const { db, call, startRun, ticket, col, columnOf } = setup();
		const [predecessor, own] = [ticket(), ticket()];
		board.linkRelation(db, user, predecessor, own, 'blocks');
		const { token } = startRun(own);

		const refused = await call(token, 'move_ticket', { column_id: col['In Arbeit'] });
		expect(refused).toMatchObject({ isError: true, body: { error: 'blocked' } });
		expect(refused.body.message).toContain('STU-1');
		expect(refused.body.message).toContain('blocks_satisfied_at = done');
		expect(refused.body.hint).toContain('request_human');
		expect(columnOf(own)).toBe('Backlog');

		board.moveTicket(db, user, own, col['In Arbeit']); // a human may start it deliberately
		board.moveTicket(db, user, own, col.Backlog);
		expect((await call(token, 'move_ticket', { column_id: col['Human Intervention'] })).isError).toBe(false);
	});

	it('lets the ticket into work once the predecessor is done, or approved when the project counts review_ok', async () => {
		const { db, projectId, call, startRun, ticket, place, col, columnOf } = setup();
		const [predecessor, own] = [ticket(), ticket()];
		board.linkRelation(db, user, predecessor, own, 'blocks');
		place(predecessor, 'Review');
		board.approveReview(db, user, predecessor);
		const { token } = startRun(own);
		const move = () => call(token, 'move_ticket', { column_id: col['In Arbeit'] });

		expect((await move()).body.error).toBe('blocked');
		board.setBlocksSatisfiedAt(db, user, projectId, 'review_ok');
		expect(await move()).toEqual({ isError: false, body: { column: 'In Arbeit' } });
		expect(columnOf(own)).toBe('In Arbeit');
		expect(await move()).toEqual({ isError: false, body: { column: 'In Arbeit' } }); // a retry is harmless
	});
});

describe('batch tools', () => {
	it('add_tasks and complete_tasks take lists and answer with ids', async () => {
		const { db, call, startRun, ticket } = setup();
		const own = ticket();
		const { token } = startRun(own);

		const added = await call(token, 'add_tasks', { titles: ['A', 'B', 'C'] });
		expect(added.body.task_ids).toHaveLength(3);
		const [a, b, c] = added.body.task_ids;
		expect(await call(token, 'complete_tasks', { task_ids: [a, b] })).toEqual({ isError: false, body: { open_task_ids: [c] } });

		expect((await call(token, 'add_tasks', { titles: ['D', ' '] })).body.error).toBe('empty_title');
		expect(db.prepare('SELECT count(*) AS n FROM tasks').get()?.n).toBe(3);
	});
});

describe('create_child_tickets', () => {
	it('creates children of your ticket with tasks and a blocks chain over local refs in one call', async () => {
		const { call, startRun, ticket } = setup();
		const own = ticket('Epic');
		ticket('Vorhanden');
		const { token } = startRun(own);

		const created = await call(token, 'create_child_tickets', {
			items: [
				{ ref: 'schema', title: 'Schema', tasks: ['Migration', 'Test'] },
				{ ref: 'domain', title: 'Domain', waits_for: ['$schema', 'STU-2'] },
				{ title: 'UI', description: 'Board', waits_for: ['$domain'] }
			]
		});
		expect(created).toEqual({ isError: false, body: { refs: ['STU-3', 'STU-4', 'STU-5'] } });

		expect((await call(token, 'get_ticket')).body.children.map((c: { ref: string }) => c.ref)).toEqual(['STU-3', 'STU-4', 'STU-5']);
		const schema = (await call(token, 'get_ticket', { ticket: 'STU-3' })).body;
		expect(schema.tasks.map((t: { title: string; done: boolean }) => [t.title, t.done])).toEqual([
			['Migration', false],
			['Test', false]
		]);
		expect(schema.blocks).toEqual([{ ref: 'STU-4', title: 'Domain', column: 'Backlog' }]);
		const domain = (await call(token, 'get_ticket', { ticket: 'STU-4' })).body;
		expect(domain.waits_for).toEqual([
			{ ref: 'STU-2', title: 'Vorhanden', column: 'Backlog', blocking: true },
			{ ref: 'STU-3', title: 'Schema', column: 'Backlog', blocking: true }
		]);
		expect(domain.parent).toEqual([{ ref: 'STU-1', title: 'Epic', column: 'Backlog' }]);
		const ui = (await call(token, 'get_ticket', { ticket: 'STU-5' })).body;
		expect(ui).toMatchObject({ description: 'Board', waits_for: [{ ref: 'STU-4', blocking: true }] });
	});

	const invalid: [string, object[], string][] = [
		['a blank title', [{ title: 'A' }, { title: '  ' }], 'items[1]'],
		['a blank task', [{ title: 'A', tasks: ['ok', ' '] }], 'items[0]'],
		['an unknown local ref', [{ ref: 'a', title: 'A' }, { title: 'B' }, { title: 'C', waits_for: ['$b'] }], 'items[2]'],
		['a ticket of another project', [{ title: 'A' }, { title: 'B', waits_for: ['OTH-1'] }], 'items[1]'],
		['a local ref used twice', [{ ref: 'a', title: 'A' }, { ref: 'a', title: 'B' }], 'items[1]'],
		['a cycle over local refs', [{ ref: 'a', title: 'A', waits_for: ['$b'] }, { ref: 'b', title: 'B', waits_for: ['$a'] }], 'items[1]'],
		['an item waiting for itself', [{ ref: 'a', title: 'A', waits_for: ['$a'] }], 'items[0]']
	];

	it.each(invalid)('creates nothing for %s and names the item', async (_case, items, item) => {
		const { db, call, startRun, ticket } = setup();
		board.createTicket(db, user, board.createProject(db, user, { key: 'OTH', name: 'Anderes' }).id, { title: 'Fremd' });
		const { token } = startRun(ticket());
		const before = writableRows(db);

		const refused = await call(token, 'create_child_tickets', { items });
		expect(refused.isError).toBe(true);
		expect(refused.body.message).toContain(item);
		expect(refused.body.hint).not.toMatch(DOMAIN_FUNCTION_NAMES);
		expect(writableRows(db)).toBe(before);
		expect((await call(token, 'create_child_tickets', { items: [{ title: 'Danach' }] })).body.refs).toEqual(['STU-2']);
	});
});

describe('link_tickets', () => {
	it('links your ticket in the words get_ticket shows them in: waits_for and blocks', async () => {
		const { serve, call, startRun, ticket } = setup();
		const own = ticket('Eigenes');
		ticket('Vorher');
		ticket('Nachher');
		const { token } = startRun(own);
		const { tools } = await resultOf(await rpc(serve, token, 'tools/list'));
		expect(Object.keys(tools.find((t: { name: string }) => t.name === 'link_tickets').inputSchema.properties)).toEqual(['waits_for', 'blocks']);

		expect(await call(token, 'link_tickets', { waits_for: ['STU-2'], blocks: ['STU-3'] })).toEqual({ isError: false, body: { ref: 'STU-1' } });
		const { body } = await call(token, 'get_ticket');
		expect(body.waits_for).toEqual([{ ref: 'STU-2', title: 'Vorher', column: 'Backlog', blocking: true }]);
		expect(body.blocks).toEqual([{ ref: 'STU-3', title: 'Nachher', column: 'Backlog' }]);
		expect((await call(token, 'get_ticket', { ticket: 'STU-3' })).body.waits_for).toEqual([{ ref: 'STU-1', title: 'Eigenes', column: 'Backlog', blocking: true }]);
		expect((await call(token, 'link_tickets', { waits_for: ['STU-2'] })).isError).toBe(false);
	});

	it('links all or none and explains a cycle in tool words', async () => {
		const { db, call, startRun, ticket } = setup();
		const own = ticket();
		const predecessor = ticket();
		ticket();
		board.linkRelation(db, user, predecessor, own, 'blocks');
		const { token } = startRun(own);
		const before = writableRows(db);

		const cycle = await call(token, 'link_tickets', { blocks: ['STU-3', 'STU-2'] });
		expect(cycle).toMatchObject({ isError: true, body: { error: 'cycle', hint: expect.stringContaining('waits_for') } });
		expect(cycle.body.hint).not.toMatch(DOMAIN_FUNCTION_NAMES);
		expect((await call(token, 'link_tickets', { waits_for: ['STU-3', 'STU-9'] })).body.error).toBe('not_found');
		expect(writableRows(db)).toBe(before);
	});
});

describe('list_workable', () => {
	it('lists only tickets whose predecessors are done, or approved (acceptance) when the project counts review_ok', async () => {
		const { db, projectId, call, startRun, ticket, place, col } = setup();
		const own = ticket('Eigenes');
		const [done, approved, open] = [ticket('Fertig'), ticket('Freigegeben'), ticket('Offen')];
		const [afterDone, afterApproved, afterOpen] = [ticket('Nach Fertig'), ticket('Nach Freigabe'), ticket('Nach Offen')];
		place(done, 'Done');
		place(approved, 'Review');
		board.approveReview(db, user, approved);
		board.linkRelation(db, user, done, afterDone, 'blocks');
		board.linkRelation(db, user, approved, afterApproved, 'blocks');
		board.linkRelation(db, user, open, afterOpen, 'blocks');
		place(ticket('Wartet auf den Menschen'), 'Human Intervention');
		const { runId, token } = startRun(own);
		const workable = async (args = {}) => (await call(token, 'list_workable', args)).body;

		expect((await workable()).tickets).toEqual([
			{ ref: 'STU-1', title: 'Eigenes', column: 'Backlog', assignee: `agent (Run ${runId})` },
			{ ref: 'STU-4', title: 'Offen', column: 'Backlog' },
			{ ref: 'STU-5', title: 'Nach Fertig', column: 'Backlog' },
			{ ref: 'STU-3', title: 'Freigegeben', column: 'Review' }
		]);
		board.setBlocksSatisfiedAt(db, user, projectId, 'review_ok');
		expect((await workable()).tickets.map((t: { ref: string }) => t.ref)).toEqual(['STU-1', 'STU-4', 'STU-5', 'STU-6', 'STU-3']);
		expect(await workable({ column_id: col.Review })).toEqual({ tickets: [{ ref: 'STU-3', title: 'Freigegeben', column: 'Review' }] });
	});

	it('answers with at most 50 tickets and says how many more there are', async () => {
		const { call, startRun, ticket } = setup();
		const { token } = startRun(ticket());
		for (let i = 0; i < 52; i++) ticket();
		const { body } = await call(token, 'list_workable');
		expect(body.tickets).toHaveLength(50);
		expect(body.more).toBe(3);
	});
});

describe('approve_review', () => {
	it('approves your ticket in a review column; get_ticket shows it until the ticket returns to a normal column', async () => {
		const { call, startRun, ticket, place, col } = setup();
		const own = ticket();
		place(own, 'Review');
		const { token } = startRun(own);

		expect(await call(token, 'approve_review')).toEqual({ isError: false, body: { review_approved: true } });
		expect((await call(token, 'get_ticket')).body.review_approved).toBe(true);
		await call(token, 'move_ticket', { column_id: col['In Arbeit'] });
		expect((await call(token, 'get_ticket')).body.review_approved).toBe(false);
	});

	it('refuses outside a review column and for your own work, naming the ticket and a way out in tool words', async () => {
		const { db, call, startRun, ticket, place, col } = setup();
		const own = ticket();
		place(own, 'In Arbeit');
		const developer = startRun(own);
		const approved = () => db.prepare('SELECT review_approved_at AS at FROM tickets WHERE id = ?').get(own)?.at !== null;

		const outside = await call(developer.token, 'approve_review');
		expect(outside).toMatchObject({ isError: true, body: { error: 'not_in_review', message: expect.stringContaining('STU-1'), hint: expect.stringContaining('add_comment') } });
		await call(developer.token, 'move_ticket', { column_id: col.Review });
		const ownWork = await call(developer.token, 'approve_review');
		expect(ownWork).toMatchObject({ isError: true, body: { error: 'self_approval', message: expect.stringContaining('STU-1'), hint: expect.stringContaining('add_comment') } });
		expect(approved()).toBe(false);

		runs.finishRun(db, system, developer.runId, { state: 'succeeded' });
		const reviewer = startRun(own);
		expect((await call(reviewer.token, 'approve_review')).isError).toBe(false);
		expect(approved()).toBe(true);
	});
});

describe('identity from the run', () => {
	it('takes comment author and actor from the run token; the run is the assignee from its start', async () => {
		const { db, call, startRun, ticket, col } = setup();
		const own = ticket();
		const { runId, token } = startRun(own);
		const label = `agent (Run ${runId})`;
		expect(db.prepare('SELECT assignee FROM tickets WHERE id = ?').get(own)?.assignee).toBe(label);

		const { body } = await call(token, 'add_comment', { text: 'Angefangen' });
		expect(db.prepare('SELECT author_kind, author, run_id FROM comments WHERE id = ?').get(body.comment_id)).toEqual({ author_kind: 'agent', author: label, run_id: runId });
		await call(token, 'move_ticket', { column_id: col['In Arbeit'] });
		expect(db.prepare('SELECT moved_by, assignee FROM tickets WHERE id = ?').get(own)).toEqual({ moved_by: JSON.stringify({ kind: 'agent', runId }), assignee: label });
	});

	it('offers no parameter for author, assignee or actor and rejects one sent anyway', async () => {
		const { db, serve, call, startRun, ticket } = setup();
		const { token } = startRun(ticket());
		const { tools } = await resultOf(await rpc(serve, token, 'tools/list'));
		const parameters = tools.flatMap((t: { inputSchema: { properties?: object } }) => Object.keys(t.inputSchema.properties ?? {}));
		expect(parameters).not.toContain('author');
		expect(parameters).not.toContain('assignee');
		expect(parameters).not.toContain('actor');

		expect((await call(token, 'add_comment', { text: 'x', author: 'user' })).isError).toBe(true);
		expect(db.prepare('SELECT count(*) AS n FROM comments').get()?.n).toBe(0);
	});
});

describe('request_human', () => {
	it('announces and validates options: at most three, each with a label', async () => {
		const { serve, call, startRun, ticket, columnOf } = setup();
		const own = ticket();
		const { token } = startRun(own);
		const ask = (options: object[]) => call(token, 'request_human', { question: 'A oder B?', options });
		const { tools } = await resultOf(await rpc(serve, token, 'tools/list'));
		const { options } = tools.find((t: { name: string }) => t.name === 'request_human').inputSchema.properties;
		expect(options).toMatchObject({ maxItems: 3, items: { required: ['label'] } });

		expect((await ask([{ label: '1' }, { label: '2' }, { label: '3' }, { label: '4' }])).isError).toBe(true);
		expect((await ask([{ label: '' }])).isError).toBe(true);
		expect((await ask([{ label: '  ' }])).body.error).toBe('empty_option');
		expect(columnOf(own)).toBe('Backlog');
	});

	it('hands the chosen option back to the resumed run; the human can retract it until then', async () => {
		const { db, call, startRun, ticket, columnOf } = setup();
		const own = ticket();
		const first = startRun(own);
		const asked = await call(first.token, 'request_human', {
			question: 'A oder B?',
			options: [{ label: 'A', effect: 'schnell' }, { label: 'B' }]
		});
		expect(asked).toEqual({ isError: false, body: { question_id: expect.any(Number), column: 'Human Intervention' } });
		expect(columnOf(own)).toBe('Human Intervention');
		runs.finishRun(db, system, first.runId, { state: 'paused' });

		const questionId = asked.body.question_id;
		questions.answerQuestion(db, user, questionId, { option: 1 });
		questions.retractAnswer(db, user, questionId);
		questions.answerQuestion(db, user, questionId, { option: 2 });

		const resumed = startRun(own, first.runId);
		const { body } = await call(resumed.token, 'get_ticket');
		expect(body.human_answer).toEqual({ question_id: questionId, question: 'A oder B?', options: [{ label: 'A', effect: 'schnell' }, { label: 'B' }], answer: { option: 2 } });
		expect(() => questions.retractAnswer(db, user, questionId)).toThrow(/schon übernommen/);
	});
});

describe('errors reach the agent with a way out in tool vocabulary', () => {
	it('names the reachable columns with ids when a target is not reachable', async () => {
		const { call, startRun, ticket, col } = setup();
		const { token } = startRun(ticket());
		const { body } = await call(token, 'move_ticket', { column_id: col.Review });
		expect(body.error).toBe('transition_not_allowed');
		expect(body.hint).toBe(`Erreichbar: column_id ${col['In Arbeit']} (In Arbeit), column_id ${col['Human Intervention']} (Human Intervention).`);
	});

	it('points to complete_tasks with the open task ids and to request_human for what only the human can do', async () => {
		const { db, call, startRun, ticket, place, col } = setup();
		const own = ticket();
		place(own, 'Review');
		board.updateTicket(db, user, own, { docs_required: 1 });
		const [a, b] = board.addTasks(db, user, own, ['A', 'B']).ids;
		const { token } = startRun(own);

		const humanOnly = (await call(token, 'move_ticket', { column_id: col.Done })).body;
		expect(humanOnly.error).toBe('requires_human');
		expect(humanOnly.hint).toContain('request_human');

		db.prepare('UPDATE transitions SET requires_human = 0 WHERE to_column_id = ?').run(col.Done);
		const { body } = await call(token, 'move_ticket', { column_id: col.Done });
		expect(body.error).toBe('open_tasks');
		expect(body.hint).toContain(`complete_tasks ab: task_ids [${a}, ${b}]`);
		expect(body.hint).toContain('Note');
		expect(body.hint).not.toMatch(DOMAIN_FUNCTION_NAMES);
	});

	it('fits the way out to the calling tool: request_human from a closed ticket suggests add_comment', async () => {
		const { call, startRun, ticket, place } = setup();
		const own = ticket();
		place(own, 'Done');
		const { token } = startRun(own);
		const { body } = await call(token, 'request_human', { question: 'Nacharbeit?' });
		expect(body.error).toBe('requires_human');
		expect(body.hint).toContain('add_comment');
		expect(body.hint).not.toContain('request_human');
	});

	it('names the valid task ids for unknown ones', async () => {
		const { db, call, startRun, ticket } = setup();
		const own = ticket();
		const [a] = board.addTasks(db, user, own, ['A']).ids;
		const { token } = startRun(own);
		const { body } = await call(token, 'complete_tasks', { task_ids: [a + 100] });
		expect(body.hint).toContain(String(a));
		expect(body.hint).not.toMatch(DOMAIN_FUNCTION_NAMES);
	});
});

// Real tokenizers (a local model's, o200k, cl100k) count 4.3 to 4.6 characters per token on these definitions; 4 leaves a margin.
const estimateTokens = (json: string) => Math.ceil(json.length / 4);

describe('token budget', () => {
	it('keeps all tool descriptions including their schemas within 4,000 tokens', async () => {
		const { serve, startRun, ticket } = setup();
		const { token } = startRun(ticket());
		const { tools } = await resultOf(await rpc(serve, token, 'tools/list'));
		const definitions = JSON.stringify(tools.map(({ name, description, inputSchema }: Record<string, unknown>) => ({ name, description, inputSchema })));
		expect(estimateTokens(definitions)).toBeLessThanOrEqual(4000);
	});
});

describe('latest question', () => {
	it('shows a newer open question as pending instead of the answer to an earlier one', async () => {
		const { db, call, startRun, ticket } = setup();
		const own = ticket();
		const first = startRun(own);
		const q1 = (await call(first.token, 'request_human', { question: 'Q1: A oder B?', options: [{ label: 'A' }, { label: 'B' }] })).body.question_id;
		runs.finishRun(db, system, first.runId, { state: 'paused' });
		questions.answerQuestion(db, user, q1, { option: 1 });

		const second = startRun(own, first.runId);
		expect((await call(second.token, 'get_ticket')).body.human_answer).toMatchObject({ question_id: q1, answer: { option: 1 } });
		const q2 = (await call(second.token, 'request_human', { question: 'Q2: C oder D?' })).body.question_id;
		const { body } = await call(second.token, 'get_ticket');
		expect(body).not.toHaveProperty('human_answer');
		expect(body.pending_question).toEqual({ question_id: q2, question: 'Q2: C oder D?' });
	});
});

describe('secrets', () => {
	it('masks secret values before an agent write is stored and in every tool result', async () => {
		const { db, call, startRun, ticket } = setup();
		const secret = 'sk-test-mcp-secret-4711';
		setSecret(db, 'probe', secret, false, randomBytes(32));
		const own = ticket();
		const { token } = startRun(own);

		await call(token, 'add_comment', { text: `key is ${secret}` });
		await call(token, 'update_ticket', { description: `key ${secret}` });
		await call(token, 'add_tasks', { titles: [`task ${secret}`] });
		await call(token, 'request_human', { question: `use ${secret}?`, options: [{ label: secret }] });
		const stored = writableRows(db);
		expect(stored).not.toContain(secret);
		expect(stored).toContain('[secret:probe]');

		board.addComment(db, user, own, `pasted by a human: ${secret}`);
		const view = JSON.stringify((await call(token, 'get_ticket')).body);
		expect(view).not.toContain(secret);
		expect(view).toContain('pasted by a human: [secret:probe]');
	});
});

async function expectSchemaRefusal(_case: string, name: string, args: object) {
	const { db, call, startRun, ticket } = setup();
	const { token } = startRun(ticket());
	const before = writableRows(db);
	const refused = await call(token, name, args);
	expect(refused.isError).toBe(true);
	expect(refused.body).toMatch(/^Input validation error/);
	expect(writableRows(db)).toBe(before);
}

describe('argument types', () => {
	const mistyped: [string, string, object][] = [
		['a fractional ticket', 'get_ticket', { ticket: 1.5 }],
		['a null ticket', 'get_ticket', { ticket: null }],
		['task ids given as strings', 'complete_tasks', { task_ids: ['1'] }],
		['a number as comment text', 'add_comment', { text: 42 }],
		['an array as comment text', 'add_comment', { text: ['a'] }],
		['a constructor key', 'add_comment', { text: 'x', constructor: { prototype: { polluted: true } } }],
		['a __proto__ key inside an option', 'request_human', JSON.parse('{"question": "q", "options": [{"label": "a", "__proto__": {"polluted": true}}]}')]
	];

	it.each(mistyped)('rejects %s in the schema, before anything is written', expectSchemaRefusal);

	it('drops a top-level __proto__ key without polluting any prototype', async () => {
		const { db, call, startRun, ticket } = setup();
		const { token } = startRun(ticket());
		const written = await call(token, 'add_comment', JSON.parse('{"text": "x", "__proto__": {"polluted": true}}'));
		expect(written.isError).toBe(false);
		expect(db.prepare('SELECT body FROM comments').all()).toEqual([{ body: 'x' }]);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it('answers arguments that are no object and unknown tools with a protocol error', async () => {
		const { db, serve, startRun, ticket } = setup();
		const { token } = startRun(ticket());
		const callError = async (name: string, args: unknown) => (await messageOf(await rpc(serve, token, 'tools/call', { name, arguments: args }))).error;
		expect(await callError('add_comment', ['a'])).toMatchObject({ code: -32602 });
		expect(await callError('delete_ticket', {})).toMatchObject({ code: -32602, message: expect.stringContaining('delete_ticket') });
		expect(db.prepare('SELECT count(*) AS n FROM comments').get()?.n).toBe(0);
	});
});

describe('size limits', () => {
	const oversized: [string, string, object][] = [
		['comment text', 'add_comment', { text: 'x'.repeat(20_001) }],
		['ticket title', 'update_ticket', { title: 'x'.repeat(201) }],
		['ticket description', 'update_ticket', { description: 'x'.repeat(20_001) }],
		['task title', 'add_tasks', { titles: ['x'.repeat(201)] }],
		['number of new tasks', 'add_tasks', { titles: Array.from({ length: 51 }, (_, i) => `T${i}`) }],
		['number of task ids', 'complete_tasks', { task_ids: Array.from({ length: 51 }, (_, i) => i + 1) }],
		['question', 'request_human', { question: 'x'.repeat(2001) }],
		['option label', 'request_human', { question: 'q', options: [{ label: 'x'.repeat(101) }] }],
		['option effect', 'request_human', { question: 'q', options: [{ label: 'a', effect: 'x'.repeat(201) }] }],
		['ticket ref', 'get_ticket', { ticket: 'STU-'.padEnd(21, '1') }]
	];

	it.each(oversized)('rejects an oversized %s in the schema, before anything is written', expectSchemaRefusal);

	it('accepts a comment of exactly the maximum length', async () => {
		const { call, startRun, ticket } = setup();
		const { token } = startRun(ticket());
		expect((await call(token, 'add_comment', { text: 'x'.repeat(20_000) })).isError).toBe(false);
	});

	it('cuts long comments in get_ticket and says how to read one in full', async () => {
		const { db, call, startRun, ticket } = setup();
		const own = ticket();
		const long = 'a'.repeat(5000);
		const commentId = board.addComment(db, user, own, long).id;
		const { token } = startRun(own);

		const [shown] = (await call(token, 'get_ticket')).body.comments;
		expect(shown.text).toBe(`${'a'.repeat(1500)}…`);
		expect(shown.more).toBe(`get_ticket {"comment": ${commentId}}`);
		expect((await call(token, 'get_ticket', { comment: commentId })).body).toMatchObject({ id: commentId, text: long });
	});
});

describe('other projects', () => {
	it('shows a related ticket of another project only by ref, and none of its comments', async () => {
		const { db, call, startRun, ticket } = setup();
		const other = board.createProject(db, user, { key: 'OTH', name: 'Anderes' }).id;
		const foreign = board.createTicket(db, user, other, { title: 'Geheimer Plan' }).id;
		const foreignComment = board.addComment(db, user, foreign, 'Geheime Notiz').id;
		const own = ticket();
		board.linkRelation(db, user, foreign, own, 'blocks');
		const { token } = startRun(own);

		const { body } = await call(token, 'get_ticket');
		expect(body.waits_for).toEqual([{ ref: 'OTH-1', other_project: true, blocking: true }]);
		expect(JSON.stringify(body)).not.toContain('Geheimer Plan');
		expect((await call(token, 'get_ticket', { comment: foreignComment })).body.error).toBe('not_found');
	});
});

describe('authorization header', () => {
	it('accepts the bearer scheme in any case and with several spaces, and no other scheme', async () => {
		const { serve, startRun, ticket } = setup();
		const { token } = startRun(ticket());
		const statusWith = async (authorization: string) =>
			(
				await serve(
					new Request('http://127.0.0.1:3000/mcp', {
						method: 'POST',
						headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization },
						body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
					})
				)
			).status;
		expect(await statusWith(`bearer ${token}`)).toBe(200);
		expect(await statusWith(`Bearer   ${token}`)).toBe(200);
		expect(await statusWith(`Bearer ${token} `)).toBe(200);
		expect(await statusWith(`Basic ${token}`)).toBe(401);
		expect(await statusWith(token)).toBe(401);
		expect(await statusWith(`Bearer ${token}, Bearer ${token}`)).toBe(401);
	});
});

describe('update_ticket', () => {
	it('rejects a blank title', async () => {
		const { db, call, startRun, ticket } = setup();
		const own = ticket('Titel');
		const { token } = startRun(own);
		expect((await call(token, 'update_ticket', { title: '   ' })).body.error).toBe('empty_title');
		expect(db.prepare('SELECT title FROM tickets WHERE id = ?').get(own)?.title).toBe('Titel');
	});
});

describe('tool schemas', () => {
	it('hands every request the same schema objects, so the validator cache does not grow with requests', async () => {
		const { serve, startRun, ticket } = setup();
		const { token } = startRun(ticket());
		const toolCount = (await resultOf(await rpc(serve, token, 'tools/list'))).tools.length;
		const registerTool = vi.spyOn(McpServer.prototype, 'registerTool');
		try {
			for (let i = 0; i < 3; i++) await rpc(serve, token, 'tools/list');
			const schemas = registerTool.mock.calls.map(([, config]) => (config as { inputSchema: unknown }).inputSchema);
			expect(schemas).toHaveLength(3 * toolCount);
			expect(new Set(schemas).size).toBe(toolCount);
		} finally {
			registerTool.mockRestore();
		}
	});
});
