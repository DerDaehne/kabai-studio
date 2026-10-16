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
		'Verwendung: kabai-studio [start|service <install|uninstall|status>|runner pair <url> <code> [--name <name>]|runner start|reset-password|restore <datei>|--version]',
	'cli.unknownCommand': 'Unbekanntes Unterkommando „{command}“. {usage}',
	'cli.unknownServiceCommand':
		'Unbekanntes service-Unterkommando „{action}“. Verfügbar: install, uninstall, status.',
	'cli.runner.usage':
		'Verwendung: kabai-studio runner pair <Studio-Adresse> <Code> [--name <name>] oder kabai-studio runner start',
	'cli.runner.usage.hint':
		'Den vollständigen Befehl aus Studio kopieren: Einstellungen → Rechner → „Rechner verbinden“.',
	'cli.runner.invalidUrl': '„{url}“ ist keine Studio-Adresse.',
	'cli.runner.invalidUrl.hint':
		'Den vollständigen Befehl aus Studio kopieren: Einstellungen → Rechner → „Rechner verbinden“.',
	'cli.runner.insecureUrl':
		'Code und Credential gehen nicht unverschlüsselt über http:// an {host}.',
	'cli.runner.insecureUrl.hint':
		'Die https://-Adresse von Studio verwenden; http:// geht nur für localhost, 127.0.0.1 und [::1].',
	'cli.runner.unreachable': 'Studio unter {origin} ist nicht erreichbar ({reason}).',
	'cli.runner.unreachable.hint':
		'Adresse prüfen und ob Studio läuft, dann den Befehl erneut ausführen.',
	'cli.runner.unexpectedAnswer':
		'Studio unter {origin} hat mit HTTP {status} geantwortet statt mit einer Kopplung.',
	'cli.runner.unexpectedAnswer.hint':
		'Prüfen, ob die Adresse direkt zu Studio führt, ohne Anmeldeseite oder Weiterleitung dazwischen.',
	'cli.runner.writeFailed': '{file} lässt sich nicht schreiben ({reason}).',
	'cli.runner.writeFailed.hint':
		'Rechte des Ordners prüfen. Steht der Rechner schon in Studio, ihn dort trennen und neu koppeln.',
	'cli.runner.floor.notJson': '{file} ist kein gültiges JSON ({reason}).',
	'cli.runner.floor.notObject': '{file}: „{field}“ muss ein Objekt {…} sein.',
	'cli.runner.floor.notText': '{file}: „{field}“ muss ein nicht leerer Text sein.',
	'cli.runner.floor.notBoolean': '{file}: „{field}“ muss true oder false sein.',
	'cli.runner.floor.notTextList': '{file}: „{field}“ muss eine Liste nicht leerer Texte sein.',
	'cli.runner.floor.pathNotAbsolute': '{file}: „{field}“ muss ein absoluter Pfad sein.',
	'cli.runner.floor.pathMissing': '{file}: „{field}“ ist kein vorhandener Ordner.',
	'cli.runner.floor.slots': '{file}: „{field}“ muss eine ganze Zahl ab 1 sein.',
	'cli.runner.floor.origin':
		'{file}: „{field}“ muss die Studio-Adresse sein, z. B. https://studio.example.',
	'cli.runner.floor.originMismatch':
		'{file}: „{field}“ ist {actual}, gekoppelt wird aber mit {expected}.',
	'cli.runner.floor.hint':
		'Das Feld korrigieren oder die Datei löschen, damit sichere Vorgaben entstehen, dann den Befehl erneut ausführen.',
	'cli.runner.paired': 'Dieser Rechner ist als „{name}“ mit {origin} gekoppelt.',
	'cli.runner.credentialSaved': 'Credential in {file} gespeichert, nur für dich lesbar.',
	'cli.runner.floorCreated':
		'{file} mit sicheren Vorgaben angelegt: keine Workspaces, keine Agents, 1 Slot.',
	'cli.runner.floorChecked': '{file} geprüft: gültig.',
	'cli.runner.studioSees':
		'Studio erfährt nur Namen und Zahlen — Workspaces: {workspaces} · Agents: {agents} · Slots: {slots}',
	'cli.runner.next': 'Als Nächstes den Runner starten: „kabai-studio runner start“.',
	'cli.runner.start.notPaired': 'Dieser Rechner ist noch nicht gekoppelt ({file} fehlt).',
	'cli.runner.start.notPaired.hint': 'Erst koppeln: kabai-studio runner pair {origin} <Code>',
	'cli.runner.start.rePair.hint': 'Neu koppeln: kabai-studio runner pair {origin} <Code>',
	'cli.runner.start.credentialInvalid': '{file} ist keine gültige Credential-Datei des Runners.',
	'cli.runner.start.floorMissing': 'Die lokale Untergrenze {file} fehlt.',
	'cli.runner.start.insecureUrl':
		'Das Credential geht nicht über ws:// an {host}: Studio liegt nicht auf diesem Rechner und nicht hinter https.',
	'cli.runner.start.insecureUrl.hint':
		'Mit der https://-Adresse von Studio neu koppeln: kabai-studio runner pair <https-Adresse> <Code>.',
	'cli.runner.start.connected': 'Verbunden mit {origin} als „{name}“.',
	'cli.runner.start.lost': 'Verbindung verloren ({reason}); neuer Versuch in {seconds} s.',
	'cli.runner.start.stopped': 'Runner beendet.',
	'cli.runner.start.frameNotSupported':
		'[frame_not_supported] Studio hat einen Frame gesendet, den diese Version nicht annimmt; die Verbindung wird geschlossen.',
	'cli.runner.start.rejected':
		'Studio hat das Credential abgewiesen: Es ist unbekannt oder wurde widerrufen.',
	'cli.runner.start.revoked':
		'Studio hat diesen Rechner getrennt; sein Credential gilt nicht mehr.',
	'cli.runner.start.replaced':
		'Ein anderer Runner mit dieser Kopplung hat sich mit Studio verbunden und diesen ersetzt.',
	'cli.runner.start.replaced.hint':
		'Pro Kopplung nur ein „kabai-studio runner start“ laufen lassen. Soll dieser laufen, den anderen beenden und diesen neu starten; sollen beide laufen, diesen Rechner unter anderem Namen neu koppeln. Wenn Sie keinen zweiten Runner gestartet haben, wird die Kopplung anderswo benutzt: Rechner in Studio trennen und neu koppeln.',
	'cli.runner.start.protocol': 'Studio und dieser Runner sprechen verschiedene Protokollversionen.',
	'cli.runner.start.protocol.hint':
		'Studio und kabai-studio auf diesem Rechner auf dieselbe Version bringen, dann „kabai-studio runner start“ erneut ausführen.',
	'cli.runner.start.refused.browser_origin_forbidden':
		'Studio unter {origin} hat die Verbindung abgewiesen, weil sie einen Browser-Origin-Header trägt.',
	'cli.runner.start.refused.browser_origin_forbidden.hint':
		'Direkt oder über einen Proxy verbinden, der keinen Origin-Header ergänzt, dann „kabai-studio runner start“ erneut ausführen.',
	'cli.runner.start.refused.insecure_transport':
		'Studio unter {origin} nimmt Runner nur über https an.',
	'cli.runner.start.refused.insecure_transport.hint':
		'Studio hinter https stellen, ORIGIN auf diese Adresse setzen, neu koppeln, dann „kabai-studio runner start“ ausführen.',
	'cli.runner.start.refused.other': 'Studio unter {origin} hat die Verbindung abgewiesen.',
	'cli.runner.start.refused.other.hint':
		'Adresse von Studio und einen vorgeschalteten Proxy prüfen, dann „kabai-studio runner start“ erneut ausführen.',

	'start.heading': 'kabai studio',
	'start.lage.none': 'Kein Agent arbeitet.',
	'start.lage.toBoard': 'Zum Board',
	'start.lage.run': '{profile} ({location}) an {project} {ticket}',
	'start.location.lokal': 'lokal',
	'start.location.online': 'online',
	'start.today.tokens': 'Tokens heute',
	'start.today.cost': 'Kosten heute',
	'start.today.noCost': 'keine',
	'start.sidewaysHint': '← → oder seitlich scrollen',
	'start.section.now': 'jetzt',
	'start.section.projects': 'projekte',
	'start.section.operations': 'betrieb',
	'start.section.trace': 'spur',
	'start.state.question': 'fragt',
	'start.state.queued': 'in der Queue',
	'start.state.running': 'arbeitet',
	'start.state.waiting': 'hält',
	'start.state.paused': 'angehalten',
	'start.state.succeeded': 'fertig',
	'start.state.failed': 'fehlgeschlagen',
	'start.state.cancelled': 'abgebrochen',
	'start.now.empty': 'Nichts wartet auf dich.',
	'start.hidden.one': '{count} weitere in {projects} anderen Projekt',
	'start.hidden.other': '{count} weitere in {projects} anderen Projekten',
	'start.tile.asks': '{profile} fragt',
	'start.tile.more': 'mehr',
	'start.tile.moreLabel': 'mehr zur Frage von {ref}',
	'start.tile.tokens': 'Tokens',
	'start.tile.steps': 'Schritte',
	'start.tile.tokensPerMinute': 'Tokens je Minute',
	'start.tile.stepsPerMinute': 'Schritte je Minute',
	'start.answer.option': 'Antwort {number}: {label}',
	'start.answer.label': 'Antwort auf {ref}',
	'start.answer.sent': 'Antwort gesendet · {ref} setzt in {seconds} s fort',
	'start.answer.undo': 'Rückgängig',
	'start.projects.questions': 'Fragen',
	'start.projects.agents': 'Agents aktiv',
	'start.ops.runner': 'Runner',
	'start.ops.runnerStop': 'Not-Aus — weiter mit :fortsetzen all',
	'start.ops.runnerPause': 'alle Runs angehalten — weiter mit :fortsetzen all',
	'start.ops.runnerActive': 'Agents aktiv: {count}',
	'start.ops.runnerFree': 'frei',
	'start.ops.queued': 'wartet',
	'start.ops.queuedEmpty': 'Kein Run wartet.',
	'start.ops.earliest': 'frühester Start {time}',
	'start.ops.finished': 'zuletzt beendet',
	'start.ops.finishedEmpty': 'Noch kein beendeter Run.',
	'start.ops.wayOut': 'Ausweg: {text}',
	'start.trace.empty': 'Kein Agent arbeitet, also gibt es keine Spur.',
	'start.trace.runtime': 'läuft seit {time}',
	'start.trace.noSteps': 'noch kein Schritt',
	'start.trace.step': 'Schritt {number}',
	'start.trace.error': 'Fehler',
	'start.phase.working': 'arbeitet',
	'start.phase.thinking': 'denkt',
	'start.phase.writing': 'schreibt',
	'start.phase.tool': 'Werkzeug läuft',
	'start.phase.compacting': 'verdichtet den Kontext',
	'start.phase.model_loading': 'Modell lädt',
	'start.phase.model_downloading': 'Modell wird heruntergeladen',
	'start.stop.title': 'Run {id} abbrechen?',
	'start.stop.body':
		'Der Agent bricht sofort ab. Das lässt sich nicht rückgängig machen — für einen neuen Versuch startest du einen neuen Run.',
	'start.stop.keep': 'Weiterlaufen lassen',
	'start.stop.confirm': 'Run abbrechen (y)',

	'settings.signedInAs': 'Angemeldet als {name}',
	'settings.signOut': 'Abmelden',
	'settings.about.title': 'Über kabai studio',
	'settings.about.licenceText': 'Lizenztext (AGPL-3.0)',
	'settings.runners.label': 'Rechner',
	'settings.runners.description':
		'Computer, auf denen Coding-Agents für Studio arbeiten: koppeln, ansehen und trennen.',

	'runners.title': 'Rechner',
	'runners.intro':
		'Coding-Agents laufen auf einem gekoppelten Rechner, nie in Studio selbst. Der Rechner verbindet sich von sich aus mit Studio und entscheidet lokal, was er erlaubt; Studio sieht nur Namen und Zahlen.',
	'runners.connect': 'Rechner verbinden',
	'runners.empty.title': 'Noch kein Rechner gekoppelt',
	'runners.empty.body':
		'„Rechner verbinden“ zeigt einen Einmal-Code und den einen Befehl, der auf dem Rechner auszuführen ist.',
	'runners.neverConnected': 'noch nie verbunden',
	'runners.connected':
		'verbunden seit {time} · Slots: {slots} · Workspaces: {workspaces} · Agents: {agents}',
	'runners.notConnected':
		'nicht verbunden seit {time} – dort „kabai-studio runner start“ ausführen',
	'runners.disconnect': 'Trennen',
	'runners.disconnect.title': '„{name}“ trennen?',
	'runners.disconnect.body':
		'Der Rechner verliert sofort den Zugang. Um ihn wieder zu nutzen, mit einem neuen Code koppeln.',
	'runners.cancel': 'Abbrechen',
	'runners.dialog.intro':
		'Diesen Befehl in einem Terminal auf dem Rechner ausführen. Der Code gilt 10 Minuten und einmal; ein neuer Code ersetzt ihn.',
	'runners.dialog.code': 'Code',
	'runners.dialog.command': 'Befehl',
	'runners.dialog.copy': 'Befehl kopieren',
	'runners.dialog.copied': 'Befehl kopiert.',
	'runners.dialog.copyFailed':
		'Kopieren fehlgeschlagen: den Befehl markieren und von Hand kopieren.',
	'runners.dialog.after':
		'Meldet der Befehl Erfolg, diesen Dialog schließen: Dann steht der Rechner in der Liste.',
	'runners.pair.browserOrigin':
		'Koppeln geht nur über die Kommandozeile von kabai-studio, nicht aus einem Browser.',
	'runners.pair.browserOrigin.hint':
		'Den Befehl aus Einstellungen → Rechner in einem Terminal auf dem Rechner ausführen.',
	'runners.pair.insecureTransport':
		'Studio unter {origin} läuft nicht über HTTPS und gibt deshalb kein Rechner-Credential heraus.',
	'runners.pair.insecureTransport.hint':
		'Studio über HTTPS bereitstellen (etwa hinter einem Reverse-Proxy) oder auf demselben Rechner über 127.0.0.1 koppeln.',
	'runners.pair.tooManyAttempts': 'Zu viele Kopplungsversuche von dieser Adresse.',
	'runners.pair.tooManyAttempts.hint': 'Eine Minute warten, dann den Befehl erneut ausführen.',
	'runners.pair.invalidRequest': 'Das ist keine Kopplungsanfrage.',
	'runners.pair.invalidRequest.hint':
		'Den Befehl aus Einstellungen → Rechner → „Rechner verbinden“ verwenden.',
	'runners.pair.codeInvalid': 'Der Kopplungs-Code ist abgelaufen, schon benutzt oder unbekannt.',
	'runners.pair.codeInvalid.hint':
		'In Studio unter Einstellungen → Rechner → „Rechner verbinden“ einen neuen Code erzeugen und den dort gezeigten Befehl ausführen.',
	'runners.pair.nameInvalid': 'Der Rechnername muss 1 bis {max} druckbare Zeichen haben.',
	'runners.pair.nameInvalid.hint': 'Einen anderen Namen mit --name <name> übergeben.',

	'projects.heading': 'Projekte',
	'projects.intro': 'Ein Projekt sammelt Tickets und führt sie durch die Schritte seiner Variante.',
	'projects.archived': 'archiviert',
	'projects.new': 'Neues Projekt',
	'projects.name': 'Name',
	'projects.key': 'Key',
	'projects.key.hint':
		'Großbuchstaben und Ziffern, z. B. WEB. Er steht vor jeder Ticketnummer: WEB-1.',
	'projects.variant.legend': 'Wie arbeitet das Projekt?',
	'projects.create': 'Projekt anlegen',
	'projects.back': 'Alle Projekte',
	'projects.ticket.heading': 'Ticket anlegen',
	'projects.ticket.intro':
		'Ein Ticket startet im Backlog; in seiner Run-Akte gibst du es einem Agent.',
	'projects.ticket.title': 'Titel',
	'projects.ticket.create': 'Ticket anlegen',
	'projects.steps.heading': 'Schritte',
	'projects.steps.intro':
		'Variante {variant}: Ein Ticket durchläuft diese Schritte der Reihe nach.',

	'variant.software.name': 'Software',
	'variant.software.description':
		'Für Arbeit an Code: erst wird der Umfang geklärt und geplant, dann umgesetzt, dann kritisiert, bevor du abnimmst.',
	'variant.knowledge.name': 'Wissen',
	'variant.knowledge.description':
		'Für Notizen und Ausarbeitungen: erst wird recherchiert, dann ein Entwurf geschrieben, dann kritisiert, bevor du abnimmst.',
	'variant.direct.name': 'Direkt',
	'variant.direct.description':
		'Für kleine, klare Aufgaben: gleich umsetzen, dann kritisieren, bevor du abnimmst.',

	'step.backlog': 'Backlog',
	'step.refine': 'Präzisieren',
	'step.plan': 'Planen',
	'step.implement': 'Umsetzen',
	'step.research': 'Recherchieren',
	'step.draft': 'Entwerfen',
	'step.critique': 'Kritik',
	'step.acceptance': 'Abnahme',
	'step.done': 'Fertig',

	'board.title': 'Board – kabai studio',
	'board.heading': 'Board',
	'board.summary': '{count} Tickets',
	'board.new': 'Neues Ticket',
	'board.focus.label': 'Projekt-Fokus',
	'board.focus.all': 'Alle',
	'board.flow.show': 'Ablauf zeigen',
	'board.flow.hide': 'Ablauf verbergen',
	'board.flow.command': 'Spalten des Ablaufs zeigen oder verbergen',
	'board.flow.noNext': '{ref} hat keine nächste Spalte.',
	'board.flow.noPrevious': '{ref} hat keine vorige Spalte.',
	'board.flow.moved': '{ref} nach {column}',
	'board.group.empty': 'Nichts hier.',
	'board.done.more': 'Die letzten {shown} von {total}; ältere findest du mit /.',
	'board.progress': 'Schritt {index} von {total}',
	'board.step.backlog': 'noch nicht eingeplant',
	'board.step.refine': 'Umfang klären',
	'board.step.refine.working': 'Umfang wird gerade geklärt',
	'board.step.plan': 'Vorgehen festlegen',
	'board.step.plan.working': 'Vorgehen wird gerade festgelegt',
	'board.step.implement': 'Umsetzung',
	'board.step.implement.working': 'wird gerade umgesetzt',
	'board.step.research': 'Quellen sammeln',
	'board.step.research.working': 'Quellen werden gerade gesammelt',
	'board.step.draft': 'Ergebnis schreiben',
	'board.step.draft.working': 'wird gerade geschrieben',
	'board.step.critique': 'Ergebnis prüfen',
	'board.step.critique.working': 'wird gerade geprüft',
	'board.step.acceptance': 'bereit für deine Abnahme',
	'board.step.done': 'abgeschlossen',
	'board.run.profile': '{state} · {profile}',
	'board.tasksDone': 'Tasks erledigt',
	'board.epic': 'Epic {ref}',
	'board.created': '{ref} angelegt',
	'board.renamed': '{ref} umbenannt',
	'board.deleted': '{ref} gelöscht',
	'board.deleteFinal':
		'{ref} ist schon endgültig gelöscht; Rückgängig geht nur in den ersten {seconds} s.',
	'board.deleteFailed': 'Löschen ging nicht: {reason}',
	'board.undo': 'Rückgängig',
	'board.copied': '{ref} kopiert',
	'board.copyFailed': 'Kopieren erlaubt der Browser hier nicht. Die ID zum Abschreiben: {ref}',
	'board.draft.label': 'Titel des neuen Tickets in {project}',
	'board.draft.placeholder': 'Titel des neuen Tickets',
	'board.draft.create': 'Anlegen',
	'board.draft.hintCreate': 'anlegen',
	'board.draft.hintDiscard': 'verwerfen',
	'board.rename.label': 'Neuer Titel für {ref}',
	'board.rename.save': 'Speichern',
	'board.empty.title': 'Noch kein Ticket',
	'board.empty.hint': 'legt eins an.',
	'board.empty.hintIn': 'legt eins an in {project}.',
	'board.empty.action': 'Ticket anlegen',
	'board.intents.label': 'Aktionen für {ref}',
	'board.intent.start': 'Los',
	'board.intent.accept': 'Abnehmen',
	'board.intent.giveBack': 'Zurückgeben',
	'board.started': '{ref} gestartet',
	'board.startedBlocked.one': '{ref} gestartet, obwohl {refs} noch fertig werden muss',
	'board.startedBlocked.other': '{ref} gestartet, obwohl {refs} noch fertig werden müssen',
	'board.intent.answer': 'Antworten',
	'board.refusal.openTasks': 'Hake die offenen Tasks ab oder lösche sie.',
	'board.accepted': '{ref} abgenommen',
	'board.returned': '{ref} zurückgegeben, der nächste Run startet',
	'board.giveBack.label': 'Kommentar zum Zurückgeben von {ref}',
	'board.giveBack.placeholder': 'Was fehlt oder stimmt nicht?',
	'board.giveBack.send': 'Zurückgeben',
	'board.giveBack.hintSend': 'zurückgeben',
	'board.giveBack.hintDiscard': 'verwerfen',

	'lage.waiting': 'Wartet auf dich',
	'lage.working': 'In Arbeit',
	'lage.open': 'Offen',
	'lage.acceptance': 'Zur Abnahme',
	'lage.done': 'Fertig',
	'lage.reason.question': 'Offene Frage',
	'lage.reason.approval': 'Freigabe nötig',
	'lage.reason.proposal': 'Vorschlag prüfen',
	'lage.reason.failure': 'Run fehlgeschlagen',
	'lage.reason.stalled': 'Run endete ohne Abschluss des Schritts, neu starten',
	'lage.reason.predecessors': 'Wartet auf {refs}',
	'lage.reason.paused': 'Angehalten, weiter mit :fortsetzen',
	'lage.reason.not_prioritized': 'Noch nicht priorisiert',
	'lage.reason.ready': 'Bereit zum Start',
	'lage.wait.halt_stop': 'Not-Aus aktiv',
	'lage.wait.halt_pause': 'Alle Runs angehalten',
	'lage.wait.claim': 'Wartet auf den nächsten Claim',
	'lage.wait.pool_full': 'Pool „{pool}“ ist voll ({active} von {limit} aktiv)',
	'lage.wait.global_full': 'Globales Limit erreicht ({active} von {limit} aktiv)',
	'lage.wait.ahead': '{count} vor ihm in der Queue'
};
