import { afterEach, expect, it, vi } from 'vitest';
import { migrate, openDb } from '../db';
import { subscribe, type StudioEvent } from '../events';
import * as board from './board';
import { DomainError, type Actor } from './core';
import { haltKind, pauseRuns, resumeAll } from './halt';
import * as runs from './runs';

const user: Actor = { kind: 'user' };
const system: Actor = { kind: 'system' };

afterEach(() => vi.restoreAllMocks());

/** Two running runs of the same profile, each on its own ticket, both paused by a global `:anhalten`. */
function twoHaltedRuns() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const profileId = runs.createProfile(db, user, {
		name: 'Lokal',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm'
	}).id;
	const running = () => {
		const ticketId = board.createTicket(db, user, projectId, { title: 'T' }).id;
		const { id } = runs.createRun(db, system, { ticketId, profileId });
		runs.startRun(db, system, id);
		return id;
	};
	const [first, second] = [running(), running()];
	pauseRuns(db, user);
	const continuations = (runId: number) =>
		db.prepare('SELECT id FROM runs WHERE resumed_from_run_id = ?').all(runId);
	return { db, first, second, continuations };
}

it('rolls back the half-written continuation of a run refused after its creation, resumes the other run, and releases the halt', () => {
	const { db, first, second, continuations } = twoHaltedRuns();
	const prioritize = runs.prioritizeRun;
	vi.spyOn(runs, 'prioritizeRun').mockImplementation((d, actor, runId) => {
		const row = d
			.prepare('SELECT resumed_from_run_id AS from_ FROM runs WHERE id = ?')
			.get(runId) as { from_: number } | undefined;
		if (row?.from_ === first)
			throw new DomainError('probe', 'Probe lehnt ab.', 'Erneut versuchen.');
		prioritize(d, actor, runId);
	});
	const events: StudioEvent[] = [];
	const stop = subscribe((event) => events.push(event));

	const { resumed, skipped } = resumeAll(db, user);
	stop();

	expect(skipped).toEqual([
		{ runId: first, code: 'probe', message: 'Probe lehnt ab.', hint: 'Erneut versuchen.' }
	]);
	expect(continuations(first)).toEqual([]);
	expect(continuations(second)).toHaveLength(1);
	expect(resumed).toEqual([(continuations(second)[0] as { id: number }).id]);
	expect(events.filter((e) => e.type === 'run.created')).toHaveLength(1);
	expect(haltKind(db)).toBeNull();
});

it('lets a skipped run be resumed by a later :fortsetzen all once its cause is gone', () => {
	const { db, first, continuations } = twoHaltedRuns();
	const prioritize = runs.prioritizeRun;
	vi.spyOn(runs, 'prioritizeRun').mockImplementationOnce(() => {
		throw new DomainError('probe', 'Probe lehnt ab.', 'Erneut versuchen.');
	});
	expect(resumeAll(db, user).skipped.map((s) => s.runId)).toEqual([first]);
	vi.mocked(runs.prioritizeRun).mockImplementation(prioritize);

	const retry = resumeAll(db, user);

	expect(retry.skipped).toEqual([]);
	expect(continuations(first)).toHaveLength(1);
	expect(retry.resumed).toEqual([(continuations(first)[0] as { id: number }).id]);
});
