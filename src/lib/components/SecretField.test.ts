import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import SecretField from './SecretField.svelte';

const html = (props: Record<string, unknown>) =>
	render(SecretField, { props }).body.replace(/<!--[\s\S]*?-->/g, '');

it('gespeichertes Secret: nur „gesetzt“, Ersetzen und Löschen — kein Eingabefeld für den Wert', () => {
	const out = html({ name: 'demo', updatedAt: '2026-01-01 00:00:00' });
	expect(out).toContain('<strong>demo</strong> — gesetzt');
	expect(out).toContain('action="?/deleteSecret"');
	expect(out).not.toContain('type="password"');
});

it('Fehler steht am betroffenen Feld (aria-describedby) mit Ursache und Ausweg — auch ohne JS nach dem Neuladen', () => {
	const error = {
		code: 'secret_too_short',
		message: 'Der Wert hat nur 5 Zeichen.',
		hint: 'Prüfe, ob der Key vollständig eingefügt wurde.'
	};
	const out = html({ name: 'demo', updatedAt: '2026-01-01 00:00:00', error });
	const id = out.match(
		/<p id="([^"]+)" role="alert">Der Wert hat nur 5 Zeichen\. Prüfe, ob der Key vollständig eingefügt wurde\.<\/p>/
	)?.[1];
	expect(id).toBeTruthy();
	expect(out).toMatch(
		new RegExp(`<input type="password"[^>]*aria-invalid="true" aria-describedby="${id}"`)
	);
	expect(out).toContain('name="replace" value="1"');

	const named = html({ error: { ...error, code: 'secret_exists' } });
	expect(named).toMatch(
		/<input name="name"[^>]*aria-invalid="true" aria-describedby="[^"]+-error"/
	);
	expect(named).toMatch(/<input type="password"[^>]*aria-invalid="false"/);
});

it('„Abbrechen“ gibt es nur beim Ersetzen eines gespeicherten Secrets — beim neuen Secret hätte es keine Wirkung', () => {
	const error = { code: 'secret_too_short', message: 'Zu kurz.', hint: 'Vollständig einfügen.' };
	expect(html({ name: 'demo', updatedAt: '2026-01-01 00:00:00', error })).toContain(
		'>Abbrechen</button>'
	);
	expect(html({ error })).not.toContain('Abbrechen');
	expect(html({ error })).not.toContain('name="replace"');
});
