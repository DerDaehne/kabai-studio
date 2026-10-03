// Renders the page server-side, so a missing +page.svelte fails at import ("Cannot find module")
// instead of only as a 404 in the browser.
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

it('shows an overview that links agent profiles and secrets and no pages that do not exist yet', () => {
	const body = page(ok);
	expect(body).toContain('Einstellungen');

	const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
	expect(hrefs).toEqual(['/settings/profiles', '/settings/secrets']); // no dead links

	for (const label of ['Agent-Profile', 'Secrets'])
		// one explaining sentence per entry
		expect(body).toMatch(
			new RegExp(`${label}<\/span>\\s*<span class="desc[^"]*">[^<]{10,}<\/span>`)
		);
});

it('shows the newest backup with time, size and path, and points to secret.key and restore', () => {
	const body = page(ok);
	expect(body).toMatch(/aktuell/);
	expect(body).toContain('2026-09-29 03:00 UTC');
	expect(body).toContain('2.3 MB');
	expect(body).toContain('/daten/backups/studio-20260929-0300.db');
	expect(body).toContain('7 tägliche + 4 wöchentliche');
	expect(body).toMatch(/secret\.key.*separat sichern/s);
	expect(body).toContain('npm run restore -- &lt;datei>');
});

it('marks a backup problem visibly, with cause and way out', () => {
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
