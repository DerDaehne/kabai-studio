import type { DatabaseSync } from 'node:sqlite';
import { contextBudget } from '../../agents/model-catalog';
import * as board from '../domain/board';
import { DomainError } from '../domain/core';
import { noteVisibleIn } from '../domain/notes';
import type { Profile } from '../domain/runs';
import { agentMoves, recentComments, relationsOf, tasksOf, type AgentMove, type RelatedTicket, type ToolContext } from '../mcp';
import { mask } from '../secrets';
import { BASE_PROMPT, type PromptVariant } from './base-prompt';

export type PromptRun = { ticketId: number; profile: Pick<Profile, 'model' | 'pool' | 'params' | 'extra_prompt'> };
export type PromptOptions = {
	/** Adds the rule that repository artifacts name the ticket only in the commit subject. */
	publicRepository?: boolean;
	/** An instruction for this one run; it joins the profile's extra prompt in the override block. */
	override?: string;
};
export type PromptBlock = { name: string; chars: number; truncated: boolean };
/** `estimate` is in tokens, counted as characters / 4. */
export type AssembledPrompt = { system: string; user: string; blocks: PromptBlock[]; estimate: number };

// ponytail: fixed share and limits; make them configurable once real runs show they are too tight or too loose.
const PROMPT_SHARE_OF_CONTEXT = 0.35;
const DESCRIPTION_LIMIT = 8000;
const CHARS_PER_TOKEN = 4;

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
};

const block = (name: string, text: string, truncated = false): Block => ({ name, text, truncated });

/**
 * The prompt of a run, read from the database without writing to it: the same content always gives the same text.
 * Cuts note bodies, then comments, then the description until it fits the model's budget; throws `prompt_too_large` if it never does.
 */
export function assemblePrompt(db: DatabaseSync, run: PromptRun, opts: PromptOptions = {}): AssembledPrompt {
	const context = readContext(db, run.ticketId);
	const system = systemBlocks(context, run.profile, opts.override);
	const candidates = CUTS.map((cut) => joined(system, userBlocks(context, cut, opts.publicRepository ?? false)));
	const budget = Math.floor(PROMPT_SHARE_OF_CONTEXT * contextBudget(run.profile));
	const fitting = candidates.find((prompt) => prompt.estimate <= budget);
	if (fitting) return fitting;
	throw new DomainError(
		'prompt_too_large',
		`Der Prompt für ${context.ref} braucht auch gekürzt ${candidates[candidates.length - 1].estimate} Tokens; das Budget sind ${budget} (${PROMPT_SHARE_OF_CONTEXT * 100} % des Modellkontexts).`,
		'Notes vom Ticket abhängen, das Ticket kleiner schneiden oder ein Modell mit mehr Kontext wählen.'
	);
}

function readContext(db: DatabaseSync, ticketId: number): Context {
	const t = board.ticket(db, ticketId);
	const scope: ToolContext = { actor: { kind: 'agent' }, projectId: t.project_id, ticketId };
	const fields = db
		.prepare('SELECT t.title, t.description, c.role_prompt AS rolePrompt FROM tickets t JOIN columns c ON c.id = t.column_id WHERE t.id = ?')
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
		notes: linkedNotes(db, t.project_id, ticketId)
	};
}

/** Notes linked to the ticket that its project can read, one entry per note; archived ones no longer document anything. */
const linkedNotes = (db: DatabaseSync, projectId: number, ticketId: number) =>
	db
		.prepare(
			`SELECT n.slug, n.title, group_concat(nt.relation, ', ' ORDER BY nt.relation) AS relations, n.body
			FROM note_tickets nt JOIN notes n ON n.id = nt.note_id
			WHERE nt.ticket_id = ?1 AND n.archived = 0 AND ${noteVisibleIn('?2')} GROUP BY n.id ORDER BY n.slug`
		)
		.all(ticketId, projectId) as LinkedNote[];

/** Secrets are masked, and blocks without content are left out of text and list. */
function joined(systemBlocks: Block[], userBlocks: Block[]): AssembledPrompt {
	const present = (blocks: Block[]) => blocks.map((b) => ({ ...b, text: mask(b.text) })).filter((b) => b.text !== '');
	const textOf = (blocks: Block[]) => blocks.map((b) => b.text).join('\n\n');
	const [system, user] = [present(systemBlocks), present(userBlocks)];
	const [systemText, userText] = [textOf(system), textOf(user)];
	return {
		system: systemText,
		user: userText,
		blocks: [...system, ...user].map((b) => ({ name: b.name, chars: b.text.length, truncated: b.truncated })),
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
	const assignment = `## Assignment\nWork ${context.ref} as your role says. The internal context above is current: start with the work, not with \`get_ticket\`.`;
	return [
		ticketBlock(context, cut, publicRepository),
		block('tasks', tasksText(context.tasks)),
		block('relations', relationsText(context.relations)),
		commentsBlock(context.comments, cut),
		block('allowed_moves', movesText(context.moves)),
		notesBlock(context.notes, cut),
		block('assignment', assignment)
	];
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
	return ['### Tasks — tick each with `complete_tasks` as soon as it is met', ...(lines.length ? lines : ['(none)'])].join('\n');
}

function relationsText(relations: Context['relations']): string {
	const lines = Object.entries(relations).flatMap(([key, tickets]) => tickets.map((t) => `- ${RELATION_LABELS[key]} ${relatedTicket(t)}`));
	if (!lines.length) return '';
	return ['### Relations — A blocks B = A must be finished before B starts', ...lines].join('\n');
}

const relatedTicket = (t: RelatedTicket) =>
	t.other_project ? `${t.ref} (other project)` : `${t.ref} "${t.title}" (${t.column})${t.blocking ? ', still blocking' : ''}`;

function commentsBlock(comments: Comment[], cut: Cut): Block {
	if (!comments.length) return block('comments', '');
	const shown = comments.slice(Math.max(0, comments.length - cut.comments));
	const left = comments.length - shown.length;
	const heading = left
		? `### Recent comments, oldest first (${left} left out to fit the prompt budget; \`get_ticket\` shows them)`
		: '### Recent comments, oldest first';
	return block('comments', [heading, ...shown.map(commentText)].join('\n\n'), left > 0);
}

const commentText = (c: Comment) => `[${c.id}] ${c.by} · ${c.at}\n${c.text}${'more' in c ? `\n(cut; ${c.more} reads it in full)` : ''}`;

function movesText(moves: AgentMove[]): string {
	const lines = moves.map((m) => `- ${m.columnId}: ${m.name}${m.refusals.length ? ` — blocked: ${m.refusals.map((r) => r.message).join(' ')}` : ''}`);
	return ['### Allowed moves — `move_ticket` with column_id', ...(lines.length ? lines : ['(none)'])].join('\n');
}

function notesBlock(notes: LinkedNote[], cut: Cut): Block {
	if (!notes.length) return block('notes', '');
	if (!cut.noteBodies) {
		const lines = notes.map((n) => `- ${n.slug}: ${n.title} (${n.relations})`);
		const heading = '### Linked notes (bodies left out to fit the prompt budget; `notes_get` reads one)';
		return block('notes', [heading, ...lines].join('\n'), notes.some((n) => n.body !== ''));
	}
	return block('notes', ['### Linked notes', ...notes.map((n) => `#### ${n.slug}: ${n.title} (${n.relations})\n${n.body}`)].join('\n\n'));
}
