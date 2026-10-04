import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai';
import type { DatabaseSync } from 'node:sqlite';
import { contextBudget } from '../../agents/model-catalog';
import * as board from '../domain/board';
import { DomainError } from '../domain/core';
import type { Answer, QuestionOption } from '../domain/questions';
import type { Intervention, Profile, ResumeReason } from '../domain/runs';
import {
	agentMoves,
	linkedNotes,
	recentComments,
	relationsOf,
	tasksOf,
	type AgentMove,
	type NoteLink,
	type RelatedTicket,
	type ToolContext
} from '../mcp';
import { mask } from '../secrets';
import { BASE_PROMPT, type PromptVariant } from './base-prompt';

export type PromptRun = {
	/** The run the prompt is for; one that continues another run gets that run's state. The prompt preview has no run. */
	id?: number;
	ticketId: number;
	profile: Pick<Profile, 'model' | 'pool' | 'params' | 'extra_prompt'>;
};
export type PromptOptions = {
	/** Adds the rule that repository artifacts name the ticket only in the commit subject. */
	publicRepository?: boolean;
	/** An instruction for this one run; it joins the profile's extra prompt in the override block. */
	override?: string;
	/** The run gets the conversation of the run it continues as turns before this prompt, which then leaves out that run's handoff. */
	history?: boolean;
};
export type PromptBlock = { name: string; chars: number; truncated: boolean };
/** `estimate` is in tokens, counted as characters / 4. */
export type AssembledPrompt = {
	system: string;
	user: string;
	blocks: PromptBlock[];
	estimate: number;
	/** The prompt shows the human's answer to the previous run's question: collect it once the prompt is sent, so it stays retractable until then. */
	showsHumanAnswer: boolean;
};

// ponytail: fixed share and limits; make them configurable once real runs show they are too tight or too loose.
const PROMPT_SHARE_OF_CONTEXT = 0.35;
const DESCRIPTION_LIMIT = 8000;
const CHARS_PER_TOKEN = 4;
const PREVIOUS_STATE_LIMIT = 1500 * CHARS_PER_TOKEN;
const HANDOFF_CUT = '\n[handoff cut to fit 1,500 tokens]';

/** How much of the context is left out; tried in this order until the prompt fits the budget. Tasks and moves are never cut. */
type Cut = { noteBodies: boolean; comments: number; fullDescription: boolean };
const CUTS: Cut[] = [
	{ noteBodies: true, comments: Infinity, fullDescription: true },
	{ noteBodies: false, comments: Infinity, fullDescription: true },
	{ noteBodies: false, comments: 3, fullDescription: true },
	{ noteBodies: false, comments: 0, fullDescription: true },
	{ noteBodies: false, comments: 0, fullDescription: false }
];

const RELATION_LABELS: Record<string, string> = {
	waits_for: 'waits for',
	blocks: 'blocks',
	parent: 'parent',
	children: 'child',
	related: 'related',
	duplicate_of: 'duplicate of',
	duplicated_by: 'duplicated by'
};

type Block = { name: string; text: string; truncated: boolean };
type LinkedNote = { slug: string; title: string; relations: string; body: string };
type Comment = ReturnType<typeof recentComments>[number];
type HumanAnswer = { question: string; options: QuestionOption[]; answer: Answer };
type Handoff = { text: string; generated?: boolean };
/** What the run before this one left: its handoff, the human's answer to its question and what got it stuck. */
type PreviousState = {
	runId: number;
	continuation: number;
	reason: ResumeReason | null;
	history: boolean;
	handoff?: Handoff;
	answer?: HumanAnswer;
	intervention?: Intervention;
};
type Context = {
	ref: string;
	title: string;
	type: string;
	column: string;
	description: string;
	docsRequired: boolean;
	rolePrompt: string;
	tasks: ReturnType<typeof tasksOf>;
	relations: Record<string, RelatedTicket[]>;
	comments: Comment[];
	moves: AgentMove[];
	notes: LinkedNote[];
	previous?: PreviousState;
};

const block = (name: string, text: string, truncated = false): Block => ({ name, text, truncated });

/**
 * The prompt of a run, read from the database without writing to it: the same content always gives the same text.
 * Cuts note bodies, then comments, then the description until it fits the model's budget; throws `prompt_too_large` if it never does.
 */
export function assemblePrompt(
	db: DatabaseSync,
	run: PromptRun,
	opts: PromptOptions = {}
): AssembledPrompt {
	const context = {
		...readContext(db, run.ticketId),
		previous: run.id === undefined ? undefined : previousStateOf(db, run.id, opts.history ?? false)
	};
	const system = systemBlocks(context, run.profile, opts.override);
	const candidates = CUTS.map((cut) =>
		joined(system, userBlocks(context, cut, opts.publicRepository ?? false))
	);
	const budget = promptBudget(run.profile);
	const fitting = candidates.find((prompt) => prompt.estimate <= budget);
	if (fitting) return { ...fitting, showsHumanAnswer: context.previous?.answer !== undefined };
	throw new DomainError(
		'prompt_too_large',
		`Der Prompt für ${context.ref} braucht auch gekürzt ${candidates[candidates.length - 1].estimate} Tokens; das Budget sind ${budget} (${PROMPT_SHARE_OF_CONTEXT * 100} % des Modellkontexts).`,
		'Notes vom Ticket abhängen, das Ticket kleiner schneiden oder ein Modell mit mehr Kontext wählen.'
	);
}

/** In tokens: the share of the model's context that the prompt, together with a resumed conversation, may take. */
export const promptBudget = (profile: PromptRun['profile']) =>
	Math.floor(PROMPT_SHARE_OF_CONTEXT * contextBudget(profile));

function readContext(db: DatabaseSync, ticketId: number): Context {
	const t = board.ticket(db, ticketId);
	const scope: ToolContext = { actor: { kind: 'agent' }, projectId: t.project_id, ticketId };
	const fields = db
		.prepare(
			'SELECT t.title, t.description, c.role_prompt AS rolePrompt FROM tickets t JOIN columns c ON c.id = t.column_id WHERE t.id = ?'
		)
		.get(ticketId) as { title: string; description: string; rolePrompt: string };
	return {
		...fields,
		ref: t.ref,
		type: t.type,
		column: t.column_name,
		docsRequired: t.docs_required === 1,
		tasks: tasksOf(db, ticketId),
		relations: relationsOf(db, scope, ticketId),
		comments: recentComments(db, ticketId),
		moves: agentMoves(db, scope),
		notes: notesOf(linkedNotes(db, scope, ticketId))
	};
}

/** One entry per note with all its relations to the ticket; the links arrive sorted by slug and relation. */
function notesOf(links: NoteLink[]): LinkedNote[] {
	const bySlug = new Map<string, LinkedNote>();
	for (const { slug, title, relation, body } of links) {
		const note = bySlug.get(slug);
		if (note) note.relations += `, ${relation}`;
		else bySlug.set(slug, { slug, title, relations: relation, body });
	}
	return [...bySlug.values()];
}

/** Secrets are masked, and blocks without content are left out of text and list. */
function joined(
	systemBlocks: Block[],
	userBlocks: Block[]
): Omit<AssembledPrompt, 'showsHumanAnswer'> {
	const present = (blocks: Block[]) =>
		blocks.map((b) => ({ ...b, text: mask(b.text) })).filter((b) => b.text !== '');
	const textOf = (blocks: Block[]) => blocks.map((b) => b.text).join('\n\n');
	const [system, user] = [present(systemBlocks), present(userBlocks)];
	const [systemText, userText] = [textOf(system), textOf(user)];
	return {
		system: systemText,
		user: userText,
		blocks: [...system, ...user].map((b) => ({
			name: b.name,
			chars: b.text.length,
			truncated: b.truncated
		})),
		estimate: Math.ceil((systemText.length + userText.length) / CHARS_PER_TOKEN)
	};
}

/** The override comes last, so that "the last instruction wins" holds for small models too. */
function systemBlocks(context: Context, profile: PromptRun['profile'], runOverride = ''): Block[] {
	const rolePrompt = context.rolePrompt.trim();
	const override = [profile.extra_prompt, runOverride]
		.map((text) => text.trim())
		.filter(Boolean)
		.join('\n\n');
	return [
		block('base', BASE_PROMPT[variantOf(profile)]),
		block('role', rolePrompt && `## Role: ${context.column}\n${rolePrompt}`),
		block('override', override && `## Override — takes precedence\n${override}`)
	];
}

function variantOf(profile: PromptRun['profile']): PromptVariant {
	const requested = profile.params.prompt_variant;
	if (requested === 'full' || requested === 'compact') return requested;
	return profile.pool === 'local' ? 'compact' : 'full';
}

function userBlocks(context: Context, cut: Cut, publicRepository: boolean): Block[] {
	return [
		ticketBlock(context, cut, publicRepository),
		block('tasks', tasksText(context.tasks)),
		block('relations', relationsText(context.relations)),
		commentsBlock(context.comments, cut),
		block('allowed_moves', movesText(context.moves)),
		notesBlock(context.notes, cut),
		previousStateBlock(context.previous),
		block('assignment', assignmentText(context))
	];
}

function assignmentText(context: Context): string {
	return [
		'## Assignment',
		`Work ${context.ref} in the column "${context.column}": do what your role for this column says, deliver the result it names and stop where it says. ` +
			'Refine the ticket (rewrite its scope, description or acceptance criteria) only in the Refine column or when your role asks for it. ' +
			'The internal context above is current: start with the work, not with `get_ticket`.'
	].join('\n');
}

function ticketBlock(context: Context, cut: Cut, publicRepository: boolean): Block {
	const cutDescription = !cut.fullDescription && context.description.length > DESCRIPTION_LIMIT;
	const description = cutDescription
		? `${context.description.slice(0, DESCRIPTION_LIMIT)} [truncated to fit the prompt budget; \`get_ticket\` shows all of it]`
		: context.description || '(no description)';
	const publicRule = `This repository is public: in repository artifacts only (${context.ref}) in the commit subject.`;
	const lines = [
		'## Internal context — never copy into repository artifacts',
		...(publicRepository ? [publicRule] : []),
		'',
		`### Ticket ${context.ref}: ${context.title}`,
		`Column: ${context.column} · type: ${context.type} · docs required: ${context.docsRequired ? 'yes, a linked note is needed before done' : 'no'}`,
		description
	];
	return block('ticket', lines.join('\n'), cutDescription);
}

function tasksText(tasks: Context['tasks']): string {
	const lines = tasks.map((task) => `- [${task.done ? 'x' : ' '}] ${task.id}: ${task.title}`);
	return [
		'### Tasks — tick each with `complete_tasks` as soon as it is met',
		...(lines.length ? lines : ['(none)'])
	].join('\n');
}

function relationsText(relations: Context['relations']): string {
	const lines = Object.entries(relations).flatMap(([key, tickets]) =>
		tickets.map((t) => `- ${RELATION_LABELS[key]} ${relatedTicket(t)}`)
	);
	if (!lines.length) return '';
	return ['### Relations — A blocks B = A must be finished before B starts', ...lines].join('\n');
}

function relatedTicket(t: RelatedTicket): string {
	if (t.other_project) return `${t.ref} (other project)`;
	const stillBlocking = t.blocking ? ', still blocking' : '';
	return `${t.ref} "${t.title}" (${t.column})${stillBlocking}`;
}

function commentsBlock(comments: Comment[], cut: Cut): Block {
	if (!comments.length) return block('comments', '');
	const shown = comments.slice(Math.max(0, comments.length - cut.comments));
	const left = comments.length - shown.length;
	const heading = left
		? `### Recent comments, oldest first (${left} left out to fit the prompt budget; \`get_ticket\` shows them)`
		: '### Recent comments, oldest first';
	return block('comments', [heading, ...shown.map(commentText)].join('\n\n'), left > 0);
}

function commentText(c: Comment): string {
	const header = `[${c.id}] ${c.by} · ${c.at}`;
	const readMore = 'more' in c ? `\n(cut; ${c.more} reads it in full)` : '';
	return `${header}\n${c.text}${readMore}`;
}

function movesText(moves: AgentMove[]): string {
	const lines = moves.map(moveLine);
	return [
		'### Allowed moves — `move_ticket` with column_id',
		...(lines.length ? lines : ['(none)'])
	].join('\n');
}

function moveLine(m: AgentMove): string {
	if (!m.refusals.length) return `- ${m.columnId}: ${m.name}`;
	const reasons = m.refusals.map((r) => r.message).join(' ');
	return `- ${m.columnId}: ${m.name} — blocked: ${reasons}`;
}

function notesBlock(notes: LinkedNote[], cut: Cut): Block {
	if (!notes.length) return block('notes', '');
	if (!cut.noteBodies) {
		const lines = notes.map((n) => `- ${n.slug}: ${n.title} (${n.relations})`);
		const heading =
			'### Linked notes (bodies left out to fit the prompt budget; `notes_get` reads one)';
		return block(
			'notes',
			[heading, ...lines].join('\n'),
			notes.some((n) => n.body !== '')
		);
	}
	return block(
		'notes',
		[
			'### Linked notes',
			...notes.map((n) => `#### ${n.slug}: ${n.title} (${n.relations})\n${n.body}`)
		].join('\n\n')
	);
}

const PAUSE_REASONS: Record<ResumeReason, string> = {
	context_budget: 'its context was nearly full',
	recovery: 'it got stuck',
	quota: 'the usage limit was near',
	halt: 'the human halted it'
};

/** Only the last run of a chain leaves its state; the runs before it count as continuations. */
function previousStateOf(
	db: DatabaseSync,
	runId: number,
	history: boolean
): PreviousState | undefined {
	const run = db
		.prepare(
			'SELECT resumed_from_run_id AS previous, resume_reason AS reason FROM runs WHERE id = ?'
		)
		.get(runId) as { previous: number | null; reason: ResumeReason | null } | undefined;
	if (!run?.previous) return undefined;
	const payloadOf = (sql: string) => {
		const row = db.prepare(sql).get(run.previous) as { payload: string } | undefined;
		return row && JSON.parse(row.payload);
	};
	return {
		runId: run.previous,
		continuation: continuationOf(db, runId),
		reason: run.reason,
		history,
		handoff: payloadOf(
			`SELECT payload FROM run_events WHERE run_id = ? AND type = 'message' AND idempotency_key = 'handoff'`
		),
		intervention: payloadOf(
			`SELECT payload FROM run_events WHERE run_id = ? AND type = 'intervention' ORDER BY seq DESC LIMIT 1`
		),
		answer: answerTo(db, run.previous)
	};
}

function continuationOf(db: DatabaseSync, runId: number): number {
	const { runs } = db
		.prepare(
			`WITH RECURSIVE chain (id, previous) AS (
				SELECT id, resumed_from_run_id FROM runs WHERE id = ?
				UNION ALL
				SELECT r.id, r.resumed_from_run_id FROM runs r JOIN chain c ON r.id = c.previous)
			SELECT count(*) AS runs FROM chain`
		)
		.get(runId) as { runs: number };
	return runs - 1;
}

/** Read only: collecting would make the answer final before the prompt is even sent. */
function answerTo(db: DatabaseSync, runId: number): HumanAnswer | undefined {
	const q = db
		.prepare(
			'SELECT question, options, answer FROM questions WHERE run_id = ? AND answer IS NOT NULL ORDER BY id DESC LIMIT 1'
		)
		.get(runId) as { question: string; options: string; answer: string } | undefined;
	return (
		q && { question: q.question, options: JSON.parse(q.options), answer: JSON.parse(q.answer) }
	);
}

/** The handoff comes last, so that cutting an overlong one keeps the answer and what got the run stuck. */
function previousStateBlock(previous: PreviousState | undefined): Block {
	if (!previous) return block('previous_state', '');
	const why = previous.reason ? PAUSE_REASONS[previous.reason] : 'it waited for the human';
	const head = [
		`## Previous state — continuation ${previous.continuation}`,
		`This run continues run ${previous.runId}, which paused because ${why}. Go on from its state instead of starting over.`
	].join('\n');
	const sections = [
		head,
		answerSection(previous.answer),
		interventionSection(previous.intervention),
		handoffSection(previous)
	];
	// masked before cutting, so that a secret cut in half is still recognised
	const text = mask(sections.filter(Boolean).join('\n\n'));
	if (text.length <= PREVIOUS_STATE_LIMIT) return block('previous_state', text);
	return block(
		'previous_state',
		text.slice(0, PREVIOUS_STATE_LIMIT - HANDOFF_CUT.length) + HANDOFF_CUT,
		true
	);
}

function answerSection(answer: HumanAnswer | undefined): string {
	if (!answer) return '';
	return [
		'### Human answer — act on it',
		`Question: ${answer.question}`,
		`Answer: ${answerText(answer)}`
	].join('\n');
}

function answerText({ options, answer }: HumanAnswer): string {
	if ('text' in answer) return answer.text;
	const { label, effect } = options[answer.option - 1];
	return `${answer.option}. ${label}${effect ? ` — ${effect}` : ''}`;
}

function interventionSection(intervention: Intervention | undefined): string {
	if (!intervention) return '';
	return [
		'### What got the previous run stuck — do not try it again',
		intervention.reason,
		intervention.hint
	].join('\n');
}

function handoffSection({ runId, history, handoff }: PreviousState): string {
	if (history)
		return [
			`### Conversation of run ${runId}`,
			'The turns before this message are its work up to its last completed step.'
		].join('\n');
	if (!handoff?.text) return '';
	const origin = handoff.generated ? ' (generated from its events: the model wrote none)' : '';
	return [`### Handoff of run ${runId}${origin}`, handoff.text].join('\n');
}

/** Fresh runs start from the handoff on purpose: replaying the conversation that filled the context or got stuck would undo that. */
const FRESH_RUN_REASONS: ReadonlySet<ResumeReason | null> = new Set(['context_budget', 'recovery']);

/** A run event as the builtin executor records it; which payload fields are set depends on the type. */
type StepEvent = {
	type: string;
	key: string;
	payload: {
		step?: number;
		text?: string;
		tool: string;
		args?: unknown;
		result: string;
		isError: boolean;
	};
};

/**
 * The conversation of the run this one continues, up to its last completed step: its messages, and its tool calls paired
 * with their results; reasoning stays out. Undefined if there is none, if it exceeds `budget` tokens, or for a fresh run.
 */
export function resumeHistoryOf(
	db: DatabaseSync,
	runId: number,
	budget: number
): ModelMessage[] | undefined {
	const run = db
		.prepare(
			'SELECT resumed_from_run_id AS previous, resume_reason AS reason FROM runs WHERE id = ?'
		)
		.get(runId) as { previous: number | null; reason: ResumeReason | null } | undefined;
	if (!run?.previous || FRESH_RUN_REASONS.has(run.reason)) return undefined;
	const turns = mask(completedSteps(db, run.previous).flatMap(turnsOf));
	const tokens = Math.ceil(JSON.stringify(turns).length / CHARS_PER_TOKEN);
	return turns.length > 0 && tokens <= budget ? turns : undefined;
}

/** The events of each step that ended with its step log; a halted run's unfinished last step has none, nor have events outside a step. */
function completedSteps(db: DatabaseSync, runId: number): StepEvent[][] {
	const rows = db
		.prepare(
			'SELECT type, idempotency_key AS key, payload FROM run_events WHERE run_id = ? ORDER BY seq'
		)
		.all(runId) as { type: string; key: string; payload: string }[];
	const events = rows
		.map((row): StepEvent => ({ ...row, payload: JSON.parse(row.payload) }))
		.filter((e) => e.payload.step !== undefined);
	const steps = [...Map.groupBy(events, (e) => e.payload.step).values()];
	return steps.filter((step) => step.some((e) => e.type === 'log'));
}

/** A provider refuses a tool call without its result, so a call is replayed only with the result of its call id. */
function turnsOf(step: StepEvent[]): ModelMessage[] {
	const results = new Map(
		step.filter((e) => e.type === 'tool_result').map((e) => [e.key, e.payload])
	);
	const answered = step.filter((e) => e.type === 'tool_call' && results.has(`${e.key}:result`));
	const text = step.find((e) => e.type === 'message')?.payload.text;
	const content = [
		...(text ? [{ type: 'text' as const, text }] : []),
		...answered.map(toolCallPart)
	];
	if (!content.length) return [];
	const toolResults = answered.map((call) =>
		toolResultPart(call.key, results.get(`${call.key}:result`)!)
	);
	const assistant: ModelMessage = { role: 'assistant', content };
	return toolResults.length ? [assistant, { role: 'tool', content: toolResults }] : [assistant];
}

const toolCallPart = ({ key, payload }: StepEvent): ToolCallPart => ({
	type: 'tool-call',
	toolCallId: key,
	toolName: payload.tool,
	input: payload.args
});

const toolResultPart = (
	callId: string,
	{ tool, result, isError }: StepEvent['payload']
): ToolResultPart => ({
	type: 'tool-result',
	toolCallId: callId,
	toolName: tool,
	output: { type: isError ? 'error-text' : 'text', value: result }
});
