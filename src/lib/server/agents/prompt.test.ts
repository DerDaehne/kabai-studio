import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import * as board from '../domain/board';
import { DomainError, type Actor } from '../domain/core';
import * as notes from '../domain/notes';
import * as runs from '../domain/runs';
import { mcpEndpoint } from '../mcp';
import { BASE_PROMPT, HANDOFF_TEMPLATE } from './base-prompt';
import { assemblePrompt, type PromptRun } from './prompt';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };

type ProfileFields = PromptRun['profile'];
const cloud: ProfileFields = { model: 'any-cloud-model', pool: 'cloud', params: {}, extra_prompt: '' };
const local: ProfileFields = { ...cloud, pool: 'local' };

/** A small board: STU-1 in work, waiting for STU-2 and blocking STU-3, with tasks, comments and a linked note. */
function world() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const col = Object.fromEntries(db.prepare('SELECT name, id FROM columns WHERE project_id = ?').all(projectId).map((r) => [r.name, r.id])) as Record<string, number>;
	const ticket = (title: string, column: string, description = '') => board.createTicket(db, user, projectId, { title, description, column_id: col[column] }).id;
	const setRole = (column: string, rolePrompt: string) => db.prepare('UPDATE columns SET role_prompt = ? WHERE id = ?').run(rolePrompt, col[column]);
	const setDescription = (ticketId: number, description: string) => board.updateTicket(db, user, ticketId, { description });
	/** Comments get a fixed time, so two worlds built one after the other read the same. */
	const comment = (ticketId: number, body: string, day: number) => {
		const { id } = board.addComment(db, user, ticketId, body);
		db.prepare('UPDATE comments SET created_at = ? WHERE id = ?').run(`2026-01-${String(day).padStart(2, '0')} 10:00:00`, id);
	};
	const note = (ticketId: number, slug: string, body: string) => {
		const { id } = notes.createNote(db, user, { slug, title: `About ${slug}`, body, projectIds: [projectId] });
		notes.linkTicket(db, user, id, ticketId, 'references');
	};

	const parser = ticket('Write the config parser', 'In Arbeit', 'Parse the config file into a map.');
	const format = ticket('Define the config format', 'Review');
	const docs = ticket('Document the config file', 'Backlog');
	board.linkRelation(db, user, format, parser, 'blocks');
	board.linkRelation(db, user, parser, docs, 'blocks');
	const [readsLines] = board.addTasks(db, user, parser, ['Parser reads key=value lines', 'Parser rejects duplicate keys']).ids;
	board.completeTask(db, user, readsLines);
	setRole('In Arbeit', 'Implement the ticket test-first. Move it to Review when every task is done.');
	comment(parser, 'Keep the parser free of dependencies.', 1);
	comment(parser, 'Duplicate keys are an error, not a warning.', 2);
	note(parser, 'config-format', 'Lines are key=value; # starts a comment.');
	return { db, projectId, parser, ticket, setRole, setDescription, comment, note };
}

const assemble = (w: ReturnType<typeof world>, profile = cloud, opts = {}) => assemblePrompt(w.db, { ticketId: w.parser, profile }, opts);

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

		const order = (text: string, markers: string[]) => markers.map((marker) => text.indexOf(marker));
		const systemOrder = order(first.system, [BASE_PROMPT.full, '## Role', '## Override — takes precedence']);
		expect(systemOrder.every((at) => at >= 0)).toBe(true);
		expect(systemOrder).toEqual([...systemOrder].sort((a, b) => a - b));
		expect(first.user.indexOf('## Internal context — never copy into repository artifacts')).toBe(0);
		expect(first.user.indexOf('## Assignment')).toBeGreaterThan(0);
	});
});

describe('override', () => {
	it('comes last under its own heading, so it wins over a contradicting role', () => {
		const w = world();
		w.setRole('In Arbeit', 'Move the ticket to Review when you are done.');
		const { system } = assemble(w, { ...cloud, extra_prompt: 'Do not move the ticket.' }, { override: 'Stop after the first task.' });
		expect(system.endsWith('## Override — takes precedence\nDo not move the ticket.\n\nStop after the first task.')).toBe(true);
		expect(system.indexOf('Do not move the ticket.')).toBeGreaterThan(system.indexOf('Move the ticket to Review when you are done.'));
	});

	it('leaves the override out when neither profile nor run sets one', () => {
		expect(assemble(world()).system).not.toContain('## Override');
	});
});

describe('base prompt', () => {
	it.each(['full', 'compact'] as const)('the %s variant states the relation reading, the defaults, the thinking rule and the handoff', (variant) => {
		const base = BASE_PROMPT[variant];
		expect(base).toContain('A blocks B = A must be finished before B starts');
		expect(base).toContain('one process, no ORM, add dependencies sparingly, no required environment variables');
		expect(base).toContain('think briefly; decide, change, verify — one small step at a time');
		expect(base).toContain('`request_human`');
		expect(base).toContain(HANDOFF_TEMPLATE);
		expect(base).toContain('then `move_ticket` as your last action');
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
		expect(assemble(w, cloud, { publicRepository: true }).user).toContain('in repository artifacts only (STU-1) in the commit subject');
		expect(assemble(w).user).not.toContain('commit subject');
	});
});

describe('internal context', () => {
	it('lists tasks with ids, relations with their reading, comments, allowed moves and linked notes', () => {
		const w = world();
		const { user: text } = assemble(w);
		const [done, open] = w.db.prepare('SELECT id FROM tasks WHERE ticket_id = ? ORDER BY id').all(w.parser).map((r) => r.id as number);
		expect(text).toContain(`- [x] ${done}: Parser reads key=value lines`);
		expect(text).toContain(`- [ ] ${open}: Parser rejects duplicate keys`);
		expect(text).toContain('- waits for STU-2 "Define the config format" (Review), still blocking');
		expect(text).toContain('- blocks STU-3 "Document the config file" (Backlog)');
		expect(text).toContain('Duplicate keys are an error, not a warning.');
		expect(text).toMatch(/- \d+: Review\b/);
		expect(text).toContain('Lines are key=value; # starts a comment.');
	});
});

describe('budget', () => {
	// The default context of 32k tokens gives a prompt budget of 11,468 tokens, about 45,800 characters.
	const tenComments = (w: ReturnType<typeof world>) => {
		for (let day = 3; day <= 10; day++) w.comment(w.parser, `Comment ${day} `.padEnd(1500, 'x'), day);
	};

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
		expect(['Comment 8 ', 'Comment 9 ', 'Comment 10 '].every((c) => prompt.user.includes(c))).toBe(true);
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
		board.addTasks(w.db, user, w.parser, Array.from({ length: 40 }, (_, i) => `Criterion ${i} `.padEnd(190, 'c')));
		w.setDescription(w.parser, 'd'.repeat(60_000));
		const prompt = assemble(w, local);
		expect(prompt.user).toContain('Criterion 39 ');
		expect(prompt.user).toMatch(/- \d+: Review\b/);
		expect(prompt.blocks.filter((b) => b.name === 'tasks' || b.name === 'allowed_moves').every((b) => !b.truncated)).toBe(true);
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
		expect(assemble(w, { ...local, params: { prompt_variant: 'full' } }).system.startsWith(BASE_PROMPT.full)).toBe(true);
		expect(assemble(w, { ...cloud, params: { prompt_variant: 'compact' } }).system.startsWith(BASE_PROMPT.compact)).toBe(true);
	});
});

describe('blocks and estimate', () => {
	it('name every block in prompt order with its characters and whether it was cut', () => {
		const prompt = assemble(world(), { ...cloud, extra_prompt: 'Answer in short sentences.' });
		expect(prompt.blocks.map((b) => b.name)).toEqual(['base', 'role', 'override', 'ticket', 'tasks', 'relations', 'comments', 'allowed_moves', 'notes', 'assignment']);
		expect(prompt.blocks.every((b) => b.chars > 0 && b.truncated === false)).toBe(true);
		const separators = 2 * (prompt.blocks.length - 2);
		expect(prompt.blocks.reduce((sum, b) => sum + b.chars, 0) + separators).toBe(prompt.system.length + prompt.user.length);
		expect(prompt.estimate).toBe(Math.ceil((prompt.system.length + prompt.user.length) / 4));
	});
});

describe('tool names', () => {
	const SNAKE_CASE = /\b[a-z]+(?:_[a-z]+)+\b/g;
	// The context also quotes domain messages, so only the names it puts in backticks claim to be tools.
	const BACKTICKED_SNAKE_CASE = /(?<=`)[a-z]+(?:_[a-z]+)+(?=`)/g;

	async function registeredToolVocabulary() {
		const db = openDb(':memory:');
		migrate(db);
		const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
		const ticketId = board.createTicket(db, user, projectId, { title: 'T' }).id;
		const profileId = runs.createProfile(db, user, { name: 'Test', executor: 'builtin', provider: 'openai-compatible', model: 'm' }).id;
		const runId = runs.createRun(db, user, { ticketId, profileId }).id;
		const { token } = runs.startRun(db, system, runId);
		const response = await mcpEndpoint(db)(
			new Request('http://127.0.0.1:3000/mcp', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
			})
		);
		const text = await response.text();
		const json = text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
		const tools = JSON.parse(json).result.tools as { name: string; inputSchema: { properties?: object } }[];
		return new Set(tools.flatMap((t) => [t.name, ...Object.keys(t.inputSchema.properties ?? {})]));
	}

	it('names only registered studio MCP tools and their arguments, in the base prompt and the internal context', async () => {
		const vocabulary = await registeredToolVocabulary();
		const { user: context } = assemble(world(), local);
		const inBase = [BASE_PROMPT.full, BASE_PROMPT.compact].flatMap((text) => text.match(SNAKE_CASE) ?? []);
		const inContext = context.match(BACKTICKED_SNAKE_CASE) ?? [];
		expect(inContext.length).toBeGreaterThan(0);
		const named = new Set([...inBase, ...inContext]);
		expect([...named].filter((name) => !vocabulary.has(name))).toEqual([]);
	});
});
