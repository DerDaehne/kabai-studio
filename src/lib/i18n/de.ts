import type { Catalogue } from './index.ts';

export const de: Catalogue = {
	'auth.name': 'Name',
	'auth.password': 'Passwort',
	'auth.tooManyAttempts':
		'Zu viele Fehlversuche von dieser Adresse. Bitte eine Minute warten und dann erneut versuchen.',
	'auth.passwordTooShort': 'Das Passwort braucht mindestens {min} Zeichen.',
	'auth.passwordTooLong': 'Das Passwort darf höchstens {max} Zeichen haben.',

	'login.title': 'kabai studio — Anmelden',
	'login.submit': 'Anmelden',
	'login.wrongCredentials':
		'Name oder Passwort falsch. Passwort vergessen? Auf dem Server „npm run reset-password“ ausführen.',

	'setup.title': 'kabai studio einrichten',
	'setup.intro':
		'Lege den Owner-Account an. Den Setup-Token gibt der Server beim Start auf der Konsole aus.',
	'setup.token': 'Setup-Token',
	'setup.repeatPassword': 'Passwort wiederholen',
	'setup.submit': 'Owner anlegen',
	'setup.alreadyDone': 'Studio ist bereits eingerichtet — bitte unter /login anmelden.',
	'setup.wrongToken':
		'Setup-Token falsch. Den gültigen zeigt die Server-Konsole beim Start (Zeile „Setup-Token“); nach einem Neustart gilt ein neuer.',
	'setup.nameMissing': 'Bitte einen Namen eingeben.',
	'setup.passwordsDiffer':
		'Die beiden Passwörter stimmen nicht überein — bitte beide Felder gleich ausfüllen.',

	'layout.attribution': 'von {author} · Freie Software, {licence}',

	'cli.usage':
		'Verwendung: kabai-studio [start|service <install|uninstall|status>|reset-password|restore <datei>|--version]',
	'cli.unknownCommand': 'Unbekanntes Unterkommando „{command}“. {usage}',
	'cli.unknownServiceCommand':
		'Unbekanntes service-Unterkommando „{action}“. Verfügbar: install, uninstall, status.'
};
