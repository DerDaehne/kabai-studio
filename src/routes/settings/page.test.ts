// #820: /settings lieferte 404 (kein +page.svelte). Rendert die Seite serverseitig — schlägt ohne die Datei
// schon beim Import fehl ("Cannot find module") statt erst im Browser als 404.
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import type { BackupStatus } from '$lib/server/backup';
import Page from './+page.svelte';

const retention = { daily: 7, weekly: 4 };
const ok: BackupStatus = {
	dir: '/daten/backups',
	last: {
		path: '/daten/backups/studio-20260929-0300.db',
		size: 2_345_678,
		at: '2026-09-29T03:00:00.000Z'
	},
	error: null
};
const page = (backup: BackupStatus) =>
	render(Page, { props: { data: { backup, retention } } as any }).body;

it('zeigt eine Übersicht mit Secrets verlinkt und ohne Links auf nicht existierende Seiten', () => {
	const body = page(ok);
	expect(body).toContain('Einstellungen');

	const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
	expect(hrefs).toEqual(['/settings/secrets']); // nur Secrets ist umgesetzt — keine toten Links auf #784/#785/#812

	expect(body).toMatch(/Secrets<\/span>\s*<span class="desc[^"]*">[^<]{10,}<\/span>/); // Erklärungssatz je Eintrag
});

it('Sicherung (#808): letzte Sicherung mit Zeit, Größe, Pfad; Hinweis auf secret.key und restore', () => {
	const body = page(ok);
	expect(body).toMatch(/aktuell/);
	expect(body).toContain('2026-09-29 03:00 UTC');
	expect(body).toContain('2.3 MB');
	expect(body).toContain('/daten/backups/studio-20260929-0300.db');
	expect(body).toContain('7 tägliche + 4 wöchentliche');
	expect(body).toMatch(/secret\.key.*separat sichern/s);
	expect(body).toContain('npm run restore -- &lt;datei>');
});

it('Sicherung (#808): Problem sichtbar markiert, mit Ursache und Ausweg', () => {
	const body = page({
		dir: '/daten/backups',
		last: null,
		error:
			'Sicherung nach /daten/backups fehlgeschlagen (ENOSPC). Freien Speicherplatz und Schreibrechte prüfen.'
	});
	expect(body).toMatch(/data-tone="failed"[^>]*>.*Problem/s);
	expect(body).toContain('fehlgeschlagen (ENOSPC). Freien Speicherplatz und Schreibrechte prüfen.');
	expect(body).toMatch(/Verzeichnis.*\/daten\/backups/s);
	expect(body).not.toMatch(/aktuell/);
});
