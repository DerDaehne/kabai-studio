# kabai studio — guide for agents

**What this is:** an agent orchestration studio. Tickets are executable jobs, board
columns carry a role prompt and rules, and AI agents (local models first,
Claude/OpenAI optional) work tickets manually or automatically. The human only
orchestrates: answering questions, granting approvals, accepting results.
Successor in spirit to kabai (MCP server) + kabai-ui (SvelteKit), but
**standalone with its own database — no compatibility with kabai required**.

**Status:** early development.

**Also read `CLAUDE.local.md` if it exists** — it holds the internal, non-public
working information (board, knowledge base, local environment). It is gitignored.

## Top design goal: UX and AX are equal (binding)

Studio has two equal users: the **human** who orchestrates and the **agent** who
works. Both should be able to work pleasantly and efficiently. Every feature is
designed for both; both see the same truth (one domain layer), only the surface
differs.

- **UX (human):** no manual needed (defaults, onboarding assistant) · keyboard
  first, frequent actions in ≤ 2 steps, high density, live updates · questions,
  approvals and acceptances collected in one inbox · every agent action traceable
  and overridable · errors always offer a way out · accessible (keyboard, focus,
  WCAG AA contrast, labels, reduced motion) · usable on the go.
- **AX (agent):** context in the prompt instead of discovery calls · few, concise
  tools, batch-first, lean responses · no implicit rules (allowed moves explicit)
  · errors with a stable code and a concrete way out · identity derived from the
  run · take the token budget of small models seriously · retry-safe writes.
- Every ticket with a visible surface (UI, MCP tool, prompt, CLI, error message)
  has UX/AX criteria; they are part of the definition of done and are checked
  explicitly in review.

## Public repository — privacy (binding)

This repository is public. **Never** put into files, commits or commit messages:
names of people, email addresses, passwords, API keys/tokens, local paths,
hostnames, IP addresses, hardware/setup details, or internal board content
(ticket comments, note slugs, board columns). Ticket numbers appear only in commit
subjects as `(#<id>)`. Personal and internal information belongs in
`CLAUDE.local.md`. Before every commit run `npm run scan:secrets` (gitleaks +
privacy scan against the local `.privacy-patterns`) and check the diff.

## Code style (binding)

People should understand intent and behaviour by reading the code.

- **Readable code over comments.** Express intent through clear names, small
  well-named functions, explicit types and straightforward control flow. A few more
  lines that follow best practices beat a dense line plus a comment.
- **Shallow nesting:** at most 2 levels of nested blocks inside a function, 3 only
  as a justified exception. Flatten with early returns, guard clauses and extracted
  functions.
- **Short functions:** a function or method fits on one normal screen (about 40
  lines). Longer → split into well-named steps.
- **Comment only what the code cannot say:** a non-obvious _why_, a workaround
  (name the underlying cause), a security or concurrency invariant, or a deliberate
  simplification (`ponytail:` marker with its limit and upgrade path). Keep it to
  one short line where possible.
- **No comments that** restate the code, narrate changes ("now uses …", "fixed …")
  or reference tickets, ADRs, notes or other board content — history belongs in
  commit messages, knowledge in the maintainer's knowledge base.
- **TSDoc** only when the contract is not obvious from name and types (units, side
  effects, thrown errors, invariants): one sentence, no restating of parameters.
- **Tests document behaviour:** test names are sentences describing the behaviour.
- **English everywhere in the repository:** identifiers, comments, test names,
  commit messages and docs.
- **Lean means no unneeded features or abstractions — not dense code.**
  Readability wins over line count.
- Reviewers treat violations as findings.

## Way of working (binding)

- Planning and knowledge live in the maintainer's kabai board (kabai MCP, skill
  `/kabai`); details in `CLAUDE.local.md`. The skill applies in full: session start
  protocol, search before creating, assign, one task per acceptance criterion and
  tick it immediately, work-log comments with real verification output,
  `docs_required` + notes created early, questions → comment + `human_intervention`.
- **The `agent_role_instruction` of the column the ticket is in is your role**
  (Refine = refiner without code, In Arbeit = developer, Review = reviewer).
- Only pick up tickets from **Ready** whose `blocks` predecessors are in
  **Abnahme** (acceptance) or **done**.
- Developers move tickets at most to **Review**. A separate review agent (never the
  author) checks; findings → back to In Arbeit, otherwise a "Review ok" comment,
  merge, and on to **Abnahme**. **Only the maintainer sets done**, from Abnahme, in
  batches.
- Bug tickets: first write a test that fails on `main`. Probes a reviewer used to
  demonstrate a finding become permanent regression tests.
- Git hygiene: no `git reset --hard`, `git clean` or `git checkout -- .` in a
  worktree; do mutation probes with `git stash` or a throwaway clone. Stop every
  process you started (servers, test children) before finishing.
- A decision changes? New ADR + `supersedes` link; never rewrite the old ADR.

## Architecture guardrails

Deviations only with a new ADR:

- **One package, one process:** SvelteKit + `adapter-node`; orchestrator and runner
  are server modules under `src/lib/server/`, started from the `init` hook in
  `src/hooks.server.ts`.
- **Own SQLite database:** one file, WAL. No ORM — plain SQL + a small migration
  runner (`migrations/NNN_name.sql`). Hard invariants as constraints, **workflow
  rules in the domain layer** (`src/lib/server/domain/`), which is the **only write
  path** for UI and MCP. Events go through an in-process bus (`EventEmitter`) and
  reach the browser via SSE.
- **Agents:** `acp` executor (existing coding agents via the Agent Client Protocol)
  and `builtin` executor (own tool loop with the Vercel AI SDK). Agents reach studio
  data **only** through the studio MCP endpoint with a run token — never directly
  via the database.
- **The PWA is the only client**; agents never run in the client.
- **Isolation:** one git worktree per ticket + approvals for shell/network.
- **Tools = MCP servers.**
- **Secrets:** entered in the UI, stored AES-256-GCM encrypted in the database (key
  `secret.key` in the data directory or `STUDIO_SECRET_KEY`); never sent back to the
  browser, never put into prompts, masked in logs and run events.
- **Auth:** one owner account, passkey + password (scrypt via `node:crypto`).
- **Delivery:** one command on the host (`npx kabai-studio`, single binary,
  `nix run`), no required configuration; setup through the onboarding assistant
  instead of a manual. Consequently: **no native Node add-ons** (`node:sqlite`
  instead of `better-sqlite3`) and no required environment variables.
- **Agent experience:** agents get ticket, tasks, allowed moves and notes injected
  into the prompt instead of querying for them. Studio MCP tools are batch-first,
  answer leanly and take the identity from the run token.

## Stack and commands

- Node **24** (Nix devshell), TypeScript strict, **Svelte 5 with runes only**
  (enforced via `compilerOptions.runes`). The Svelte configuration lives inline in
  `vite.config.ts` — there is no `svelte.config.js`.
- Run commands through the devshell:

```sh
nix develop --command npm run check    # svelte-check, must report 0 errors
nix develop --command npm run build    # production build into build/
ORIGIN=http://127.0.0.1:3000 nix develop --command node build   # server on http://127.0.0.1:3000 (HOST=0.0.0.0: all interfaces)
nix develop --command npm run reset-password   # set a new owner password, ends all sessions
nix develop --command npm run restore -- <backup-file>   # server stopped: backs up the current DB, restores the backup
nix develop --command npm test         # vitest (src/**/*.test.ts)
nix develop --command npm run scan:secrets   # gitleaks + privacy scan before committing
```

- Dependencies sparingly: standard library first (`node:crypto`, `node:sqlite`,
  `node:events`), then the platform, then a new package — with a justification in
  the ticket.

## Git

- One branch per ticket: `ticket/<id>-<short-slug>`, branched from the current
  `main`. Small commits in English, format
  `feat|fix|chore|docs|ci: <what> (#<ticket-id>)`, one ticket per commit.
- After "Review ok" the review agent merges the ticket branch into `main` with
  `git merge --ff-only` (rebasing onto `main` first if needed) and deletes the
  branch.
- The commit identity comes from the repository configuration (noreply address) —
  never change it.
- Only the maintainer creates remotes and pushes.
