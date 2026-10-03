import type { DatabaseSync } from 'node:sqlite';
import { appendComment, applyMove, ticket, type Ticket } from './board';
import { DomainError, tx, type Actor } from './core';

export type QuestionOption = { label: string; effect?: string };
/** `option` counts from 1, as the options are shown to the human. */
export type Answer = { option: number } | { text: string };
export type LatestQuestion = {
	id: number;
	question: string;
	options: QuestionOption[];
	answer: Answer | null;
};

const MAX_OPTIONS = 3;

type QuestionRow = {
	id: number;
	ticket_id: number;
	question: string;
	options: string;
	answer: string | null;
	collected_at: string | null;
};

function question(db: DatabaseSync, id: number): QuestionRow {
	const q = db
		.prepare(
			'SELECT id, ticket_id, question, options, answer, collected_at FROM questions WHERE id = ?'
		)
		.get(id) as QuestionRow | undefined;
	if (!q) throw new DomainError('not_found', `Frage ${id} gibt es nicht.`, 'Prüfe die Frage-ID.');
	return q;
}

function normalizedOptions(options: QuestionOption[]): QuestionOption[] {
	if (options.length > MAX_OPTIONS)
		throw new DomainError(
			'too_many_options',
			`${options.length} Antwortoptionen sind zu viele, erlaubt sind höchstens ${MAX_OPTIONS}.`,
			'Biete die wichtigsten 1–3 Optionen an; eine freie Antwort kann der Mensch immer geben.'
		);
	if (options.some((o) => !o.label?.trim()))
		throw new DomainError(
			'empty_option',
			'Jede Antwortoption braucht ein label.',
			'Gib jeder Option ein kurzes label, z. B. „Variante A übernehmen“.'
		);
	return options.map(({ label, effect }) => (effect?.trim() ? { label, effect } : { label }));
}

const asComment = (text: string, options: QuestionOption[]) =>
	[text, ...options.map((o, i) => `${i + 1}. ${o.label}${o.effect ? ` — ${o.effect}` : ''}`)].join(
		'\n'
	);

/** Records the question (as comment and as question row) and moves the ticket to the project's human_intervention column. */
export function requestHuman(
	db: DatabaseSync,
	actor: Actor,
	ticketId: number,
	q: { question: string; options?: QuestionOption[] }
): { id: number; column: string } {
	return tx(db, (emit) => {
		const t = ticket(db, ticketId);
		if (!q.question.trim())
			throw new DomainError(
				'empty_question',
				'Die Frage ist leer.',
				'Formuliere die Frage so, dass der Mensch sie ohne weiteren Kontext beantworten kann.'
			);
		const options = normalizedOptions(q.options ?? []);
		const escalation = escalationColumn(db, t);
		appendComment(db, emit, actor, t, asComment(q.question, options));
		const { id } = db
			.prepare(
				'INSERT INTO questions (ticket_id, run_id, question, options) VALUES (?, ?, ?, ?) RETURNING id'
			)
			.get(t.id, actor.runId ?? null, q.question, JSON.stringify(options)) as { id: number };
		applyMove(db, emit, actor, t, escalation.id);
		emit({
			type: 'question.asked',
			projectId: t.project_id,
			ticketId: t.id,
			actor,
			questionId: id
		});
		return { id, column: escalation.name };
	});
}

function escalationColumn(db: DatabaseSync, t: Ticket): { id: number; name: string } {
	const column = db
		.prepare(
			`SELECT id, name FROM columns WHERE project_id = ? AND kind = 'human_intervention' ORDER BY position, id LIMIT 1`
		)
		.get(t.project_id) as { id: number; name: string } | undefined;
	if (!column)
		throw new DomainError(
			'no_escalation_column',
			`Das Board von ${t.ref} hat keine human_intervention-Spalte.`,
			'Stell die Frage als Kommentar; eine human_intervention-Spalte legt der Mensch im Board an.'
		);
	return column;
}

/** Only the human answers, and only until the agent has collected the answer. */
function questionOpenForHuman(db: DatabaseSync, actor: Actor, questionId: number) {
	if (actor.kind !== 'user')
		throw new DomainError(
			'requires_human',
			'Fragen beantwortet nur der Mensch.',
			'Warte auf die Antwort; eine eigene Einschätzung gehört als Kommentar ans Ticket.'
		);
	const q = question(db, questionId);
	if (q.collected_at)
		throw new DomainError(
			'answer_collected',
			`Der Agent hat die Antwort auf Frage ${q.id} schon übernommen, sie gilt jetzt.`,
			'Eine Korrektur schreibst du als Kommentar ans Ticket; der nächste Run liest sie.'
		);
	return { ...q, t: ticket(db, q.ticket_id) };
}

/** Sets or replaces the human's answer; it stays retractable until the agent collects it. */
export function answerQuestion(db: DatabaseSync, actor: Actor, questionId: number, answer: Answer) {
	tx(db, (emit) => {
		const q = questionOpenForHuman(db, actor, questionId);
		const optionCount = (JSON.parse(q.options) as QuestionOption[]).length;
		let stored: Answer;
		if ('option' in answer) {
			if (!Number.isInteger(answer.option) || answer.option < 1 || answer.option > optionCount)
				throw new DomainError(
					'invalid_answer',
					`Frage ${q.id} hat ${optionCount ? `die Optionen 1–${optionCount}` : 'keine Optionen'}, nicht ${answer.option}.`,
					optionCount
						? `Wähle eine Option von 1 bis ${optionCount} oder antworte frei.`
						: 'Antworte frei.'
				);
			stored = { option: answer.option };
		} else {
			if (!answer.text.trim())
				throw new DomainError(
					'invalid_answer',
					'Die Antwort ist leer.',
					'Wähle eine Option oder schreib eine Antwort.'
				);
			stored = { text: answer.text };
		}
		db.prepare('UPDATE questions SET answer = ?, answered_at = CURRENT_TIMESTAMP WHERE id = ?').run(
			JSON.stringify(stored),
			q.id
		);
		emit({
			type: 'question.answered',
			projectId: q.t.project_id,
			ticketId: q.t.id,
			actor,
			questionId: q.id
		});
	});
}

export function retractAnswer(db: DatabaseSync, actor: Actor, questionId: number) {
	tx(db, (emit) => {
		const q = questionOpenForHuman(db, actor, questionId);
		if (q.answer === null)
			throw new DomainError(
				'not_answered',
				`Frage ${q.id} ist noch nicht beantwortet.`,
				'Zurücknehmen lässt sich nur eine gegebene Antwort.'
			);
		db.prepare('UPDATE questions SET answer = NULL, answered_at = NULL WHERE id = ?').run(q.id);
		emit({
			type: 'question.retracted',
			projectId: q.t.project_id,
			ticketId: q.t.id,
			actor,
			questionId: q.id
		});
	});
}

/**
 * The newest question of a ticket, so an answer to an older question never passes for the answer to an open one.
 * If it is answered, collecting makes the answer final: the human can no longer retract it.
 */
export function collectAnswer(
	db: DatabaseSync,
	actor: Actor,
	ticketId: number
): LatestQuestion | undefined {
	return tx(db, (emit) => {
		const t = ticket(db, ticketId);
		const q = db
			.prepare(
				'SELECT id, ticket_id, question, options, answer, collected_at FROM questions WHERE ticket_id = ? ORDER BY id DESC LIMIT 1'
			)
			.get(t.id) as QuestionRow | undefined;
		if (!q) return undefined;
		if (q.answer !== null && !q.collected_at) {
			db.prepare('UPDATE questions SET collected_at = CURRENT_TIMESTAMP WHERE id = ?').run(q.id);
			emit({
				type: 'question.collected',
				projectId: t.project_id,
				ticketId: t.id,
				actor,
				questionId: q.id
			});
		}
		return {
			id: q.id,
			question: q.question,
			options: JSON.parse(q.options),
			answer: q.answer === null ? null : JSON.parse(q.answer)
		};
	});
}
