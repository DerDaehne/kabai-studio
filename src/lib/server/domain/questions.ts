import type { DatabaseSync } from 'node:sqlite';
import type { StudioEvent } from '../events';
import { appendComment, applyAnswerMove, applyMove, ticket, type Ticket } from './board';
import { DomainError, tx, type Actor } from './core';
import { createRun, finishRun, prioritizeRun } from './runs';

export type QuestionOption = { label: string; effect?: string };
/** `option` counts from 1, as the options are shown to the human. */
export type Answer = { option: number } | { text: string };
export type LatestQuestion = {
	id: number;
	question: string;
	options: QuestionOption[];
	answer: Answer | null;
};

// ponytail: a fixed 10 s to take an answer back before the run it resumes starts; make it a setting once practice asks for it.
export const ANSWER_UNDO_WINDOW_MS = 10_000;

const MAX_OPTIONS = 3;
const HUMAN: Actor = { kind: 'user' };

type Emit = (event: StudioEvent) => void;
type QuestionRow = {
	id: number;
	ticket_id: number;
	run_id: number | null;
	question: string;
	options: string;
	answer: string | null;
	collected_at: string | null;
};
type OpenQuestion = QuestionRow & { t: Ticket };
type PausedRun = { id: number; profileId: number; columnId: number | null };
/** What an answer sets going: a new run continuing the paused one, the follow-up runs already waiting, or no run at all. */
type Continuation =
	| { kind: 'resume'; run: PausedRun }
	| { kind: 'waiting'; followUpIds: number[] }
	| { kind: 'none'; reason: string };

const QUESTION_COLUMNS = 'id, ticket_id, run_id, question, options, answer, collected_at';

function question(db: DatabaseSync, id: number): QuestionRow {
	const q = db.prepare(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE id = ?`).get(id) as
		QuestionRow | undefined;
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

function columnOfKind(db: DatabaseSync, t: Ticket, kind: 'human_intervention' | 'human_answered') {
	return db
		.prepare(
			'SELECT id, name FROM columns WHERE project_id = ? AND kind = ? ORDER BY position, id LIMIT 1'
		)
		.get(t.project_id, kind) as { id: number; name: string } | undefined;
}

function escalationColumn(db: DatabaseSync, t: Ticket): { id: number; name: string } {
	const column = columnOfKind(db, t, 'human_intervention');
	if (!column)
		throw new DomainError(
			'no_escalation_column',
			`Das Board von ${t.ref} hat keine human_intervention-Spalte.`,
			'Stell die Frage als Kommentar; eine human_intervention-Spalte legt der Mensch im Board an.'
		);
	return column;
}

/** Only the human answers, and only until the agent has collected the answer. */
function questionOpenForHuman(db: DatabaseSync, actor: Actor, questionId: number): OpenQuestion {
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

function validAnswer(q: QuestionRow, answer: Answer): Answer {
	if ('text' in answer) {
		if (!answer.text.trim())
			throw new DomainError(
				'invalid_answer',
				'Die Antwort ist leer.',
				'Wähle eine Option oder schreib eine Antwort.'
			);
		return { text: answer.text };
	}
	const optionCount = (JSON.parse(q.options) as QuestionOption[]).length;
	if (!Number.isInteger(answer.option) || answer.option < 1 || answer.option > optionCount)
		throw new DomainError(
			'invalid_answer',
			`Frage ${q.id} hat ${optionCount ? `die Optionen 1–${optionCount}` : 'keine Optionen'}, nicht ${answer.option}.`,
			optionCount
				? `Wähle eine Option von 1 bis ${optionCount} oder antworte frei.`
				: 'Antworte frei.'
		);
	return { option: answer.option };
}

/**
 * Sets or replaces the human's answer. If it answers a paused run, the ticket returns to that run's column and a follow-up
 * run continues it once the undo window has passed; until that run starts, the human can change or retract the answer.
 */
export function answerQuestion(db: DatabaseSync, actor: Actor, questionId: number, answer: Answer) {
	tx(db, (emit) => {
		const q = questionOpenForHuman(db, actor, questionId);
		const stored = validAnswer(q, answer);
		const continuation = continuationOf(db, q);
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
		continueAfterAnswer(db, emit, actor, q, continuation);
	});
}

/** Throws `answer_in_use` once a follow-up run has started: from then on it works with the answer. */
function continuationOf(db: DatabaseSync, q: QuestionRow): Continuation {
	if (q.run_id === null) return { kind: 'none', reason: 'die Frage stammt aus keinem Run' };
	const run = db
		.prepare(
			'SELECT id, state, agent_profile_id AS profileId, column_id AS columnId FROM runs WHERE id = ?'
		)
		.get(q.run_id) as {
		id: number;
		state: string;
		profileId: number | null;
		columnId: number | null;
	};
	// ponytail: an answer that beats the asking run's own pause continues nothing; queue the follow-up on pause if that race shows up.
	if (run.state !== 'paused')
		return { kind: 'none', reason: `Run ${run.id} ist „${run.state}“, nicht pausiert` };
	if (run.profileId === null)
		return { kind: 'none', reason: `das Agent-Profil von Run ${run.id} ist gelöscht` };
	const followUps = db
		.prepare(
			"SELECT id, state FROM runs WHERE resumed_from_run_id = ? AND state IN ('queued', 'running', 'waiting_approval') ORDER BY id"
		)
		.all(run.id) as { id: number; state: string }[];
	const started = followUps.find((f) => f.state !== 'queued');
	if (started) throw answerInUse(q.id, started.id);
	if (followUps.length) return { kind: 'waiting', followUpIds: followUps.map((f) => f.id) };
	return { kind: 'resume', run: { id: run.id, profileId: run.profileId, columnId: run.columnId } };
}

function answerInUse(questionId: number, runId: number) {
	return new DomainError(
		'answer_in_use',
		`Run ${runId} arbeitet schon mit der Antwort auf Frage ${questionId}.`,
		`Eine Korrektur schreibst du als Kommentar ans Ticket, der nächste Run liest sie — oder du stoppst Run ${runId}.`
	);
}

function continueAfterAnswer(
	db: DatabaseSync,
	emit: Emit,
	actor: Actor,
	q: OpenQuestion,
	continuation: Continuation
) {
	const notBefore = new Date(Date.now() + ANSWER_UNDO_WINDOW_MS).toISOString();
	if (continuation.kind === 'waiting') return holdBack(db, continuation.followUpIds, notBefore);
	if (continuation.kind === 'resume')
		return resumeRun(db, emit, actor, q.t, continuation.run, notBefore);
	const answered = columnOfKind(db, q.t, 'human_answered');
	if (answered) applyAnswerMove(db, emit, actor, q.t, answered.id);
	if (q.answer !== null) return; // only a changed answer: the way out is already on the ticket
	const wayOut = `Die Antwort auf Frage ${q.id} setzt keinen Run fort: ${continuation.reason}.\nAusweg: Starte einen Run für das Ticket, er liest die Antwort.`;
	appendComment(db, emit, actor, q.t, wayOut, true);
}

/** A changed answer gets its own undo window. */
function holdBack(db: DatabaseSync, runIds: number[], notBefore: string) {
	const update = db.prepare('UPDATE runs SET not_before = ? WHERE id = ?');
	for (const id of runIds) update.run(notBefore, id);
}

/** The follow-up run records the ticket's column at creation as its role, so the ticket moves first. */
function resumeRun(
	db: DatabaseSync,
	emit: Emit,
	actor: Actor,
	t: Ticket,
	run: PausedRun,
	notBefore: string
) {
	const column = run.columnId ?? columnOfKind(db, t, 'human_answered')?.id;
	if (column !== undefined) applyAnswerMove(db, emit, actor, t, column);
	const { id } = createRun(db, actor, {
		ticketId: t.id,
		profileId: run.profileId,
		resumedFromRunId: run.id,
		notBefore
	});
	prioritizeRun(db, actor, id);
}

/** Takes the answer back while the run it would resume still waits: that run is cancelled and the ticket waits in human intervention again. */
export function retractAnswer(db: DatabaseSync, actor: Actor, questionId: number) {
	tx(db, (emit) => {
		const q = questionOpenForHuman(db, actor, questionId);
		if (q.answer === null)
			throw new DomainError(
				'not_answered',
				`Frage ${q.id} ist noch nicht beantwortet.`,
				'Zurücknehmen lässt sich nur eine gegebene Antwort.'
			);
		const continuation = continuationOf(db, q);
		if (continuation.kind === 'waiting')
			continuation.followUpIds.forEach((id) => finishRun(db, actor, id, { state: 'cancelled' }));
		const intervention = columnOfKind(db, q.t, 'human_intervention');
		if (intervention) applyMove(db, emit, actor, q.t, intervention.id);
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

const answerText = (options: QuestionOption[], answer: Answer) =>
	'option' in answer ? `${answer.option}. ${options[answer.option - 1].label}` : answer.text;

/**
 * The newest question of a ticket, so an answer to an older question never passes for the answer to an open one.
 * If it is answered, collecting makes the answer final: the human can no longer retract it, and it enters the ticket's history.
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
				`SELECT ${QUESTION_COLUMNS} FROM questions WHERE ticket_id = ? ORDER BY id DESC LIMIT 1`
			)
			.get(t.id) as QuestionRow | undefined;
		if (!q) return undefined;
		const latest: LatestQuestion = {
			id: q.id,
			question: q.question,
			options: JSON.parse(q.options),
			answer: q.answer === null ? null : JSON.parse(q.answer)
		};
		if (latest.answer === null || q.collected_at) return latest;
		db.prepare('UPDATE questions SET collected_at = CURRENT_TIMESTAMP WHERE id = ?').run(q.id);
		appendComment(db, emit, HUMAN, t, `Antwort: ${answerText(latest.options, latest.answer)}`);
		emit({
			type: 'question.collected',
			projectId: t.project_id,
			ticketId: t.id,
			actor,
			questionId: q.id
		});
		return latest;
	});
}
