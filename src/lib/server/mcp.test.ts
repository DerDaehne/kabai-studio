import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import * as questions from './domain/questions';
import * as runs from './domain/runs';
import { mcpEndpoint } from './mcp';

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

async function resultOf(response: Response) {
	const text = await response.text();
	const isStream = response.headers.get('content-type')?.startsWith('text/event-stream');
	const json = isStream ? text.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length) : text;
	return JSON.parse(json).result;
}

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
});

describe('scope of a run', () => {
	it('reads every ticket of its project, but none of another project', async () => {
		const { db, call, startRun, ticket } = setup();
		const own = ticket('Eigenes');
		ticket('Nachbar');
		const other = board.createProject(db, user, { key: 'OTH', name: 'Anderes' }).id;
		for (let i = 0; i < 3; i++) board.createTicket(db, user, other, { title: 'Fremd' });
		const { token } = startRun(own);

		const neighbour = await call(token, 'get_ticket', { ticket: 2 });
		expect(neighbour.body).toMatchObject({ ref: 'STU-2', title: 'Nachbar' });
		expect(neighbour.body).not.toHaveProperty('allowed_moves');
		const foreign = await call(token, 'get_ticket', { ticket: 3 });
		expect(foreign).toMatchObject({ isError: true, body: { error: 'not_found' } });
	});

	it('refuses writes to other tickets: foreign task ids and a ticket parameter are rejected', async () => {
		const { db, call, startRun, ticket } = setup();
		const [own, neighbour] = [ticket('Eigenes'), ticket('Nachbar')];
		const [foreignTask] = board.addTasks(db, user, neighbour, ['Fremd']).ids;
		const { token } = startRun(own);

		const complete = await call(token, 'complete_tasks', { task_ids: [foreignTask] });
		expect(complete).toMatchObject({ isError: true, body: { error: 'not_found', message: expect.stringContaining(String(foreignTask)) } });
		expect(db.prepare('SELECT done_at FROM tasks WHERE id = ?').get(foreignTask)?.done_at).toBeNull();

		const update = await call(token, 'update_ticket', { ticket: 2, title: 'Gekapert' });
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

describe('identity from the run', () => {
	it('takes comment author, actor and assignee from the run token', async () => {
		const { db, call, startRun, ticket, col } = setup();
		const own = ticket();
		const { runId, token } = startRun(own);
		const label = `agent (Run ${runId})`;

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
		expect(body.human_answer).toEqual({ question: 'A oder B?', options: [{ label: 'A', effect: 'schnell' }, { label: 'B' }], answer: { option: 2 } });
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

// Real tokenizers (a local model's, o200k, cl100k) count about 4.5 characters per token on these definitions; 4 leaves a margin.
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
