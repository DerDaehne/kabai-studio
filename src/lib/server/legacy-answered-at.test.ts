import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import { answerQuestion, holdAnswerWindow, requestHuman } from './domain/questions';
import * as runs from './domain/runs';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };
const originalZone = process.env.TZ;
afterEach(() => {
	if (originalZone === undefined) delete process.env.TZ;
	else process.env.TZ = originalZone;
});

function answeredBeforeTheAppClockWroteIt() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'P', name: 'Legacy' }).id;
	const column = board.columns(db, projectId).find((c) => c.step === 'implement')!.id;
	const ticketId = board.createTicket(db, user, projectId, { title: 'T', column_id: column }).id;
	const profileId = runs.createProfile(db, user, {
		name: 'P',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const runId = runs.createRun(db, user, { ticketId, profileId }).id;
	runs.startRun(db, system, runId);
	const id = requestHuman(db, { kind: 'agent', runId }, ticketId, {
		question: 'A?',
		options: [{ label: 'A' }]
	}).id;
	runs.finishRun(db, system, runId, { state: 'paused' });
	answerQuestion(db, user, id, { option: 1 });
	db.prepare('UPDATE questions SET answered_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
	return { db, id };
}

describe.each(['UTC', 'Europe/Berlin', 'America/New_York'])(
	'an answer time in SQLite form in %s',
	(zone) => {
		it('is read as UTC: a fresh answer can be held and the cap falls 120 seconds after it', () => {
			process.env.TZ = zone;
			const { db, id } = answeredBeforeTheAppClockWroteIt();

			expect(holdAnswerWindow(db, user, id)).toMatchObject({ held: true, capped: false });
			const later = new Date(Date.now() + 125_000);
			expect(holdAnswerWindow(db, user, id, later)).toMatchObject({ held: false, capped: true });
		});
	}
);
