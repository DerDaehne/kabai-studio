import type { DatabaseSync } from 'node:sqlite';
import type { StudioEvent } from '../events';
import { appendComment, ticket, type Ticket } from './board';
import { DomainError, tx, type Actor } from './core';
import { createRun, finishRun, prioritizeRun } from './runs';

/** `stopsRun` marks an option that must never start a follow-up run, e.g. "stop, keep it with the human". */
export type QuestionOption = { label: string; effect?: string; stopsRun?: boolean };
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
/** How long after the answer a held notice can still extend the window; the last extension ends one window later. */
export const ANSWER_HOLD_CAP_MS = 120_000;
export const ANSWER_HOLD_BEAT_MS = 5_000;

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
	answered_at: string | null;
	collected_at: string | null;
};
type OpenQuestion = QuestionRow & { t: Ticket };
type PausedRun = { id: number; profileId: number };
/**
 * What an answer sets going: a new run continuing the paused one, the follow-up runs already waiting, a deliberate
 * stop (the human's own choice, needs no "way out" comment), or no run for another reason.
 */
type Continuation =
	| { kind: 'resume'; run: PausedRun }
	| { kind: 'waiting'; followUpIds: number[] }
	| { kind: 'stopped'; reason: string }
	| { kind: 'none'; reason: string; wayOut?: string };

const QUESTION_COLUMNS =
	'id, ticket_id, run_id, question, options, answer, answered_at, collected_at';

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
	return options.map(({ label, effect, stopsRun }) => ({
		label,
		...(effect?.trim() ? { effect } : {}),
		...(stopsRun ? { stopsRun: true } : {})
	}));
}

const asComment = (text: string, options: QuestionOption[]) =>
	[text, ...options.map((o, i) => `${i + 1}. ${o.label}${o.effect ? ` — ${o.effect}` : ''}`)].join(
		'\n'
	);

/** Records the question as comment and as question row; the ticket stays in its column and waits for the human there. */
export function requestHuman(
	db: DatabaseSync,
	actor: Actor,
	ticketId: number,
	q: { question: string; options?: QuestionOption[] }
): { id: number } {
	return tx(db, (emit) => {
		const t = ticket(db, ticketId);
		if (!q.question.trim())
			throw new DomainError(
				'empty_question',
				'Die Frage ist leer.',
				'Formuliere die Frage so, dass der Mensch sie ohne weiteren Kontext beantworten kann.'
			);
		const options = normalizedOptions(q.options ?? []);
		appendComment(db, emit, actor, t, asComment(q.question, options));
		const { id } = db
			.prepare(
				'INSERT INTO questions (ticket_id, run_id, question, options) VALUES (?, ?, ?, ?) RETURNING id'
			)
			.get(t.id, actor.runId ?? null, q.question, JSON.stringify(options)) as { id: number };
		emit({
			type: 'question.asked',
			projectId: t.project_id,
			ticketId: t.id,
			actor,
			questionId: id
		});
		return { id };
	});
}

/** The ticket's newest question while it still has no answer, for a read-only view — never collects or mutates it. */
export function latestOpenQuestion(db: DatabaseSync, ticketId: number): LatestQuestion | undefined {
	const q = db
		.prepare(
			`SELECT ${QUESTION_COLUMNS} FROM questions WHERE ticket_id = ? AND answer IS NULL ORDER BY id DESC LIMIT 1`
		)
		.get(ticketId) as QuestionRow | undefined;
	if (!q) return undefined;
	return { id: q.id, question: q.question, options: JSON.parse(q.options), answer: null };
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

const stopsRun = (q: QuestionRow, option: number): boolean =>
	(JSON.parse(q.options) as QuestionOption[])[option - 1]?.stopsRun === true;

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
 * Sets or replaces the human's answer. If it answers a paused run, a follow-up run continues it once the undo window has
 * passed; until that run starts, the human can change or retract the answer.
 */
export function answerQuestion(
	db: DatabaseSync,
	actor: Actor,
	questionId: number,
	answer: Answer
): { resumesRun: boolean } {
	return tx(db, (emit) => {
		const q = questionOpenForHuman(db, actor, questionId);
		const stored = validAnswer(q, answer);
		const continuation = continuationOf(db, q, stored);
		// the app clock, not the database's, so the hold cap and the undo window share one clock
		db.prepare('UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?').run(
			JSON.stringify(stored),
			new Date().toISOString(),
			q.id
		);
		emit({
			type: 'question.answered',
			projectId: q.t.project_id,
			ticketId: q.t.id,
			actor,
			questionId: q.id
		});
		const effective = continueAfterAnswer(db, emit, actor, q, continuation);
		return { resumesRun: effective.kind === 'resume' || effective.kind === 'waiting' };
	});
}

/** Throws `answer_in_use` once a run has started that shows the answer: from then on it works with it. */
function continuationOf(db: DatabaseSync, q: OpenQuestion, answer: Answer): Continuation {
	throwIfShownByStartedRun(db, q);
	if ('option' in answer && stopsRun(q, answer.option))
		return { kind: 'stopped', reason: 'die gewählte Option startet keinen Run' };
	if (q.run_id === null) return { kind: 'none', reason: 'die Frage stammt aus keinem Run' };
	if (q.t.column_phase !== 'work')
		return { kind: 'none', reason: `${q.t.ref} liegt nicht mehr in einem Arbeitsschritt` };
	const run = db
		.prepare('SELECT id, state, agent_profile_id AS profileId FROM runs WHERE id = ?')
		.get(q.run_id) as { id: number; state: string; profileId: number | null };
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
	return { kind: 'resume', run: { id: run.id, profileId: run.profileId } };
}

/** Any started run of the ticket other than the asking run began after the answer and shows it, if it is the newest question's and not a stop answer. */
function throwIfShownByStartedRun(db: DatabaseSync, q: OpenQuestion) {
	if (q.answer === null) return;
	const current = JSON.parse(q.answer) as Answer;
	if ('option' in current && stopsRun(q, current.option)) return;
	const newest = db
		.prepare('SELECT max(id) AS id FROM questions WHERE ticket_id = ?')
		.get(q.t.id) as {
		id: number;
	};
	if (newest.id !== q.id) return;
	const started = db
		.prepare(
			"SELECT id FROM runs WHERE ticket_id = ? AND id IS NOT ? AND state IN ('running', 'waiting_approval') ORDER BY id LIMIT 1"
		)
		.get(q.t.id, q.run_id) as { id: number } | undefined;
	if (started) throw answerInUse(q.id, started.id);
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
	planned: Continuation
): Continuation {
	const notBefore = new Date(Date.now() + ANSWER_UNDO_WINDOW_MS).toISOString();
	if (planned.kind === 'waiting') holdBack(db, planned.followUpIds, notBefore);
	const continuation =
		planned.kind === 'resume' ? resumeOrNone(db, actor, q.t, planned.run, notBefore) : planned;
	if (continuation.kind !== 'none') return continuation;
	if (q.answer !== null) return continuation; // only a changed answer: the way out is already on the ticket
	const wayOut = `Die Antwort auf Frage ${q.id} setzt keinen Run fort: ${continuation.reason}.\nAusweg: ${continuation.wayOut ?? 'Starte einen Run für das Ticket, er liest die Antwort.'}`;
	appendComment(db, emit, actor, q.t, wayOut, true);
	return continuation;
}

/** A changed answer gets its own undo window. */
function holdBack(db: DatabaseSync, runIds: number[], notBefore: string) {
	const update = db.prepare('UPDATE runs SET not_before = ? WHERE id = ?');
	for (const id of runIds) update.run(notBefore, id);
}

/** A run of the ticket that is already pending turns the answer into a plain stored answer with a way out. */
function resumeOrNone(
	db: DatabaseSync,
	actor: Actor,
	t: Ticket,
	run: PausedRun,
	notBefore: string
): Continuation {
	try {
		const { id } = createRun(db, actor, {
			ticketId: t.id,
			profileId: run.profileId,
			resumedFromRunId: run.id,
			notBefore
		});
		prioritizeRun(db, actor, id);
		return { kind: 'resume', run };
	} catch (err) {
		if (err instanceof DomainError && err.code === 'run_pending')
			return { kind: 'none', reason: err.message.replace(/\.$/, ''), wayOut: err.hint };
		throw err;
	}
}

export type AnswerHold = {
	/** The window was extended. */
	held: boolean;
	/** Milliseconds until the follow-up run may start. */
	closesInMs: number;
	/** The cap is reached: the window only runs out from here. */
	capped: boolean;
};

/**
 * Keeps the undo window of an answer open for another window length while the human holds the notice that offers
 * the undo. The waiting follow-up runs' `not_before` only ever moves later, so a lost beat leaves the window to run out.
 */
export function holdAnswerWindow(
	db: DatabaseSync,
	actor: Actor,
	questionId: number,
	now: Date = new Date()
): AnswerHold {
	return tx(db, () => {
		const q = questionOpenForHuman(db, actor, questionId);
		if (q.answer === null)
			throw new DomainError(
				'not_answered',
				`Frage ${q.id} ist noch nicht beantwortet.`,
				'Halten lässt sich nur das Fenster einer gegebenen Antwort.'
			);
		const continuation = continuationOf(db, q, JSON.parse(q.answer) as Answer);
		if (continuation.kind !== 'waiting') return { held: false, closesInMs: 0, capped: false };
		// a missing or unparsable answer time counts as capped
		const capped = !(now.getTime() < Date.parse(q.answered_at ?? '') + ANSWER_HOLD_CAP_MS);
		const extendedTo = now.getTime() + ANSWER_UNDO_WINDOW_MS;
		const select = db.prepare('SELECT not_before FROM runs WHERE id = ?');
		const update = db.prepare('UPDATE runs SET not_before = ? WHERE id = ?');
		let closesAt = now.getTime();
		for (const id of continuation.followUpIds) {
			const { not_before } = select.get(id) as { not_before: string | null };
			const current = not_before ? Date.parse(not_before) : 0;
			const next = capped ? current : Math.max(current, extendedTo);
			if (next !== current) update.run(new Date(next).toISOString(), id);
			closesAt = Math.max(closesAt, next);
		}
		return { held: !capped, closesInMs: closesAt - now.getTime(), capped };
	});
}

/** Takes the answer back while the run it would resume still waits: that run is cancelled and the question is open again. */
export function retractAnswer(db: DatabaseSync, actor: Actor, questionId: number) {
	tx(db, (emit) => {
		const q = questionOpenForHuman(db, actor, questionId);
		if (q.answer === null)
			throw new DomainError(
				'not_answered',
				`Frage ${q.id} ist noch nicht beantwortet.`,
				'Zurücknehmen lässt sich nur eine gegebene Antwort.'
			);
		const continuation = continuationOf(db, q, JSON.parse(q.answer) as Answer);
		if (continuation.kind === 'waiting')
			continuation.followUpIds.forEach((id) => finishRun(db, actor, id, { state: 'cancelled' }));
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

/** The answer a run's prompt shows and its first sign of life collects: that of the ticket's newest question, if answered and not yet collected. */
export function uncollectedAnswer(db: DatabaseSync, ticketId: number) {
	// a stop answer has had its effect: handing it to a later run would make that run do the opposite of starting it
	const q = db
		.prepare(
			`SELECT question, options, answer, collected_at FROM questions WHERE ticket_id = ? ORDER BY id DESC LIMIT 1`
		)
		.get(ticketId) as
		| { question: string; options: string; answer: string | null; collected_at: string | null }
		| undefined;
	if (!q || q.answer === null || q.collected_at) return undefined;
	const options = JSON.parse(q.options) as QuestionOption[];
	const answer = JSON.parse(q.answer) as Answer;
	if ('option' in answer && options[answer.option - 1]?.stopsRun) return undefined;
	return { question: q.question, options, answer };
}

/**
 * Collects the answer the run's prompt showed (`uncollectedAnswer`), once the run has shown a first sign of life or ended:
 * until then the human can still retract it, and a run that fails before that leaves it to the next one. Collecting twice
 * changes nothing.
 */
export function collectShownAnswer(db: DatabaseSync, runId: number) {
	const run = db.prepare('SELECT ticket_id FROM runs WHERE id = ?').get(runId) as {
		ticket_id: number;
	};
	if (uncollectedAnswer(db, run.ticket_id))
		collectAnswer(db, { kind: 'agent', runId }, run.ticket_id);
}
