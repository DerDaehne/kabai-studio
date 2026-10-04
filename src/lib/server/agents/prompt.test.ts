import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import * as board from '../domain/board';
import { DomainError, type Actor } from '../domain/core';
import { pauseRun, resumeRun } from '../domain/halt';
import * as notes from '../domain/notes';
import { answerQuestion, requestHuman, retractAnswer } from '../domain/questions';
import * as runs from '../domain/runs';
import { subscribe, type StudioEvent } from '../events';
import { mcpEndpoint } from '../mcp';
import { setSecret } from '../secrets';
import { BASE_PROMPT, HANDOFF_TEMPLATE } from './base-prompt';
import { assemblePrompt, type AssembledPrompt, type PromptRun } from './prompt';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };

type ProfileFields = PromptRun['profile'];
const cloud: ProfileFields = {
	model: 'any-cloud-model',
	pool: 'cloud',
	params: {},
	extra_prompt: ''
};
const local: ProfileFields = { ...cloud, pool: 'local' };

/** A small board: STU-1 in work, waiting for STU-2 and blocking STU-3, with tasks, comments and a linked note. */
function world() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const col = Object.fromEntries(
		db
			.prepare('SELECT name, id FROM columns WHERE project_id = ?')
			.all(projectId)
			.map((r) => [r.name, r.id])
	) as Record<string, number>;
	const ticket = (title: string, column: string, description = '') =>
		board.createTicket(db, user, projectId, { title, description, column_id: col[column] }).id;
	const setRole = (column: string, rolePrompt: string) =>
		db.prepare('UPDATE columns SET role_prompt = ? WHERE id = ?').run(rolePrompt, col[column]);
	const setDescription = (ticketId: number, description: string) =>
		board.updateTicket(db, user, ticketId, { description });
	/** Comments get a fixed time, so two worlds built one after the other read the same. */
	const comment = (ticketId: number, body: string, day: number) => {
		const { id } = board.addComment(db, user, ticketId, body);
		db.prepare('UPDATE comments SET created_at = ? WHERE id = ?').run(
			`2026-01-${String(day).padStart(2, '0')} 10:00:00`,
			id
		);
	};
	const note = (ticketId: number, slug: string, body: string) => {
		const { id } = notes.createNote(db, user, {
			slug,
			title: `About ${slug}`,
			body,
			projectIds: [projectId]
		});
		notes.linkTicket(db, user, id, ticketId, 'references');
	};

	const parser = ticket(
		'Write the config parser',
		'In Arbeit',
		'Parse the config file into a map.'
	);
	const format = ticket('Define the config format', 'Review');
	const docs = ticket('Document the config file', 'Backlog');
	board.linkRelation(db, user, format, parser, 'blocks');
	board.linkRelation(db, user, parser, docs, 'blocks');
	const [readsLines] = board.addTasks(db, user, parser, [
		'Parser reads key=value lines',
		'Parser rejects duplicate keys'
	]).ids;
	board.completeTask(db, user, readsLines);
	setRole(
		'In Arbeit',
		'Implement the ticket test-first. Move it to Review when every task is done.'
	);
	comment(parser, 'Keep the parser free of dependencies.', 1);
	comment(parser, 'Duplicate keys are an error, not a warning.', 2);
	note(parser, 'config-format', 'Lines are key=value; # starts a comment.');
	return { db, projectId, parser, ticket, setRole, setDescription, comment, note };
}

type World = ReturnType<typeof world>;

const assemble = (w: World, profile = cloud, opts = {}) =>
	assemblePrompt(w.db, { ticketId: w.parser, profile }, opts);

/** Brings the comments of STU-1 to ten, eight of them long enough to matter for the budget. */
function tenComments(w: World) {
	for (let day = 3; day <= 10; day++) w.comment(w.parser, `Comment ${day} `.padEnd(1500, 'x'), day);
}

/** A local-model prompt in which note bodies, comments and the description are all cut. */
function fullyCutPrompt() {
	const w = world();
	w.note(w.parser, 'large-note', 'n'.repeat(16_000));
	tenComments(w);
	w.setDescription(w.parser, 'd'.repeat(60_000));
	return assemble(w, local);
}

/** Calls the studio MCP endpoint as a run of the ticket and returns the JSON-RPC result, as an agent receives it. */
async function asRunOf(db: DatabaseSync, ticketId: number, method: string, params?: object) {
	const profileId = runs.createProfile(db, user, {
		name: `run-of-${ticketId}-${method}`,
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const runId = runs.createRun(db, user, { ticketId, profileId }).id;
	const { token } = runs.startRun(db, system, runId);
	const response = await mcpEndpoint(db)(
		new Request('http://127.0.0.1:3000/mcp', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				authorization: `Bearer ${token}`
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
		})
	);
	const text = await response.text();
	const json = text.startsWith('{')
		? text
		: text
				.split('\n')
				.find((line) => line.startsWith('data: '))!
				.slice('data: '.length);
	return JSON.parse(json).result;
}

function tooLargeError(work: () => unknown): DomainError {
	try {
		work();
	} catch (err) {
		if (err instanceof DomainError) return err;
		throw err;
	}
	throw new Error('expected a DomainError');
}

describe('assemblePrompt is deterministic', () => {
	it('reads the same text from the same database content, in the order base, role, override | internal context, assignment', () => {
		const first = assemble(world(), { ...cloud, extra_prompt: 'Answer in short sentences.' });
		const second = assemble(world(), { ...cloud, extra_prompt: 'Answer in short sentences.' });
		expect(second).toEqual(first);
		expect(`${first.system}\n\n===== user =====\n\n${first.user}`).toMatchSnapshot();

		const order = (text: string, markers: string[]) =>
			markers.map((marker) => text.indexOf(marker));
		const systemOrder = order(first.system, [
			BASE_PROMPT.full,
			'## Role',
			'## Override — takes precedence'
		]);
		expect(systemOrder.every((at) => at >= 0)).toBe(true);
		expect(systemOrder).toEqual([...systemOrder].sort((a, b) => a - b));
		expect(first.user.indexOf('## Internal context — never copy into repository artifacts')).toBe(
			0
		);
		expect(first.user.indexOf('## Assignment')).toBeGreaterThan(0);
	});
});

describe('override', () => {
	it('comes last under its own heading, so it wins over a contradicting role', () => {
		const w = world();
		w.setRole('In Arbeit', 'Move the ticket to Review when you are done.');
		const { system } = assemble(
			w,
			{ ...cloud, extra_prompt: 'Do not move the ticket.' },
			{ override: 'Stop after the first task.' }
		);
		expect(
			system.endsWith(
				'## Override — takes precedence\nDo not move the ticket.\n\nStop after the first task.'
			)
		).toBe(true);
		expect(system.indexOf('Do not move the ticket.')).toBeGreaterThan(
			system.indexOf('Move the ticket to Review when you are done.')
		);
	});

	it('leaves the override out when neither profile nor run sets one', () => {
		expect(assemble(world()).system).not.toContain('## Override');
	});
});

describe('base prompt', () => {
	it.each(['full', 'compact'] as const)(
		'the %s variant states the relation reading, the defaults, the thinking rule and the handoff',
		(variant) => {
			const base = BASE_PROMPT[variant];
			expect(base).toContain('A blocks B = A must be finished before B starts');
			expect(base).toContain(
				'one process, no ORM, add dependencies sparingly, no required environment variables'
			);
			expect(base).toContain('think briefly; decide, change, verify — one small step at a time');
			expect(base).toContain('`request_human`');
			expect(base).toContain(HANDOFF_TEMPLATE);
			expect(base).toContain('then `move_ticket` as your last action');
		}
	);

	it.each(['full', 'compact'] as const)(
		'the %s variant says the agent can only act on the board and forbids claiming that anything ran',
		(variant) => {
			const base = BASE_PROMPT[variant];
			expect(base).toContain('Your tools act only on this board');
			expect(base).toContain('no file, shell or execution tool');
			expect(base).toContain('nothing is compiled, run or tested');
			expect(base).toContain(
				'Deliver code as a fenced block in a comment, marked "Unverified: not compiled, run or tested."'
			);
			expect(base).toMatch(/never claim that something was compiled, run or tested/i);
		}
	);

	it('the full variant names every studio MCP tool the agent has', async () => {
		const w = world();
		const { tools } = (await asRunOf(w.db, w.parser, 'tools/list')) as {
			tools: { name: string }[];
		};
		expect(tools.length).toBeGreaterThan(0);
		for (const { name } of tools) expect(BASE_PROMPT.full).toContain(`\`${name}\``);
	});

	it('the handoff template names its sections in order and stays within 25 lines', () => {
		const sections = ['Summary', 'Changes/Commits', 'Verification', 'Decisions', 'Open', 'Next'];
		const at = sections.map((section) => HANDOFF_TEMPLATE.indexOf(section));
		expect(at.every((index) => index >= 0)).toBe(true);
		expect(at).toEqual([...at].sort((a, b) => a - b));
		expect(HANDOFF_TEMPLATE).toContain('at most 25 lines');
	});

	it('keeps the internal context out of the system part, in its own block of the user part', () => {
		const prompt = assemble(world());
		expect(prompt.system).not.toContain('Write the config parser');
		expect(prompt.user).toMatch(/^## Internal context — never copy into repository artifacts\n/);
		expect(prompt.user).toContain('Write the config parser');
	});

	it('adds the commit-subject rule for a public repository only', () => {
		const w = world();
		expect(assemble(w, cloud, { publicRepository: true }).user).toContain(
			'in repository artifacts only (STU-1) in the commit subject'
		);
		expect(assemble(w).user).not.toContain('commit subject');
	});
});

describe('assignment', () => {
	it('names the ticket and its column, points to the result and the stop of its role, and keeps refining in the Refine column', () => {
		const { user } = assemble(world());
		expect(user.slice(user.indexOf('## Assignment'))).toBe(
			'## Assignment\n' +
				'Work STU-1 in the column "In Arbeit": do what your role for this column says, deliver the result it names and stop where it says. ' +
				'Refine the ticket (rewrite its scope, description or acceptance criteria) only in the Refine column or when your role asks for it. ' +
				'The internal context above is current: start with the work, not with `get_ticket`.'
		);
	});
});

describe('internal context', () => {
	it('lists tasks with ids, relations with their reading, comments, allowed moves and linked notes', () => {
		const w = world();
		const { user: text } = assemble(w);
		const [done, open] = w.db
			.prepare('SELECT id FROM tasks WHERE ticket_id = ? ORDER BY id')
			.all(w.parser)
			.map((r) => r.id as number);
		expect(text).toContain(`- [x] ${done}: Parser reads key=value lines`);
		expect(text).toContain(`- [ ] ${open}: Parser rejects duplicate keys`);
		expect(text).toContain('- waits for STU-2 "Define the config format" (Review), still blocking');
		expect(text).toContain('- blocks STU-3 "Document the config file" (Backlog)');
		expect(text).toContain('Duplicate keys are an error, not a warning.');
		expect(text).toMatch(/- \d+: Review\b/);
		expect(text).toContain('Lines are key=value; # starts a comment.');
	});

	it('shows a note linked to the ticket twice once, with both relations', () => {
		const w = world();
		const { id } = w.db.prepare("SELECT id FROM notes WHERE slug = 'config-format'").get() as {
			id: number;
		};
		notes.linkTicket(w.db, user, id, w.parser, 'documents');
		const { user: context } = assemble(w);
		expect(context).toContain('#### config-format: About config-format (documents, references)');
		expect(context.match(/#### config-format:/g)).toHaveLength(1);
	});

	it('names the way to the full text of a comment longer than the preview', () => {
		const w = world();
		const { id } = board.addComment(w.db, user, w.parser, 'L'.repeat(2000));
		expect(assemble(w).user).toContain(`(cut; get_ticket {"comment": ${id}} reads it in full)`);
	});

	it('shows a related ticket of another project only by its ref', () => {
		const w = world();
		const otherProject = board.createProject(w.db, user, { key: 'OTH', name: 'Other' }).id;
		const foreign = board.createTicket(w.db, user, otherProject, { title: 'Foreign plan' }).id;
		board.linkRelation(w.db, user, foreign, w.parser, 'blocks');
		const { user: context } = assemble(w);
		expect(context).toContain('- waits for OTH-1 (other project)');
		expect(context).not.toContain('Foreign plan');
	});
});

describe('budget', () => {
	// The default context of 32k tokens gives a prompt budget of 11,468 tokens, about 45,800 characters.
	it('cuts note bodies to slug and title first and keeps every comment', () => {
		const w = world();
		w.note(w.parser, 'large-note', 'n'.repeat(48_000));
		tenComments(w);
		const prompt = assemble(w, local);
		expect(prompt.user).not.toContain('nnnn');
		expect(prompt.user).toContain('- large-note: About large-note (references)');
		expect(prompt.user).toContain('Keep the parser free of dependencies.');
		expect(prompt.user).toContain('Comment 10 ');
		expect(prompt.blocks.find((b) => b.name === 'notes')?.truncated).toBe(true);
		expect(prompt.blocks.find((b) => b.name === 'comments')?.truncated).toBe(false);
	});

	it('then keeps only the last 3 comments', () => {
		const w = world();
		w.note(w.parser, 'large-note', 'n'.repeat(16_000));
		w.setDescription(w.parser, 'd'.repeat(36_000));
		tenComments(w);
		const prompt = assemble(w, local);
		expect(prompt.user).not.toContain('Comment 7 ');
		expect(['Comment 8 ', 'Comment 9 ', 'Comment 10 '].every((c) => prompt.user.includes(c))).toBe(
			true
		);
		expect(prompt.blocks.find((b) => b.name === 'comments')?.truncated).toBe(true);
		expect(prompt.blocks.find((b) => b.name === 'ticket')?.truncated).toBe(false);
	});

	it('then leaves out all comments, and only then cuts the description at 8,000 characters', () => {
		const w = world();
		tenComments(w);
		w.setDescription(w.parser, 'd'.repeat(40_000));
		expect(assemble(w, local).user).not.toContain('Comment ');
		expect(assemble(w, local).user).toContain('d'.repeat(40_000));

		w.setDescription(w.parser, 'd'.repeat(60_000));
		const prompt = assemble(w, local);
		expect(prompt.user).toContain(`${'d'.repeat(8000)} [truncated`);
		expect(prompt.user).not.toContain('d'.repeat(8001));
		expect(prompt.blocks.find((b) => b.name === 'ticket')?.truncated).toBe(true);
	});

	it('never cuts tasks or allowed moves', () => {
		const w = world();
		board.addTasks(
			w.db,
			user,
			w.parser,
			Array.from({ length: 40 }, (_, i) => `Criterion ${i} `.padEnd(190, 'c'))
		);
		w.setDescription(w.parser, 'd'.repeat(60_000));
		const prompt = assemble(w, local);
		expect(prompt.user).toContain('Criterion 39 ');
		expect(prompt.user).toMatch(/- \d+: Review\b/);
		expect(
			prompt.blocks
				.filter((b) => b.name === 'tasks' || b.name === 'allowed_moves')
				.every((b) => !b.truncated)
		).toBe(true);
	});

	it('refuses with prompt_too_large and a way out when even the cut prompt exceeds the budget', () => {
		const w = world();
		w.setRole('In Arbeit', 'r'.repeat(50_000));
		const err = tooLargeError(() => assemble(w, local));
		expect(err.code).toBe('prompt_too_large');
		expect(err.hint).toMatch(/Notes/);
		expect(err.hint).toMatch(/kleiner schneiden/);
		expect(err.hint).toMatch(/mehr Kontext/);
	});

	it("plans with the model's context: a 128k model fits what a 32k model cannot", () => {
		const w = world();
		w.setRole('In Arbeit', 'r'.repeat(50_000));
		expect(() => assemble(w, { ...local, model: 'qwen3.6-35b' })).not.toThrow();
	});
});

describe('output nothing can produce', () => {
	// Board agents have no execution tool, so a prompt asking for test or command output gets invented output back.
	const ASKS_FOR_EXECUTION_OUTPUT: RegExp[] = [
		/verification output/i,
		/real output/i,
		/commands? you ran/i,
		/failing test/i,
		/test-first/i,
		/\b(compile|execute|run) (it|the code|your code|the tests?)\b/i
	];

	/** Every default role reaches the model through the prompt of a ticket in its column, in both variants. */
	function promptsOfEveryDefaultRole() {
		const w = world();
		const projectId = board.createProject(w.db, user, { key: 'DEF', name: 'Defaults' }).id;
		const columns = w.db
			.prepare("SELECT id, name FROM columns WHERE project_id = ? AND role_prompt <> ''")
			.all(projectId) as { id: number; name: string }[];
		return columns.flatMap(({ id, name }) => {
			const ticketId = board.createTicket(w.db, user, projectId, {
				title: `Ticket in ${name}`,
				column_id: id
			}).id;
			return [cloud, local].map((profile) => assemblePrompt(w.db, { ticketId, profile }));
		});
	}

	it('is asked for by no part of any prompt: base prompts, handoff template, default roles or assignment', () => {
		const prompts = promptsOfEveryDefaultRole();
		expect(prompts).toHaveLength(16);
		expect(prompts.every((prompt) => prompt.system.includes('## Role:'))).toBe(true);
		const texts = [BASE_PROMPT.full, BASE_PROMPT.compact, HANDOFF_TEMPLATE].concat(
			prompts.map((prompt) => `${prompt.system}\n${prompt.user}`)
		);
		for (const text of texts)
			for (const pattern of ASKS_FOR_EXECUTION_OUTPUT) expect(text).not.toMatch(pattern);
	});
});

describe('variant and size', () => {
	it('keeps the compact base prompt within 500 and the full one within 1,200 tokens (characters / 4)', () => {
		expect(Math.ceil(BASE_PROMPT.compact.length / 4)).toBeLessThanOrEqual(500);
		expect(Math.ceil(BASE_PROMPT.full.length / 4)).toBeLessThanOrEqual(1200);
	});

	it('uses the compact variant for the local pool and the full one otherwise', () => {
		const w = world();
		expect(assemble(w, local).system.startsWith(BASE_PROMPT.compact)).toBe(true);
		expect(assemble(w, cloud).system.startsWith(BASE_PROMPT.full)).toBe(true);
	});

	it('lets the profile parameter prompt_variant override the pool default', () => {
		const w = world();
		expect(
			assemble(w, { ...local, params: { prompt_variant: 'full' } }).system.startsWith(
				BASE_PROMPT.full
			)
		).toBe(true);
		expect(
			assemble(w, { ...cloud, params: { prompt_variant: 'compact' } }).system.startsWith(
				BASE_PROMPT.compact
			)
		).toBe(true);
	});
});

describe('blocks and estimate', () => {
	it('name every block in prompt order with its characters and whether it was cut', () => {
		const prompt = assemble(world(), { ...cloud, extra_prompt: 'Answer in short sentences.' });
		expect(prompt.blocks.map((b) => b.name)).toEqual([
			'base',
			'role',
			'override',
			'ticket',
			'tasks',
			'relations',
			'comments',
			'allowed_moves',
			'notes',
			'assignment'
		]);
		expect(prompt.blocks.every((b) => b.chars > 0 && b.truncated === false)).toBe(true);
		const separators = 2 * (prompt.blocks.length - 2);
		expect(prompt.blocks.reduce((sum, b) => sum + b.chars, 0) + separators).toBe(
			prompt.system.length + prompt.user.length
		);
		expect(prompt.estimate).toBe(Math.ceil((prompt.system.length + prompt.user.length) / 4));
	});
});

describe('tool names', () => {
	const SNAKE_CASE = /\b[a-z]+(?:_[a-z]+)+\b/g;
	// The context also quotes domain messages, so only the names it puts in backticks claim to be tools.
	const BACKTICKED_SNAKE_CASE = /(?<=`)[a-z]+(?:_[a-z]+)+(?=`)/g;

	async function registeredToolVocabulary() {
		const w = world();
		const { tools } = (await asRunOf(w.db, w.parser, 'tools/list')) as {
			tools: { name: string; inputSchema: { properties?: object } }[];
		};
		return new Set(tools.flatMap((t) => [t.name, ...Object.keys(t.inputSchema.properties ?? {})]));
	}

	it('names only registered studio MCP tools and their arguments, in the base prompt and the internal context, cut or not', async () => {
		const vocabulary = await registeredToolVocabulary();
		const cut = fullyCutPrompt();
		expect(cut.blocks.filter((b) => b.truncated).map((b) => b.name)).toEqual([
			'ticket',
			'comments',
			'notes'
		]);
		const inBase = [BASE_PROMPT.full, BASE_PROMPT.compact].flatMap(
			(text) => text.match(SNAKE_CASE) ?? []
		);
		const inContext = [assemble(world(), local).user, cut.user].flatMap(
			(text) => text.match(BACKTICKED_SNAKE_CASE) ?? []
		);
		expect(inContext).toContain('notes_get');
		const named = new Set([...inBase, ...inContext]);
		expect([...named].filter((name) => !vocabulary.has(name))).toEqual([]);
	});
});

describe('boundaries shared with get_ticket', () => {
	it('masks a stored secret in the context before it reaches the model', () => {
		const w = world();
		const secret = 'sk-test-prompt-secret-4711';
		setSecret(w.db, 'probe', secret, false, randomBytes(32));
		w.comment(w.parser, `the key is ${secret}`, 3);
		const { user: context } = assemble(w);
		expect(context).not.toContain(secret);
		expect(context).toContain('[secret:probe]');
	});

	it('leaves out a note of another project, even one a human linked to the ticket', () => {
		const w = world();
		const otherProject = board.createProject(w.db, user, { key: 'OTH', name: 'Other' }).id;
		const foreign = notes.createNote(w.db, user, {
			slug: 'foreign-plan',
			title: 'Foreign plan',
			body: 'confidential body',
			projectIds: [otherProject]
		}).id;
		notes.linkTicket(w.db, user, foreign, w.parser, 'references');
		const { user: context } = assemble(w);
		expect(context).not.toContain('foreign-plan');
		expect(context).not.toContain('confidential body');
	});

	it('leaves out an archived note', () => {
		const w = world();
		const old = notes.createNote(w.db, user, {
			slug: 'old-plan',
			title: 'Old plan',
			body: 'outdated body',
			projectIds: [w.projectId]
		}).id;
		notes.linkTicket(w.db, user, old, w.parser, 'references');
		notes.archiveNote(w.db, user, old);
		expect(assemble(w).user).not.toContain('old-plan');
	});

	it('lists the allowed moves as get_ticket shows them to the run, with human-only moves blocked', async () => {
		const w = world();
		const inAcceptance = w.ticket('Review the config format', 'Abnahme'); // next to Done, the one human-only move from here
		const { content } = await asRunOf(w.db, inAcceptance, 'tools/call', {
			name: 'get_ticket',
			arguments: {}
		});
		const moves = JSON.parse(content[0].text).allowed_moves as {
			column_id: number;
			name: string;
			blocked?: string;
		}[];
		const { user: context } = assemblePrompt(w.db, { ticketId: inAcceptance, profile: local });
		expect(moves.some((m) => m.blocked)).toBe(true);
		for (const m of moves)
			expect(context).toContain(
				`- ${m.column_id}: ${m.name}${m.blocked ? ` — blocked: ${m.blocked}` : ''}`
			);
	});

	it('writes nothing and announces nothing', () => {
		const w = world();
		const events: StudioEvent[] = [];
		const unsubscribe = subscribe((event) => events.push(event));
		const changes = () => (w.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
		const before = changes();
		assemble(w);
		unsubscribe();
		expect(changes()).toBe(before);
		expect(events).toEqual([]);
	});
});

/** Runs of STU-1 for the previous state; each one continues the run before it, as the runner queues a resumed run. */
function runsOf(w: World) {
	const profileId = runs.createProfile(w.db, user, {
		name: 'resuming',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const queued = (resumedFrom?: number) =>
		runs.createRun(w.db, user, {
			ticketId: w.parser,
			profileId,
			resumedFromRunId: resumedFrom,
			resumeReason: resumedFrom === undefined ? undefined : 'recovery'
		}).id;
	const started = (resumedFrom?: number) => {
		const id = queued(resumedFrom);
		runs.startRun(w.db, system, id);
		return id;
	};
	const event = (runId: number, e: Parameters<typeof runs.appendEvent>[3]) =>
		runs.appendEvent(w.db, { kind: 'agent', runId }, runId, e);
	const pause = (runId: number, handoff: { text: string; generated?: true }) => {
		event(runId, { type: 'message', key: 'handoff', payload: handoff });
		runs.finishRun(w.db, system, runId, { state: 'paused' });
	};
	return { queued, started, event, pause };
}

const assembleRun = (w: World, runId: number) =>
	assemblePrompt(w.db, { id: runId, ticketId: w.parser, profile: cloud });
const previousState = (prompt: AssembledPrompt) =>
	prompt.user.slice(
		prompt.user.indexOf('## Previous state'),
		prompt.user.indexOf('\n\n## Assignment')
	);

/** A run that asked the human, got stuck twice and was paused; the human answered its question. */
function answeredRun(w: World, r: ReturnType<typeof runsOf>) {
	const first = r.started();
	const intervention = (attempt: number, reason: string, hint: string) =>
		r.event(first, {
			type: 'intervention',
			payload: { kind: 'stagnation', attempt, max: 2, reason, hint }
		});
	intervention(1, 'The same search ran 6 times without progress.', 'Search once, then decide.');
	intervention(
		2,
		'The exact edit of src/parser.ts failed 3 times.',
		'Do not inspect bytes; replace by line number or rewrite the block.'
	);
	const question = requestHuman(w.db, { kind: 'agent', runId: first }, w.parser, {
		question: 'Reject or merge duplicate keys?',
		options: [
			{ label: 'Reject them', effect: 'a parse error names the line' },
			{ label: 'Merge them' }
		]
	}).id;
	r.pause(first, {
		text: 'Summary: the parser reads key=value lines.\nOpen: duplicate keys.\nNext: reject duplicate keys.'
	});
	answerQuestion(w.db, user, question, { option: 1 });
	return { first, question };
}

describe('previous state', () => {
	it("shows a resumed run the handoff, the human's answer and what not to try again of the run it continues", () => {
		const w = world();
		const r = runsOf(w);
		const { first } = answeredRun(w, r);
		const prompt = assembleRun(w, r.queued(first));
		expect(previousState(prompt)).toMatchSnapshot();
		expect(previousState(prompt)).not.toContain('Search once');
		expect(prompt.blocks.map((b) => b.name).slice(-2)).toEqual(['previous_state', 'assignment']);
	});

	it('tells a run that resumes a run the human halted why it paused; the halt dropped the unfinished step, so there is no handoff', () => {
		const w = world();
		const halted = runsOf(w).started();
		pauseRun(w.db, user, halted);
		const block = previousState(assembleRun(w, resumeRun(w.db, user, halted).id));
		expect(block).toBe(
			`## Previous state — continuation 1\nThis run continues run ${halted}, which paused because the human halted it. Go on from its state instead of starting over.`
		);
	});

	it('is left out for a run that continues no other run and for the preview without a run', () => {
		const w = world();
		const run = runsOf(w).started();
		expect(assembleRun(w, run).blocks.map((b) => b.name)).not.toContain('previous_state');
		expect(assemble(w).user).not.toContain('## Previous state');
	});

	it('shows only the handoff of the last run of a chain of three and counts the continuations', () => {
		const w = world();
		const r = runsOf(w);
		const first = r.started();
		r.pause(first, { text: 'Handoff of the first run.' });
		const second = r.started(first);
		r.pause(second, { text: 'Handoff of the second run.', generated: true });
		const block = previousState(assembleRun(w, r.queued(second)));
		expect(block).toContain('## Previous state — continuation 2');
		expect(block).toContain('Handoff of the second run.');
		expect(block).toContain('generated from its events');
		expect(block).not.toContain('Handoff of the first run.');
		expect(block.length / 4).toBeLessThanOrEqual(1500);
	});

	it('stays within 1,500 tokens by cutting the end of an overlong handoff, and keeps what not to try again', () => {
		const w = world();
		const r = runsOf(w);
		const { first } = answeredRun(w, r);
		w.db
			.prepare(
				"UPDATE run_events SET payload = json_object('text', ?) WHERE run_id = ? AND idempotency_key = 'handoff'"
			)
			.run('h'.repeat(20_000), first);
		const prompt = assembleRun(w, r.queued(first));
		const block = prompt.blocks.find((b) => b.name === 'previous_state')!;
		expect(block.chars / 4).toBeLessThanOrEqual(1500);
		expect(block.truncated).toBe(true);
		expect(previousState(prompt)).toContain('replace by line number');
		expect(previousState(prompt)).toMatch(/h\n\[handoff cut to fit 1,500 tokens\]$/);
	});

	it("reads the human's answer without collecting it, so the human can still retract it until the prompt is sent", () => {
		const w = world();
		const r = runsOf(w);
		const { first, question } = answeredRun(w, r);
		const resumed = r.queued(first);
		const events: StudioEvent[] = [];
		const unsubscribe = subscribe((event) => events.push(event));
		const changes = () => (w.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
		const before = changes();
		const prompt = assembleRun(w, resumed);
		unsubscribe();
		expect(changes()).toBe(before);
		expect(events).toEqual([]);
		expect(prompt.showsHumanAnswer).toBe(true);
		expect(() => retractAnswer(w.db, user, question)).not.toThrow();
	});
});
