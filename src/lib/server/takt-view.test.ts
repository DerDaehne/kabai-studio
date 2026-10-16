import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './db';
import * as board from './domain/board';
import type { Actor } from './domain/core';
import * as runs from './domain/runs';
import { taktView } from './takt-view';

const user: Actor = { kind: 'user' };

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const profile = runs.createProfile(db, user, {
		name: 'qwen',
		executor: 'builtin',
		provider: 'openai-compatible',
		model: 'm',
		pool: 'local'
	}).id;
	const running = () => {
		const ticket = board.createTicket(db, user, projectId, {
			title: 'T',
			column_id: board.columns(db, projectId).find((c) => c.step === 'implement')!.id
		}).id;
		const id = runs.createRun(db, user, { ticketId: ticket, profileId: profile }).id;
		runs.startRun(db, user, id);
		return id;
	};
	return { db, running };
}

describe('taktView', () => {
	it('reads questions, tracked runs and finished runs in a fixed number of statements however many runs there are', () => {
		const s = setup();
		const statements = (more: number) => {
			for (let i = 0; i < more; i++) {
				runs.finishRun(s.db, user, s.running(), { state: 'failed', error: '[x] y' });
				runs.appendEvent(s.db, user, s.running(), { type: 'log', payload: { kind: 'step' } });
			}
			let count = 0;
			const prepare = s.db.prepare.bind(s.db);
			s.db.prepare = (sql: string) => (count++, prepare(sql));
			taktView(s.db);
			return count;
		};
		const few = statements(1);
		expect(statements(4)).toBe(few);
	});

	it('tracks every running run and lists the runs that ended, newest first', () => {
		const s = setup();
		const running = s.running();
		const ended = s.running();
		runs.finishRun(s.db, user, ended, { state: 'succeeded' });

		const view = taktView(s.db);
		expect(view.tracks.map((track) => track.id)).toEqual([running]);
		expect(view.finished.map((run) => run.id)).toEqual([ended]);
	});
});
