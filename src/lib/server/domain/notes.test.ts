import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../db';
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
	it('legt eine Note an, setzt nur freigegebene Felder und archiviert idempotent', () => {
		const { db } = setup();
		const { id, warnings } = notes.createNote(db, user, { slug: 'n-1', title: 'Titel', body: 'x', tags: ['a', 'b'] });
		expect(warnings).toEqual([]);
		expect(db.prepare('SELECT slug, title, tags, archived, version FROM notes WHERE id = ?').get(id)).toEqual({
			slug: 'n-1',
			title: 'Titel',
			tags: '["a","b"]',
			archived: 0,
			version: 1
		});

		notes.updateNote(db, user, id, { title: 'Neu' });
		expect(db.prepare('SELECT title, version FROM notes WHERE id = ?').get(id)).toEqual({ title: 'Neu', version: 2 });

		const err = caught(() => notes.updateNote(db, user, id, { slug: 'anders' } as never));
		expect(err.code).toBe('unknown_field');
		expect(err.hint).toContain('archiveNote');

		notes.archiveNote(db, user, id);
		notes.archiveNote(db, user, id); // idempotent
		expect(db.prepare('SELECT archived FROM notes WHERE id = ?').get(id)).toEqual({ archived: 1 });
	});
});

describe('Wikilinks', () => {
	it('[[slug]] erzeugt/entfernt automatische references-Links; manuelle Links und unbekannte Slugs bleiben unberührt', () => {
		const { db } = setup();
		const b = notes.createNote(db, user, { slug: 'b', title: 'B', body: '' }).id;
		const c = notes.createNote(db, user, { slug: 'c', title: 'C', body: '' }).id;
		const created = notes.createNote(db, user, { slug: 'a', title: 'A', body: 'siehe [[b]] und [[fehlt]]' });
		expect(created.warnings).toEqual(['Unbekannter Slug „fehlt“ im Wikilink — kein Link angelegt.']);

		const edges = () =>
			db.prepare("SELECT to_note_id AS toId, origin FROM note_links WHERE from_note_id = ? AND type = 'references' ORDER BY to_note_id").all(created.id);
		expect(edges()).toEqual([{ toId: b, origin: 'wikilink' }]);

		notes.linkNote(db, user, created.id, c, 'references'); // manuell, anderes Ziel
		expect(edges()).toEqual([
			{ toId: b, origin: 'wikilink' },
			{ toId: c, origin: 'manual' }
		]);

		notes.updateNote(db, user, created.id, { body: 'kein Wikilink mehr' }); // [[b]] entfernt
		expect(edges()).toEqual([{ toId: c, origin: 'manual' }]); // automatische Kante weg, manuelle bleibt

		notes.updateNote(db, user, created.id, { body: '[[b]] wieder da' });
		expect(edges()).toEqual([
			{ toId: b, origin: 'wikilink' },
			{ toId: c, origin: 'manual' }
		]);
	});

	it('ein Wikilink auf ein bereits manuell verlinktes Ziel dupliziert nichts und der Origin bleibt manual', () => {
		const { db } = setup();
		const b = notes.createNote(db, user, { slug: 'b', title: 'B', body: '' }).id;
		const a = notes.createNote(db, user, { slug: 'a', title: 'A', body: '' }).id;
		notes.linkNote(db, user, a, b, 'references');
		notes.updateNote(db, user, a, { body: '[[b]]' });
		const origin = () => db.prepare("SELECT origin FROM note_links WHERE from_note_id = ? AND to_note_id = ? AND type = 'references'").get(a, b);
		expect(origin()).toEqual({ origin: 'manual' });

		notes.updateNote(db, user, a, { body: 'kein Wikilink mehr' }); // Wikilink entfernt — manuelle Kante bleibt
		expect(origin()).toEqual({ origin: 'manual' });
		expect(db.prepare('SELECT count(*) AS n FROM note_links').get()?.n).toBe(1); // keine Dopplung
	});

	it('linkNote weist Selbst-Verknüpfung ab', () => {
		const { db } = setup();
		const a = notes.createNote(db, user, { slug: 'a', title: 'A', body: '' }).id;
		expect(caught(() => notes.linkNote(db, user, a, a, 'references')).code).toBe('self_relation');
	});
});

describe('supersedes', () => {
	it('setzt die Ziel-ADR auf superseded; die Suche rankt sie herab', () => {
		const { db } = setup();
		const old = notes.createNote(db, user, { slug: 'adr-old', title: 'Alt', kind: 'adr', status: 'accepted', body: 'Datenbankentscheidung' }).id;
		const neu = notes.createNote(db, user, { slug: 'adr-new', title: 'Neu', kind: 'adr', status: 'accepted', body: 'Datenbankentscheidung, neu gefasst' }).id;
		notes.linkNote(db, user, neu, old, 'supersedes');
		expect(db.prepare('SELECT status FROM notes WHERE id = ?').get(old)).toEqual({ status: 'superseded' });

		const hits = notes.searchNotes(db, 'Datenbankentscheidung');
		expect(hits.map((h) => h.slug)).toEqual(['adr-new', 'adr-old']); // superseded zuletzt
		expect(hits.map((h) => h.status)).toEqual(['accepted', 'superseded']);
	});

	it('setzt den Status nur bei kind=adr; bei anderen Notes bleibt er NULL', () => {
		const { db } = setup();
		const old = notes.createNote(db, user, { slug: 'note-old', title: 'Alt', body: '' }).id;
		const neu = notes.createNote(db, user, { slug: 'note-new', title: 'Neu', body: '' }).id;
		notes.linkNote(db, user, neu, old, 'supersedes');
		expect(db.prepare('SELECT status FROM notes WHERE id = ?').get(old)).toEqual({ status: null });
	});
});

describe('searchNotes', () => {
	it('findet Treffer in Titel/Tags/Body; Sonderzeichen im Suchbegriff brechen nichts', () => {
		const { db } = setup();
		notes.createNote(db, user, { slug: 'n-tag', title: 'Ohne Treffer im Titel', body: 'nichts', tags: ['kb.ai_import'] });
		notes.createNote(db, user, { slug: 'n-body', title: 'Auch ohne', body: 'kb.ai_import steht hier im Body' });
		notes.createNote(db, user, { slug: 'n-title', title: 'kb.ai_import als Titel', body: '' });
		expect(notes.searchNotes(db, 'kb.ai_import').map((h) => h.slug).sort()).toEqual(['n-body', 'n-tag', 'n-title']);

		// Sonderzeichen: darf nicht als FTS5-Syntaxfehler durchschlagen
		for (const q of ['a"b', 'a (b) c', 'a-b:c*', 'NOT AND OR', '   ']) expect(() => notes.searchNotes(db, q)).not.toThrow();
		expect(notes.searchNotes(db, '   ')).toEqual([]);
	});

	it('liefert Snippet + bodyChars statt des vollen Bodys', () => {
		const { db } = setup();
		const body = `${Array(200).fill('lorem').join(' ')} treffer ${Array(200).fill('ipsum').join(' ')}`;
		notes.createNote(db, user, { slug: 'n', title: 'T', body });
		const [hit] = notes.searchNotes(db, 'treffer');
		expect(hit.bodyChars).toBe(body.length);
		expect(hit).not.toHaveProperty('body');
		expect(hit.snippet).toContain('treffer');
		expect(hit.snippet.length).toBeLessThan(body.length / 4); // Snippet, kein Volltext-Echo
	});

	it('filtert optional nach kind, projectId und tag', () => {
		const { db, projectId } = setup();
		notes.createNote(db, user, { slug: 'adr-x', title: 'X', kind: 'adr', status: 'proposed', body: 'gemeinsamer suchbegriff' });
		notes.createNote(db, user, { slug: 'note-x', title: 'X', body: 'gemeinsamer suchbegriff', tags: ['wichtig'], projectIds: [projectId] });
		expect(notes.searchNotes(db, 'suchbegriff', { kind: 'adr' }).map((h) => h.slug)).toEqual(['adr-x']);
		expect(notes.searchNotes(db, 'suchbegriff', { projectId }).map((h) => h.slug)).toEqual(['note-x']);
		expect(notes.searchNotes(db, 'suchbegriff', { tag: 'wichtig' }).map((h) => h.slug)).toEqual(['note-x']);
	});
});

describe('FTS-Index bleibt nach Update/Archivieren synchron', () => {
	it('alte Suchbegriffe verschwinden, neue erscheinen; Archivieren hält den Index konsistent', () => {
		const { db } = setup();
		const { id } = notes.createNote(db, user, { slug: 'n', title: 'T', body: 'apfel' });
		expect(notes.searchNotes(db, 'apfel').map((h) => h.slug)).toEqual(['n']);

		notes.updateNote(db, user, id, { body: 'birne' });
		expect(notes.searchNotes(db, 'apfel')).toEqual([]);
		expect(notes.searchNotes(db, 'birne').map((h) => h.slug)).toEqual(['n']);

		notes.archiveNote(db, user, id);
		const hits = notes.searchNotes(db, 'birne');
		expect(hits).toHaveLength(1); // kein doppelter/verwaister FTS-Eintrag durch den Update-Trigger beim Archivieren
		expect(hits[0]).toMatchObject({ slug: 'n', archived: 1 });
	});
});

describe('Ticket-Verknüpfung', () => {
	it('linkTicket/unlinkTicket sind idempotent und lehnen ein unbekanntes Ticket ab', () => {
		const { db, ticketId } = setup();
		const { id: noteId } = notes.createNote(db, user, { slug: 'n', title: 'T', body: '' });
		notes.linkTicket(db, user, noteId, ticketId, 'documents');
		notes.linkTicket(db, user, noteId, ticketId, 'documents'); // idempotent
		expect(db.prepare('SELECT count(*) AS n FROM note_tickets').get()?.n).toBe(1);
		notes.unlinkTicket(db, user, noteId, ticketId, 'documents');
		expect(db.prepare('SELECT count(*) AS n FROM note_tickets').get()?.n).toBe(0);
		expect(caught(() => notes.linkTicket(db, user, noteId, 999999, 'documents')).code).toBe('not_found');
	});

	it('verifyNote setzt verified_at/verified_by_run_id und optional eine verified_by-Verknüpfung', () => {
		const { db, ticketId } = setup();
		const { id: noteId } = notes.createNote(db, user, { slug: 'n', title: 'T', body: '' });
		notes.verifyNote(db, dev, noteId, ticketId);
		const row = db.prepare('SELECT verified_at, verified_by_run_id FROM notes WHERE id = ?').get(noteId) as { verified_at: string | null; verified_by_run_id: number | null };
		expect(row.verified_at).not.toBeNull();
		expect(row.verified_by_run_id).toBe(1);
		expect(db.prepare('SELECT relation FROM note_tickets WHERE note_id = ? AND ticket_id = ?').get(noteId, ticketId)).toEqual({ relation: 'verified_by' });
	});
});

describe('optimistische Nebenläufigkeit (updateNote)', () => {
	it('weist eine Änderung mit veralteter expectedVersion mit `conflict` ab; die aktuelle Version bleibt unverändert', () => {
		const { db } = setup();
		const { id } = notes.createNote(db, user, { slug: 'n', title: 'Start', body: 'x' }); // version 1
		notes.updateNote(db, user, id, { title: 'Agent A' }); // version 2, kein expectedVersion angegeben: kein Konfliktschutz nötig

		const err = caught(() => notes.updateNote(db, user, id, { title: 'Agent B (veraltet)' }, 1)); // kennt nur Version 1
		expect(err.code).toBe('conflict');
		expect(err.hint).toContain('neu lesen');
		expect(db.prepare('SELECT title, version FROM notes WHERE id = ?').get(id)).toEqual({ title: 'Agent A', version: 2 }); // Agent Bs Schreibversuch griff nicht

		notes.updateNote(db, user, id, { title: 'Agent B (aktuell)' }, 2); // aktuelle Version -> erlaubt
		expect(db.prepare('SELECT title, version FROM notes WHERE id = ?').get(id)).toEqual({ title: 'Agent B (aktuell)', version: 3 });
	});
});
