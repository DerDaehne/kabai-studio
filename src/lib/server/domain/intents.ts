import type { DatabaseSync } from 'node:sqlite';
import {
	appendComment,
	applyMove,
	blockingPredecessors,
	columns,
	ticket,
	writeMove,
	type Predecessor,
	type Ticket
} from './board';
import { DomainError, tx, type Actor } from './core';
import { createRun, notInWork, pendingRun, prioritizeRun } from './runs';
import { hasOpenQuestion } from './steps';

// The human's intents: each is one call and needs no knowledge of the variant's columns.

function requireHuman(actor: Actor, intent: string) {
	if (actor.kind === 'user') return;
	throw new DomainError(
		'requires_human',
		`${intent} ist Sache des Menschen.`,
		'Beende deinen Schritt mit finish_step; wie es danach weitergeht, entscheidet Studio oder der Mensch.'
	);
}

/**
 * „los“: moves a backlog ticket into the first work step of its variant and queues its run ahead of background work;
 * a ticket already in a work step only gets the run. The human may start a blocked ticket on purpose, so the answer
 * names its open predecessors instead of refusing.
 */
export function startTicket(
	db: DatabaseSync,
	actor: Actor,
	ticketId: number,
	profileId?: number
): { runId: number; predecessors: Predecessor[] } {
	return tx(db, (emit) => {
		requireHuman(actor, '„los“');
		const t = ticket(db, ticketId);
		if (t.column_phase !== 'open' && t.column_phase !== 'work') throw notInWork(t);
		if (t.column_phase === 'open') {
			const cols = columns(db, t.project_id);
			writeMove(
				db,
				emit,
				actor,
				t,
				cols.find((c) => c.phase === 'work')!,
				cols
			);
		}
		const runId = queueRunForHuman(db, actor, t, profileId);
		return { runId, predecessors: blockingPredecessors(db, t.id) };
	});
}

/** „abnehmen“: from acceptance to done; open tasks, open children or a missing note refuse it with a way out. */
export function acceptTicket(db: DatabaseSync, actor: Actor, ticketId: number) {
	tx(db, (emit) => {
		requireHuman(actor, 'Abnehmen');
		const t = ticket(db, ticketId);
		if (t.column_phase !== 'acceptance')
			throw new DomainError(
				'not_in_acceptance',
				`${t.ref} liegt in „${t.column_name}“, nicht in der Abnahme.`,
				'Abnehmen geht, sobald die Kritik das Ticket freigegeben hat und es in der Abnahme liegt.'
			);
		const done = columns(db, t.project_id).find((c) => c.phase === 'done')!;
		applyMove(db, emit, actor, t, done.id);
	});
}

/**
 * „zurückgeben“: sends an accepted or finished ticket with the human's comment back to the work step before the
 * critique. Moving back clears the review approval, and the chain runs again from there.
 */
export function returnTicket(
	db: DatabaseSync,
	actor: Actor,
	ticketId: number,
	comment: string
): { runId: number } {
	return tx(db, (emit) => {
		requireHuman(actor, 'Zurückgeben');
		const t = ticket(db, ticketId);
		assertReturnable(t, comment);
		const cols = columns(db, t.project_id);
		const beforeCritique = cols[cols.findIndex((c) => c.step === 'critique') - 1];
		appendComment(db, emit, actor, t, comment);
		writeMove(db, emit, actor, t, beforeCritique, cols);
		return { runId: queueRunForHuman(db, actor, t) };
	});
}

function assertReturnable(t: Ticket, comment: string) {
	if (t.column_phase !== 'acceptance' && t.column_phase !== 'done')
		throw new DomainError(
			'not_returnable',
			`${t.ref} liegt in „${t.column_name}“; zurückgeben lässt sich nur ein Ticket aus der Abnahme oder aus „Fertig“.`,
			'Ein Ticket in Arbeit braucht kein Zurückgeben: Schreib deinen Hinweis als Kommentar, der nächste Run liest ihn.'
		);
	if (!comment.trim())
		throw new DomainError(
			'comment_required',
			'Zurückgeben geht nur mit Kommentar.',
			'Schreib, was fehlt oder nicht stimmt; der nächste Run liest es als Auftrag.'
		);
}

/** A run the human starts goes ahead of background work in the queue. */
function queueRunForHuman(db: DatabaseSync, actor: Actor, t: Ticket, profileId?: number): number {
	const pending = pendingRun(db, t.id);
	if (pending)
		throw new DomainError(
			'run_pending',
			`${t.ref} hat schon Run ${pending.id} („${pending.state}“).`,
			'Warte, bis er endet, oder brich ihn in der Run-Akte ab (x); danach erneut „los“.'
		);
	if (hasOpenQuestion(db, t.id))
		throw new DomainError(
			'open_question',
			`${t.ref} wartet auf deine Antwort auf eine offene Frage.`,
			'Beantworte zuerst die Frage; die Antwort setzt die Arbeit fort.'
		);
	const { id } = createRun(db, actor, { ticketId: t.id, profileId: profileFor(db, t, profileId) });
	prioritizeRun(db, actor, id);
	return id;
}

function profileFor(db: DatabaseSync, t: Ticket, chosen: number | undefined): number {
	const profileId = chosen ?? defaultProfileId(db, t.project_id);
	if (profileId !== undefined) return profileId;
	throw new DomainError(
		'no_profile',
		'Es gibt noch kein Agent-Profil, mit dem ein Run starten könnte.',
		'Lege unter Einstellungen → Profile eines an, dann erneut „los“.'
	);
}

/** The profile the project's newest run used, else the first by name — the one the Run-Akte preselects. */
export function defaultProfileId(db: DatabaseSync, projectId: number): number | undefined {
	const row = db
		.prepare(
			`SELECT coalesce(
				(SELECT r.agent_profile_id FROM runs r JOIN tickets t ON t.id = r.ticket_id
					WHERE t.project_id = ? AND r.agent_profile_id IS NOT NULL ORDER BY r.id DESC LIMIT 1),
				(SELECT id FROM agent_profiles ORDER BY name LIMIT 1)) AS id`
		)
		.get(projectId) as { id: number | null };
	return row.id ?? undefined;
}
