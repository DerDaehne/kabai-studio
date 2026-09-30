# kabai studio

[![CI](https://github.com/DerDaehne/kabai-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/DerDaehne/kabai-studio/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/DerDaehne/kabai-studio/badge)](https://securityscorecards.dev/viewer/?uri=github.com/DerDaehne/kabai-studio)

Agent orchestration studio: tickets are executable jobs. Board columns carry a
role prompt and rules; AI agents — local models first (llama.cpp, Ollama or any
OpenAI-compatible server), Claude/OpenAI optional — work tickets manually or
automatically, and the human only
orchestrates: answering questions, granting approvals, accepting results.

Successor in spirit to [kabai](https://github.com/DerDaehne/kabai) +
[kabai-ui](https://github.com/DerDaehne/kabai-ui), but a standalone product with
its own database — no compatibility with kabai required.

**Status:** early development. Nothing usable yet.

## Architecture (short)

- One SvelteKit app (TypeScript, Svelte 5, `adapter-node`) = web server +
  orchestrator + runner in a single process.
- Own SQLite database (single file, WAL) via `node:sqlite`, stored in `./data`
  (override with `STUDIO_DATA_DIR`); migrations in `migrations/` run on startup.
- Secrets (API keys, tokens) are entered in the UI and stored AES-256-GCM
  encrypted. The key is `secret.key` in the data directory, created on first
  start — back it up separately from the database — or `STUDIO_SECRET_KEY`
  (base64, 32 bytes, e.g. `openssl rand -base64 32`).
- Backups: daily and before every migration into `<data>/backups/studio-YYYYMMDD-HHMM.db`
  (UTC); 7 daily + 4 weekly are kept. Status under Settings. Backups hold secrets
  only encrypted — `secret.key` is not included.
- PWA as the only client (Linux, macOS, mobile) — agents never run in the client.
- Agents run hybrid: coding agents (opencode, Claude Code, Codex, …) via the
  [Agent Client Protocol](https://agentclientprotocol.com), lightweight tasks via
  a built-in tool loop (Vercel AI SDK). Agents reach studio data through a
  built-in MCP endpoint with a per-run token.
- Code projects: one git worktree per ticket, risky actions need approval.

## Development

Requires Nix (or Node ≥ 24).

```sh
nix develop            # or: direnv allow
npm install
npm run dev            # dev server
npm run check          # svelte-check / TypeScript
npm test               # vitest
npm run build && ORIGIN=http://127.0.0.1:3000 node build   # production build on http://127.0.0.1:3000
npm run reset-password # recovery: set a new owner password, ends all sessions
npm run restore -- data/backups/studio-20260101-0300.db   # stop the server first; saves the current DB, then restores
```

On first start the server prints a one-time setup link; open it to create the owner
account. Open studio at exactly the address given in `ORIGIN` — form posts from any
other address are rejected.

## License

[AGPL-3.0](LICENSE) with an additional attribution term (GPLv3 §7(b), permitted
by the AGPL): forks and modified versions must keep a visible attribution to
this original project, in the source and in the running app.
