import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDb } from '../db';
import { setSecret } from '../secrets';
import { deriveTrace, summarizeResult } from './trace';

const addComment = { tool: 'add_comment', args: { text: 'Header row done.' } };

afterEach(() => void vi.unstubAllEnvs());

describe('deriveTrace', () => {
	it('takes the reason from the last sentence the agent wrote before the call', () => {
		const text = 'I read the ticket.\nThe export lacks a header row, so I add a comment about it.';

		expect(deriveTrace(text, 'Some thought.', addComment)).toMatchObject({
			reason: 'The export lacks a header row, so I add a comment about it.',
			reason_source: 'text'
		});
	});

	it('cuts a long reason to 120 characters', () => {
		const reason = deriveTrace(`${'word '.repeat(40)}end.`, '', addComment).reason;

		expect(reason).toHaveLength(120);
		expect(reason.endsWith('…')).toBe(true);
	});

	it('falls back to the last sentence of the reasoning, marked as reasoning', () => {
		const reasoning =
			'The user wants CSV. Columns are unclear.\nI should check the ticket first.\n';

		expect(deriveTrace('  \n', reasoning, addComment)).toMatchObject({
			reason: 'I should check the ticket first.',
			reason_source: 'reasoning'
		});
	});

	it('leaves reason and next hint empty when nothing was said or thought before the call', () => {
		expect(deriveTrace(' \n', '', addComment)).toEqual({
			target: '',
			reason: '',
			reason_source: '',
			next_hint: ''
		});
	});

	it('takes the next hint from a plan sentence and keeps it out of the reason', () => {
		const text = 'I add the missing comment. Then I move the ticket to Ready.';

		expect(deriveTrace(text, '', addComment)).toMatchObject({
			reason: 'I add the missing comment.',
			next_hint: 'Then I move the ticket to Ready.'
		});
		expect(deriveTrace('Next, I read the ticket.', '', addComment)).toMatchObject({
			reason: 'Next, I read the ticket.',
			next_hint: ''
		});
	});

	it('ignores list and heading markers and lines without words', () => {
		const text = '## Plan\n1. Read the ticket\n- Comment on it\n```';

		expect(deriveTrace(text, '', addComment).reason).toBe('Comment on it');
	});

	it('names the target from the file, command, note or ticket argument of the call', () => {
		const targetOf = (args: object) => deriveTrace('', '', { tool: 'any', args }).target;

		expect(targetOf({ path: 'src/export.ts', content: 'x' })).toBe('src/export.ts');
		expect(targetOf({ command: ['npm', 'test'] })).toBe('npm test');
		expect(targetOf({ slug: 'csv-export', expected_version: 2 })).toBe('csv-export');
		expect(targetOf({ ticket: 'STU-3' })).toBe('STU-3');
		expect(targetOf({ query: 'csv export' })).toBe('csv export');
		expect(targetOf({ text: 'a comment' })).toBe('');
	});

	it('masks reason, next hint and target before cutting them, so a secret cut in half does not leak', () => {
		const secret = 'sk-test-provider-key-0815';
		vi.stubEnv('STUDIO_SECRET_KEY', randomBytes(32).toString('base64')); // so that the test writes no key file
		const db = openDb(':memory:');
		migrate(db);
		setSecret(db, 'provider-key', secret);
		// the 120-character cut lands inside the secret
		const sentence = `${'a'.repeat(100)} ${secret} end.`;

		const trace = deriveTrace(`${sentence} Then ${sentence}`, '', {
			tool: 'run',
			args: { command: sentence }
		});

		const fields = [trace.reason, trace.next_hint, trace.target];
		expect(fields.every((field) => field.includes('[secret:'))).toBe(true);
		expect(fields.join()).not.toContain(secret.slice(0, 10));
	});
});

describe('summarizeResult', () => {
	it('summarizes studio results: a move, completed tasks and search hits', () => {
		expect(summarizeResult({ tool: 'move_ticket', args: {} }, '{"column":"Ready"}', false)).toEqual(
			{
				result_summary: '→ Ready'
			}
		);
		expect(
			summarizeResult(
				{ tool: 'complete_tasks', args: { task_ids: [1, 2] } },
				'{"open_task_ids":[3]}',
				false
			).result_summary
		).toBe('2 erledigt · 1 offen');
		expect(
			summarizeResult(
				{ tool: 'notes_search', args: {} },
				'{"notes":[{"slug":"a"},{"slug":"b"}]}',
				false
			).result_summary
		).toBe('2 Treffer');
		expect(summarizeResult(addComment, '{"comment_id":1}', false)).toEqual({ result_summary: '' });
	});

	it('summarizes a failed call with its error code, or else its first line', () => {
		const refused = '{"error":"transition_not_allowed","message":"Spalte 7 ist nicht erreichbar."}';

		expect(summarizeResult(addComment, refused, true).result_summary).toBe(
			'Fehler: transition_not_allowed'
		);
		expect(
			summarizeResult(addComment, 'Model tried to call unavailable tool.\nAvailable: …', true)
				.result_summary
		).toBe('Fehler: Model tried to call unavailable tool.');
	});

	it('anchors an edit at the new-side lines of the diff it returned, with added and removed lines', () => {
		const diff = [
			'```diff',
			'--- src/export.ts\toriginal',
			'+++ src/export.ts\tmodified',
			'@@ -10,3 +10,4 @@',
			' const header = true;',
			'-const sep = ";";',
			'+const sep = ",";',
			"+const quote = '\"';",
			' export {};',
			'@@ -40,2 +41,2 @@',
			'--- a removed SQL comment',
			'+-- an added SQL comment',
			' end',
			'```'
		].join('\n');

		expect(
			summarizeResult(
				{ tool: 'edit_file', args: { path: 'src/export.ts', edits: [] } },
				diff,
				false
			)
		).toEqual({
			result_summary: '+3 −2',
			diff_anchor: { file: 'src/export.ts', startLine: 10, endLine: 42 }
		});
	});

	it('takes the file of an edit from the diff header when the call names none', () => {
		const diff = '--- a/src/export.ts\n+++ b/src/export.ts\n@@ -5,0 +6,2 @@\n+one\n+two';

		expect(summarizeResult({ tool: 'apply_patch', args: { patch: diff } }, diff, false)).toEqual({
			result_summary: '+2 −0',
			diff_anchor: { file: 'src/export.ts', startLine: 6, endLine: 7 }
		});
	});

	it('anchors a write at the lines it wrote', () => {
		const write = { tool: 'write_file', args: { path: 'docs/export.md', content: 'a\nb\nc\n' } };

		expect(summarizeResult(write, 'Successfully wrote to docs/export.md', false)).toEqual({
			result_summary: '3 Zeilen geschrieben',
			diff_anchor: { file: 'docs/export.md', startLine: 1, endLine: 3 }
		});
	});

	it('gives a failed write no anchor', () => {
		const write = { tool: 'write_file', args: { path: 'docs/export.md', content: 'a\n' } };

		expect(summarizeResult(write, 'EACCES: permission denied', true)).toEqual({
			result_summary: 'Fehler: EACCES: permission denied'
		});
	});
});
