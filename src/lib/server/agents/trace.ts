import { mask } from '../secrets';

export type ToolCall = { tool: string; args: unknown };
/** Where the reason comes from: what the agent said, what it thought, or nothing (then the trace says so instead of guessing). */
export type ReasonSource = 'text' | 'reasoning' | '';
export type CallTrace = {
	target: string;
	reason: string;
	reason_source: ReasonSource;
	next_hint: string;
};
/** Lines of the file after the change, as the ticket's diff shows them; `file` as the tool named it. */
export type DiffAnchor = { file: string; startLine: number; endLine: number };
export type ResultTrace = { result_summary: string; diff_anchor?: DiffAnchor };

const MAX_CHARS = 120;
// ponytail: English and German plan words only; a model planning in other words leaves next_hint empty.
const PLAN_MARKER = /\b(then|next|after that|afterwards|danach|dann)\b/i;
const TARGET_ARGS = ['path', 'file_path', 'file', 'command', 'cmd', 'slug', 'ticket', 'query'];
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const NEW_FILE_HEADER = /^\+\+\+ (?:b\/)?([^\t\n]+)/m;

/** What a tool call works on, why (from the text the step wrote before it, else its reasoning) and what the agent plans next. */
export function deriveTrace(stepText: string, reasoning: string, call: ToolCall): CallTrace {
	const [source, sentences] = spokenOrThought(stepText, reasoning);
	const reason = sentences.findLast((sentence) => !PLAN_MARKER.test(sentence)) ?? sentences.at(-1);
	const nextHint = sentences.findLast(
		(sentence) => sentence !== reason && PLAN_MARKER.test(sentence)
	);
	return {
		target: callTarget(call),
		reason: short(reason ?? ''),
		reason_source: source,
		next_hint: short(nextHint ?? '')
	};
}

/** What a call works on: a file, command, note, ticket or query, as the trace shows it; empty when it names none. */
export const callTarget = (call: ToolCall): string => short(targetOf(call.args));

/** A short result for the trace, and for a change to a file the lines it changed. */
export function summarizeResult(call: ToolCall, result: string, isError: boolean): ResultTrace {
	if (isError) return { result_summary: short(`Fehler: ${errorOf(result)}`) };
	const args = asRecord(call.args);
	const file = stringArg(args, 'path') ?? stringArg(args, 'file_path');
	const diff = diffOf(result, file);
	if (diff) return diff;
	const content = stringArg(args, 'content');
	if (file && content !== undefined) return written(file, content);
	return { result_summary: short(studioSummary(args, result)) };
}

function spokenOrThought(stepText: string, reasoning: string): [ReasonSource, string[]] {
	const spoken = sentencesOf(stepText);
	if (spoken.length) return ['text', spoken];
	const thought = sentencesOf(reasoning);
	return [thought.length ? 'reasoning' : '', thought];
}

function sentencesOf(text: string): string[] {
	return text
		.split('\n')
		.flatMap((line) => line.split(/(?<=[.!?])\s+/))
		.map((sentence) => sentence.replace(/^[\s>*#-]+/, '').trim())
		.filter((sentence) => /\p{L}/u.test(sentence));
}

/** Masked before cutting, so that a secret cut in half is still recognised. */
function short(text: string): string {
	const masked = mask(text);
	return masked.length <= MAX_CHARS ? masked : `${masked.slice(0, MAX_CHARS - 1)}…`;
}

function targetOf(args: unknown): string {
	const record = asRecord(args);
	const value = TARGET_ARGS.map((name) => record[name]).find((v) => v !== undefined);
	if (typeof value === 'string') return value;
	return Array.isArray(value) ? value.join(' ') : '';
}

const asRecord = (value: unknown) =>
	(typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
	const value = args[name];
	return typeof value === 'string' ? value : undefined;
}

function parsed(result: string): Record<string, unknown> {
	try {
		return asRecord(JSON.parse(result));
	} catch {
		return {};
	}
}

function errorOf(result: string): string {
	const code = parsed(result).error;
	return typeof code === 'string' ? code : result.split('\n')[0];
}

function studioSummary(args: Record<string, unknown>, result: string): string {
	const { column, open_task_ids: open, notes } = parsed(result);
	if (typeof column === 'string') return `→ ${column}`;
	if (Array.isArray(open) && Array.isArray(args.task_ids))
		return `${args.task_ids.length} erledigt · ${open.length} offen`;
	if (Array.isArray(notes)) return `${notes.length} Treffer`;
	return '';
}

/** A unified diff in the result: its hunks give the changed lines; header lines before the first hunk are not changes. */
function diffOf(result: string, file: string | undefined): ResultTrace | undefined {
	const lines = result.split('\n');
	const firstHunk = lines.findIndex((line) => HUNK_HEADER.test(line));
	const anchorFile = file ?? NEW_FILE_HEADER.exec(result)?.[1];
	if (firstHunk < 0 || !anchorFile) return undefined;
	const changes = lines.slice(firstHunk).filter((line) => !HUNK_HEADER.test(line));
	const added = changes.filter((line) => line.startsWith('+')).length;
	const removed = changes.filter((line) => line.startsWith('-')).length;
	return {
		result_summary: `+${added} −${removed}`,
		diff_anchor: { file: anchorFile, ...newSideLines(lines) }
	};
}

function newSideLines(lines: string[]) {
	const hunks = lines.flatMap((line) => {
		const header = HUNK_HEADER.exec(line);
		return header ? [{ start: Number(header[1]), count: Number(header[2] ?? 1) }] : [];
	});
	const first = hunks[0];
	const last = hunks[hunks.length - 1];
	return { startLine: first.start, endLine: Math.max(first.start, last.start + last.count - 1) };
}

function written(file: string, content: string): ResultTrace {
	const lineCount = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
	return {
		result_summary: `${lineCount} Zeilen geschrieben`,
		diff_anchor: { file, startLine: 1, endLine: Math.max(1, lineCount) }
	};
}
