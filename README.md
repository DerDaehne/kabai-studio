# kabai studio

[![CI](https://github.com/DerDaehne/kabai-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/DerDaehne/kabai-studio/actions/workflows/ci.yml)

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
npm run build && node build   # production build on http://localhost:3000
```

## License

[AGPL-3.0](LICENSE) with an additional attribution term (GPLv3 §7(b), permitted
by the AGPL): forks and modified versions must keep a visible attribution to
this original project, in the source and in the running app.
