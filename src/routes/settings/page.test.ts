// #820: /settings lieferte 404 (kein +page.svelte). Rendert die Seite serverseitig — schlägt ohne die Datei
// schon beim Import fehl ("Cannot find module") statt erst im Browser als 404.
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import Page from './+page.svelte';

it('zeigt eine Übersicht mit Secrets verlinkt und ohne Links auf nicht existierende Seiten', () => {
	const { body } = render(Page);
	expect(body).toContain('Einstellungen');

	const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
	expect(hrefs).toEqual(['/settings/secrets']); // nur Secrets ist umgesetzt — keine toten Links auf #784/#785/#812

	expect(body).toMatch(/Secrets<\/span>\s*<span class="desc[^"]*">[^<]{10,}<\/span>/); // Erklärungssatz je Eintrag
});
