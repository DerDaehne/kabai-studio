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

## Öffentliches Repo — Datenschutz (verbindlich)

Dieses Repo ist öffentlich. **Niemals** in Dateien, Commits oder Commit-Nachrichten:
Namen von Personen, E-Mail-Adressen, Passwörter, API-Keys/Tokens, lokale Pfade,
Hostnamen, IP-Adressen, Hardware-/Setup-Details oder interne Board-/Ticket-Inhalte.
Persönliches und Internes gehört in `CLAUDE.local.md`. Vor jedem Commit den Diff
darauf prüfen.

## Arbeitsweise (verbindlich)

- Planung und Wissen liegen im kabai-Board des Maintainers (kabai-MCP, Skill
  `/kabai`); Details in `CLAUDE.local.md`. Die Skill gilt vollständig:
  Session-Start-Protokoll, Suche vor Anlage, Assign, ein Task pro
  Akzeptanzkriterium und sofort abhaken, Work-Log-Kommentare mit echter
  Verifikationsausgabe, `docs_required` + Notes früh anlegen, Fragen → Kommentar +
  `human_intervention`.
- **Die `agent_role_instruction` der Spalte, in der das Ticket liegt, ist deine
  Rolle** (Refine = Refiner ohne Code, In Arbeit = Developer, Review = Reviewer).
- Nur Tickets aus **Ready** aufnehmen, deren `blocks`-Vorgänger done sind **oder** in
  Review liegen und einen Kommentar „Review ok" eines Review-Agents tragen.
- Agents schieben höchstens bis **Review**. Ein eigener Review-Agent (nie der Autor)
  prüft und kommentiert „Review ok" oder schiebt mit Befunden zurück. **done setzt
  ausschließlich der Maintainer** — gesammelt (Sammelabnahme).
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
nix develop --command node build       # Server auf http://localhost:3000
nix develop --command npm test         # Tests (sobald eingerichtet)
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
