import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
import { subscribe, type StudioEvent } from '../events';
import * as board from './board';
import { DomainError, type Actor } from './core';
import * as notes from './notes';

const user: Actor = { kind: 'user' };
const dev: Actor = { kind: 'agent', runId: 1 };

function setup() {
	const db = openDb(':memory:');
	migrate(db);
	const projectId = board.createProject(db, user, { key: 'STU', name: 'Studio' }).id;
	const ticketId = board.createTicket(db, user, projectId, { title: 'T' }).id;
	return { db, projectId, ticketId };
}

function caught(fn: () => unknown): DomainError {
	try {
		fn();
	} catch (err) {
		if (err instanceof DomainError) return err;
		throw err;
	}
	throw new Error('DomainError erwartet');
}

describe('createNote / updateNote / archiveNote', () => {
	it('creates a note, sets only the allowed fields and archives idempotently', () => {
		const { db } = setup();
		const { id, warnings } = notes.createNote(db, user, {
			slug: 'n-1',
			title: 'Titel',
			body: 'x',
			tags: ['a', 'b']
		});
		expect(warnings).toEqual([]);
		expect(
			db.prepare('SELECT slug, title, tags, archived, version FROM notes WHERE id = ?').get(id)
		).toEqual({
			slug: 'n-1',
			title: 'Titel',
			tags: '["a","b"]',
			archived: 0,
			version: 1
		});

		notes.updateNote(db, user, id, { title: 'Neu' });
		expect(db.prepare('SELECT title, version FROM notes WHERE id = ?').get(id)).toEqual({
			title: 'Neu',
			version: 2
		});

		const err = caught(() => notes.updateNote(db, user, id, { slug: 'anders' } as never));
		expect(err.code).toBe('unknown_field');
		expect(err.hint).toContain('archiveNote');

		notes.archiveNote(db, user, id);
		notes.archiveNote(db, user, id); // idempotent
		expect(db.prepare('SELECT archived FROM notes WHERE id = ?').get(id)).toEqual({ archived: 1 });
	});
});

describe('wikilinks', () => {
	it('creates and removes automatic references links for wikilinks, leaving manual links and unknown slugs untouched', () => {
		const { db } = setup();
		const b = notes.createNote(db, user, { slug: 'b', title: 'B', body: '' }).id;
		const c = notes.createNote(db, user, { slug: 'c', title: 'C', body: '' }).id;
		const created = notes.createNote(db, user, {
			slug: 'a',
			title: 'A',
			body: 'siehe [[b]] und [[fehlt]]'
		});
		expect(created.warnings).toEqual([
			'Unbekannter Slug „fehlt“ im Wikilink — kein Link angelegt.'
		]);

		const edges = () =>
			db
				.prepare(
					"SELECT to_note_id AS toId, origin FROM note_links WHERE from_note_id = ? AND type = 'references' ORDER BY to_note_id"
				)
				.all(created.id);
		expect(edges()).toEqual([{ toId: b, origin: 'wikilink' }]);

		notes.linkNote(db, user, created.id, c, 'references'); // manual, another target
		expect(edges()).toEqual([
			{ toId: b, origin: 'wikilink' },
			{ toId: c, origin: 'manual' }
		]);

		notes.updateNote(db, user, created.id, { body: 'no wikilink any more' }); // wikilink to b removed
		expect(edges()).toEqual([{ toId: c, origin: 'manual' }]); // the automatic edge is gone, the manual one stays

		notes.updateNote(db, user, created.id, { body: '[[b]] wieder da' });
		expect(edges()).toEqual([
			{ toId: b, origin: 'wikilink' },
			{ toId: c, origin: 'manual' }
		]);
	});

	it('does not duplicate a wikilink to a target that is already linked manually, and the origin stays manual', () => {
		const { db } = setup();
		const b = notes.createNote(db, user, { slug: 'b', title: 'B', body: '' }).id;
		const a = notes.createNote(db, user, { slug: 'a', title: 'A', body: '' }).id;
		notes.linkNote(db, user, a, b, 'references');
		notes.updateNote(db, user, a, { body: '[[b]]' });
		const origin = () =>
			db
				.prepare(
					"SELECT origin FROM note_links WHERE from_note_id = ? AND to_note_id = ? AND type = 'references'"
				)
				.get(a, b);
		expect(origin()).toEqual({ origin: 'manual' });

		notes.updateNote(db, user, a, { body: 'no wikilink any more' }); // wikilink removed, the manual edge stays
		expect(origin()).toEqual({ origin: 'manual' });
		expect(db.prepare('SELECT count(*) AS n FROM note_links').get()?.n).toBe(1); // no duplicate
	});

	it('rejects linking a note to itself', () => {
		const { db } = setup();
		const a = notes.createNote(db, user, { slug: 'a', title: 'A', body: '' }).id;
		expect(caught(() => notes.linkNote(db, user, a, a, 'references')).code).toBe('self_relation');
	});

	it('turns a wikilinked edge manual when it is linked by hand, so it survives removing the wikilink (reverse order)', () => {
		const { db } = setup();
		const b = notes.createNote(db, user, { slug: 'b', title: 'B', body: '' }).id;
		const a = notes.createNote(db, user, { slug: 'a', title: 'A', body: '[[b]]' }).id; // the edge first appears with origin=wikilink
		const origin = () =>
			db
				.prepare(
					"SELECT origin FROM note_links WHERE from_note_id = ? AND to_note_id = ? AND type = 'references'"
				)
				.get(a, b);
		expect(origin()).toEqual({ origin: 'wikilink' });

		notes.linkNote(db, user, a, b, 'references'); // the same edge confirmed by hand
		expect(origin()).toEqual({ origin: 'manual' });
		expect(db.prepare('SELECT count(*) AS n FROM note_links').get()?.n).toBe(1); // no duplicate

		notes.updateNote(db, user, a, { body: 'kein Wikilink mehr' });
		expect(origin()).toEqual({ origin: 'manual' }); // stays although the wikilink text is gone
	});

	it('links a labelled wikilink to its slug like a plain wikilink', () => {
		const { db } = setup();
		const b = notes.createNote(db, user, { slug: 'b', title: 'B', body: '' }).id;
		const created = notes.createNote(db, user, {
			slug: 'a',
			title: 'A',
			body: 'siehe [[b|Schönerer Text]]'
		});
		expect(created.warnings).toEqual([]);
		expect(
			db
				.prepare(
					"SELECT to_note_id AS toId FROM note_links WHERE from_note_id = ? AND type = 'references'"
				)
				.all(created.id)
		).toEqual([{ toId: b }]);
	});
});

describe('supersedes', () => {
	it('marks the target adr note superseded, and search ranks it below even a barely relevant ordinary note', () => {
		const { db } = setup();
		const old = notes.createNote(db, user, {
			slug: 'adr-old',
			title: 'Alt',
			kind: 'adr',
			status: 'accepted',
			body: 'Datenbankentscheidung'
		}).id;
		const neu = notes.createNote(db, user, {
			slug: 'adr-new',
			title: 'Neu',
			kind: 'adr',
			status: 'accepted',
			body: 'Datenbankentscheidung, neu gefasst'
		}).id;
		// an ordinary note (status IS NULL) mentions the search term only once in passing — tests the NULL-safe ordering
		notes.createNote(db, user, {
			slug: 'note-beilaeufig',
			title: 'Unwichtig',
			body: `${Array(50).fill('füllwort').join(' ')} Datenbankentscheidung`
		});
		notes.linkNote(db, user, neu, old, 'supersedes');
		expect(db.prepare('SELECT status, version FROM notes WHERE id = ?').get(old)).toEqual({
			status: 'superseded',
			version: 2
		}); // version incremented (lost update protection)

		const hits = notes.searchNotes(db, 'Datenbankentscheidung');
		expect(hits.map((h) => h.slug)).toEqual(['adr-new', 'note-beilaeufig', 'adr-old']); // superseded last, even behind the weakly relevant note
		expect(hits.map((h) => h.status)).toEqual(['accepted', null, 'superseded']);
	});

	it('sets the status only for kind=adr; for other notes it stays NULL without a version increment', () => {
		const { db } = setup();
		const old = notes.createNote(db, user, { slug: 'note-old', title: 'Alt', body: '' }).id;
		const neu = notes.createNote(db, user, { slug: 'note-new', title: 'Neu', body: '' }).id;
		notes.linkNote(db, user, neu, old, 'supersedes');
		expect(db.prepare('SELECT status, version FROM notes WHERE id = ?').get(old)).toEqual({
			status: null,
			version: 1
		});
	});

	it('counts supersedes as a change, so an update with the version read before gets conflict instead of silently overwriting the new status', () => {
		const { db } = setup();
		const old = notes.createNote(db, user, {
			slug: 'adr-old',
			title: 'Alt',
			kind: 'adr',
			status: 'accepted',
			body: ''
		}); // version 1
		const neu = notes.createNote(db, user, {
			slug: 'adr-new',
			title: 'Neu',
			kind: 'adr',
			status: 'accepted',
			body: ''
		}).id;
		notes.linkNote(db, user, neu, old.id, 'supersedes'); // old → version 2, status superseded

		const err = caught(() => notes.updateNote(db, user, old.id, { status: 'accepted' }, 1)); // knows only the old version 1
		expect(err.code).toBe('conflict');
		expect(db.prepare('SELECT status FROM notes WHERE id = ?').get(old.id)).toEqual({
			status: 'superseded'
		}); // not silently overwritten
	});
});

describe('validation of slug and status/kind', () => {
	it('rejects a duplicate slug with slug_taken, and the hint names the existing note', () => {
		const { db } = setup();
		notes.createNote(db, user, { slug: 'n', title: 'Erste', body: '' });
		const err = caught(() => notes.createNote(db, user, { slug: 'n', title: 'Zweite', body: '' }));
		expect(err.code).toBe('slug_taken');
		expect(err.hint).toContain('updateNote');
		expect(db.prepare('SELECT count(*) AS n FROM notes').get()?.n).toBe(1);
	});

	it('rejects a slug that is not kebab-case with invalid_slug instead of a raw SQLite error', () => {
		const { db } = setup();
		for (const slug of ['Adr-A', 'ADR_A', '-adr-a', ''])
			expect(caught(() => notes.createNote(db, user, { slug, title: 'x', body: '' })).code).toBe(
				'invalid_slug'
			);
	});

	it('rejects a status with kind≠adr as invalid_status, on create and when an update changes the kind away from adr', () => {
		const { db } = setup();
		expect(
			caught(() =>
				notes.createNote(db, user, { slug: 'n', title: 'x', body: '', status: 'accepted' })
			).code
		).toBe('invalid_status');

		const { id } = notes.createNote(db, user, {
			slug: 'a',
			title: 'A',
			body: '',
			kind: 'adr',
			status: 'accepted'
		});
		const err = caught(() => notes.updateNote(db, user, id, { kind: 'note' })); // status stays 'accepted' while the kind changes away from adr
		expect(err.code).toBe('invalid_status');
		expect(db.prepare('SELECT kind FROM notes WHERE id = ?').get(id)).toEqual({ kind: 'adr' }); // rejected, unchanged

		notes.updateNote(db, user, id, { kind: 'note', status: null }); // status cleared in the same call → allowed
		expect(db.prepare('SELECT kind, status FROM notes WHERE id = ?').get(id)).toEqual({
			kind: 'note',
			status: null
		});
	});
});

describe('searchNotes', () => {
	it('finds matches in title, tags and body, and special characters in the query break nothing', () => {
		const { db } = setup();
		notes.createNote(db, user, {
			slug: 'n-tag',
			title: 'Ohne Treffer im Titel',
			body: 'nichts',
			tags: ['kb.ai_import']
		});
		notes.createNote(db, user, {
			slug: 'n-body',
			title: 'Auch ohne',
			body: 'kb.ai_import steht hier im Body'
		});
		notes.createNote(db, user, { slug: 'n-title', title: 'kb.ai_import als Titel', body: '' });
		expect(
			notes
				.searchNotes(db, 'kb.ai_import')
				.map((h) => h.slug)
				.sort()
		).toEqual(['n-body', 'n-tag', 'n-title']);

		// special characters must not surface as an FTS5 syntax error (including an embedded NUL that cuts the bound string)
		for (const q of ['a"b', 'a (b) c', 'a-b:c*', 'NOT AND OR', '   ', 'a\0b', '\0'])
			expect(() => notes.searchNotes(db, q)).not.toThrow();
		expect(notes.searchNotes(db, '   ')).toEqual([]);
	});

	it('returns a snippet and bodyChars instead of the full body', () => {
		const { db } = setup();
		const body = `${Array(200).fill('lorem').join(' ')} treffer ${Array(200).fill('ipsum').join(' ')}`;
		notes.createNote(db, user, { slug: 'n', title: 'T', body });
		const [hit] = notes.searchNotes(db, 'treffer');
		expect(hit.bodyChars).toBe(body.length);
		expect(hit).not.toHaveProperty('body');
		expect(hit.snippet).toContain('treffer');
		expect(hit.snippet.length).toBeLessThan(body.length / 4); // a snippet, not an echo of the full text
	});

	it('optionally filters by kind, projectId and tag', () => {
		const { db, projectId } = setup();
		notes.createNote(db, user, {
			slug: 'adr-x',
			title: 'X',
			kind: 'adr',
			status: 'proposed',
			body: 'gemeinsamer suchbegriff'
		});
		notes.createNote(db, user, {
			slug: 'note-x',
			title: 'X',
			body: 'gemeinsamer suchbegriff',
			tags: ['wichtig'],
			projectIds: [projectId]
		});
		expect(notes.searchNotes(db, 'suchbegriff', { kind: 'adr' }).map((h) => h.slug)).toEqual([
			'adr-x'
		]);
		expect(notes.searchNotes(db, 'suchbegriff', { projectId }).map((h) => h.slug)).toEqual([
			'note-x'
		]);
		expect(notes.searchNotes(db, 'suchbegriff', { tag: 'wichtig' }).map((h) => h.slug)).toEqual([
			'note-x'
		]);
	});
});

describe('FTS index after update and archive', () => {
	it('drops old terms, adds new ones and stays consistent when archiving', () => {
		const { db } = setup();
		const { id } = notes.createNote(db, user, { slug: 'n', title: 'T', body: 'apfel' });
		expect(notes.searchNotes(db, 'apfel').map((h) => h.slug)).toEqual(['n']);

		notes.updateNote(db, user, id, { body: 'birne' });
		expect(notes.searchNotes(db, 'apfel')).toEqual([]);
		expect(notes.searchNotes(db, 'birne').map((h) => h.slug)).toEqual(['n']);

		notes.archiveNote(db, user, id);
		expect(notes.searchNotes(db, 'birne')).toEqual([]); // archived = filtered out of search by default
		const hits = notes.searchNotes(db, 'birne', { includeArchived: true });
		expect(hits).toHaveLength(1); // no duplicate or orphaned FTS entry from the update trigger when archiving
		expect(hits[0]).toMatchObject({ slug: 'n', archived: 1 });
	});

	it('ranks an archived note included through includeArchived clearly behind live notes', () => {
		const { db } = setup();
		const { id } = notes.createNote(db, user, {
			slug: 'n-alt',
			title: 'T',
			body: 'gemeinsam relevanter suchbegriff mehrfach suchbegriff suchbegriff'
		});
		notes.createNote(db, user, { slug: 'n-neu', title: 'T', body: 'suchbegriff einmal' });
		notes.archiveNote(db, user, id);
		expect(
			notes.searchNotes(db, 'suchbegriff', { includeArchived: true }).map((h) => h.slug)
		).toEqual(['n-neu', 'n-alt']);
	});
});

describe('ticket links', () => {
	it('links and unlinks tickets idempotently and rejects an unknown ticket', () => {
		const { db, ticketId } = setup();
		const { id: noteId } = notes.createNote(db, user, { slug: 'n', title: 'T', body: '' });
		notes.linkTicket(db, user, noteId, ticketId, 'documents');
		notes.linkTicket(db, user, noteId, ticketId, 'documents'); // idempotent
		expect(db.prepare('SELECT count(*) AS n FROM note_tickets').get()?.n).toBe(1);
		notes.unlinkTicket(db, user, noteId, ticketId, 'documents');
		expect(db.prepare('SELECT count(*) AS n FROM note_tickets').get()?.n).toBe(0);
		expect(caught(() => notes.linkTicket(db, user, noteId, 999999, 'documents')).code).toBe(
			'not_found'
		);
	});

	it("emits once per link and unlink with the ticket's projectId, and nothing for a repetition", () => {
		const { db, projectId, ticketId } = setup();
		const { id: noteId } = notes.createNote(db, user, { slug: 'n', title: 'T', body: '' });
		const events: StudioEvent[] = [];
		const off = subscribe((e) => events.push(e));

		notes.linkTicket(db, user, noteId, ticketId, 'documents');
		notes.linkTicket(db, user, noteId, ticketId, 'documents'); // idempotent, no second event
		notes.unlinkTicket(db, user, noteId, ticketId, 'documents');
		notes.unlinkTicket(db, user, noteId, ticketId, 'documents'); // already gone, no event
		off();

		expect(events.map((e) => e.type)).toEqual(['note.ticket_linked', 'note.ticket_unlinked']);
		expect(events[0]).toMatchObject({ projectId, ticketId, noteId, relation: 'documents' });
		expect(events[1]).toMatchObject({ projectId, ticketId, noteId, relation: 'documents' });
	});

	it('sets verified_at and verified_by_run_id on verifyNote, and optionally a verified_by link', () => {
		const { db, ticketId } = setup();
		const { id: noteId } = notes.createNote(db, user, { slug: 'n', title: 'T', body: '' });
		notes.verifyNote(db, dev, noteId, ticketId);
		const row = db
			.prepare('SELECT verified_at, verified_by_run_id FROM notes WHERE id = ?')
			.get(noteId) as { verified_at: string | null; verified_by_run_id: number | null };
		expect(row.verified_at).not.toBeNull();
		expect(row.verified_by_run_id).toBe(1);
		expect(
			db
				.prepare('SELECT relation FROM note_tickets WHERE note_id = ? AND ticket_id = ?')
				.get(noteId, ticketId)
		).toEqual({ relation: 'verified_by' });
	});
});

describe('optimistic concurrency (updateNote)', () => {
	it('rejects a change with a stale expectedVersion as `conflict` and leaves the current version unchanged', () => {
		const { db } = setup();
		const { id } = notes.createNote(db, user, { slug: 'n', title: 'Start', body: 'x' }); // version 1
		notes.updateNote(db, user, id, { title: 'Agent A' }); // version 2, no expectedVersion given: no conflict protection needed

		const err = caught(() => notes.updateNote(db, user, id, { title: 'Agent B (veraltet)' }, 1)); // knows only version 1
		expect(err.code).toBe('conflict');
		expect(err.hint).toContain('neu lesen');
		expect(db.prepare('SELECT title, version FROM notes WHERE id = ?').get(id)).toEqual({
			title: 'Agent A',
			version: 2
		}); // agent B's write did not take effect

		notes.updateNote(db, user, id, { title: 'Agent B (aktuell)' }, 2); // current version → allowed
		expect(db.prepare('SELECT title, version FROM notes WHERE id = ?').get(id)).toEqual({
			title: 'Agent B (aktuell)',
			version: 3
		});
	});
});
