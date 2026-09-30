# kabai studio — Leitfaden für Agents

**Was das ist:** Agent-Orchestrierungs-Studio. Tickets sind ausführbare Aufträge,
Board-Spalten tragen einen Rollen-Prompt und Regeln, KI-Agents (lokale Modelle
zuerst, Claude/OpenAI optional) arbeiten Tickets manuell oder automatisch ab. Der
Mensch orchestriert nur noch: Fragen beantworten, Freigaben erteilen, abnehmen.
Geistiger Nachfolger von kabai (MCP-Server) + kabai-ui (SvelteKit), aber
**eigenständig mit eigener Datenbank — keine Kompatibilität zu kabai nötig**.

**Stand:** Frühe Entwicklung.

**Lies zusätzlich `CLAUDE.local.md`, falls vorhanden** — dort stehen die internen,
nicht öffentlichen Arbeitsinfos (Board, Wissen, lokale Umgebung). Sie ist gitignored.

## Oberstes Designziel: UX und AX gleichrangig (verbindlich)

Studio hat zwei gleichrangige Nutzer: den **Menschen**, der orchestriert, und den
**Agent**, der arbeitet. Beide sollen angenehm und effizient arbeiten können. Jede
Funktion wird für beide entworfen; beide sehen dieselbe Wahrheit (eine
Domain-Schicht), nur die Oberfläche unterscheidet sich.

- **UX (Mensch):** kein Handbuch nötig (Defaults, Assistent) · Tastatur zuerst,
  häufige Aktionen in ≤ 2 Schritten, hohe Dichte, Live-Updates · Fragen,
  Freigaben, Abnahmen gesammelt in der Inbox · jede Agent-Aktion nachvollziehbar
  und übersteuerbar · Fehler immer mit Ausweg · zugänglich (Tastatur, Fokus,
  Kontrast WCAG AA, Labels, reduced motion) · unterwegs nutzbar.
- **AX (Agent):** Kontext im Prompt statt Erkundungsaufrufen · wenige, knappe
  Werkzeuge, batch-first, schlanke Antworten · keine impliziten Regeln (erlaubte
  Moves explizit) · Fehler mit stabilem Code und konkretem Ausweg · Identität
  automatisch aus dem Run · Token-Budget kleiner Modelle ernst nehmen ·
  retry-sichere Schreibaufrufe.
- Jedes Ticket mit sichtbarer Oberfläche (UI, MCP-Werkzeug, Prompt, CLI,
  Fehlermeldung) hat UX/AX-Kriterien; sie gehören zur Definition of Done und
  werden im Review ausdrücklich geprüft.

## Öffentliches Repo — Datenschutz (verbindlich)

Dieses Repo ist öffentlich. **Niemals** in Dateien, Commits oder Commit-Nachrichten:
Namen von Personen, E-Mail-Adressen, Passwörter, API-Keys/Tokens, lokale Pfade,
Hostnamen, IP-Adressen, Hardware-/Setup-Details oder interne Board-/Ticket-Inhalte.
Persönliches und Internes gehört in `CLAUDE.local.md`. Vor jedem Commit den Diff
darauf prüfen — und vorher `npm run scan:secrets` laufen lassen (gitleaks +
Privatsphären-Scan gegen `.privacy-patterns`).

## Arbeitsweise (verbindlich)

- Planung und Wissen liegen im kabai-Board des Maintainers (kabai-MCP, Skill
  `/kabai`); Details in `CLAUDE.local.md`. Die Skill gilt vollständig:
  Session-Start-Protokoll, Suche vor Anlage, Assign, ein Task pro
  Akzeptanzkriterium und sofort abhaken, Work-Log-Kommentare mit echter
  Verifikationsausgabe, `docs_required` + Notes früh anlegen, Fragen → Kommentar +
  `human_intervention`.
- **Die `agent_role_instruction` der Spalte, in der das Ticket liegt, ist deine
  Rolle** (Refine = Refiner ohne Code, In Arbeit = Developer, Review = Reviewer).
- Nur Tickets aus **Ready** aufnehmen, deren `blocks`-Vorgänger in **Abnahme** oder
  **done** liegen.
- Developer schieben höchstens bis **Review**. Ein eigener Review-Agent (nie der Autor)
  prüft; bei Befunden zurück nach In Arbeit, sonst „Review ok"-Kommentar, Merge und
  weiter nach **Abnahme**. **done setzt ausschließlich der Maintainer** aus Abnahme
  heraus — gesammelt (Sammelabnahme).
- Git-Hygiene: kein `git reset --hard`, `git clean` oder `git checkout -- .` im
  Worktree; Mutationsproben per `git stash` oder Wegwerf-Clone. Selbst gestartete
  Prozesse (Server, Test-Kinder) vor dem Abschluss beenden.
- Entscheidung ändert sich? Neues ADR + `supersedes`-Link, altes ADR nie umschreiben.

## Architektur-Leitplanken

Abweichung nur mit neuem ADR:

- **Ein Paket, ein Prozess:** SvelteKit + `adapter-node`; Orchestrator und Runner
  sind Server-Module unter `src/lib/server/`, gestartet über den `init`-Hook in
  `src/hooks.server.ts`.
- **Eigene SQLite-DB:** eine Datei, WAL. Kein ORM — schlichtes SQL + kleiner
  Migrationsrunner (`migrations/NNN_name.sql`). Harte Invarianten als Constraints,
  **Workflow-Regeln in der Domain-Schicht** (`src/lib/server/domain/`), die der
  **einzige Schreibpfad** für UI und MCP ist. Events über einen In-Process-Bus
  (`EventEmitter`), zum Browser per SSE.
- **Agents:** `acp`-Executor (fertige Coding-Agents per Agent Client Protocol) und
  `builtin`-Executor (eigener Tool-Loop mit Vercel AI SDK). Agents erreichen
  Studio-Daten **nur** über den Studio-MCP-Endpunkt mit Run-Token — nie direkt über
  die DB.
- **PWA ist der einzige Client**; Agents laufen nie im Client.
- **Isolation:** Git-Worktree pro Ticket + Freigaben für Shell/Netz.
- **Werkzeuge = MCP-Server.**
- **Secrets:** im UI eingegeben, AES-256-GCM-verschlüsselt in der DB (Schlüssel
  `secret.key` im Datenverzeichnis oder `STUDIO_SECRET_KEY`); nie zurück an den
  Browser, nie in Prompts, in Logs/Run-Events maskiert.
- **Auth:** ein Owner-Account, Passkey + Passwort (scrypt via `node:crypto`).
- **Auslieferung:** ein Befehl auf dem Host (`npx kabai-studio`, Einzel-Binary,
  `nix run`), keine Pflicht-Konfiguration; Einrichtung über den
  Onboarding-Assistenten statt Anleitung. Daraus folgt: **keine nativen
  Node-Addons** (`node:sqlite` statt `better-sqlite3`), keine Pflicht-Env-Variablen.
- **Agent-Experience:** Agents bekommen Ticket, Tasks, erlaubte Moves und Notes in
  den Prompt injiziert, statt sie zu erfragen. Studio-MCP-Werkzeuge sind
  batch-first, antworten schlank und nehmen die Identität aus dem Run-Token.

## Stack und Befehle

- Node **24** (Nix-Devshell), TypeScript strict, **Svelte 5 nur mit Runes**
  (per `compilerOptions.runes` erzwungen). Die Svelte-Konfiguration steht inline in
  `vite.config.ts` — es gibt keine `svelte.config.js`.
- Befehle über die Devshell:

```sh
nix develop --command npm run check    # svelte-check, muss 0 Fehler zeigen
nix develop --command npm run build    # Produktions-Build nach build/
ORIGIN=http://127.0.0.1:3000 nix develop --command node build   # Server auf http://127.0.0.1:3000 (HOST=0.0.0.0: alle Interfaces)
nix develop --command npm run reset-password   # Owner-Passwort neu setzen, beendet alle Sessions
nix develop --command npm run restore -- <backup-datei>   # Server gestoppt: sichert die aktuelle DB, spielt die Sicherung ein
nix develop --command npm test         # vitest (src/**/*.test.ts)
```

- Abhängigkeiten sparsam: erst Stdlib (`node:crypto`, `node:sqlite`, `node:events`),
  dann Plattform, dann ein neues Paket — mit Begründung im Ticket.

## Git

- Branch pro Ticket: `ticket/<id>-<kurz-slug>`, abgezweigt vom aktuellen `main`.
  Commits klein, Format `feat|fix|chore|docs: <was> (#<ticket-id>)`, ein Ticket pro
  Commit.
- Nach „Review ok" merged der Review-Agent den Ticket-Branch per `git merge --ff-only`
  nach `main` (vorher ggf. auf `main` rebasen) und löscht den Branch.
- Commit-Identität kommt aus der Repo-Konfiguration (noreply-Adresse) — nie ändern.
- Neue Remotes anlegen und pushen macht nur der Maintainer.
