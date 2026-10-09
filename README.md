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
- Own SQLite database (single file, WAL) via `node:sqlite`, stored in the OS-conventional
  per-user data directory (`$XDG_DATA_HOME` or `~/.local/share/kabai-studio` on Linux,
  `~/Library/Application Support/kabai-studio` on macOS; override with `STUDIO_DATA_DIR`);
  migrations in `migrations/` run on startup.
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
npm run build && npm run test:browser   # key flows in headless Chromium (without Nix: npx playwright install --no-shell chromium first)
npm run reset-password # recovery: set a new owner password, ends all sessions
npm run restore -- data/backups/studio-20260101-0300.db   # stop the server first; saves the current DB, then restores
```

## Start

`node server.ts` (after `npm run build`, or directly from a released binary) is the
`kabai-studio` CLI — zero config: it picks the OS-default data directory above, binds
127.0.0.1 only, and prints the URL once it's listening. If the port is taken it falls
back to the next free one and says so.

```sh
node server.ts                      # same as "start": http://127.0.0.1:3000 (or the next free port)
node server.ts service install      # Linux: a systemd user unit; macOS: a launchd agent — user scope, nothing system-wide
node server.ts service install --print   # print the unit/agent file instead of installing it
node server.ts service status       # one line: running or not, and the next step if not
node server.ts service uninstall
node server.ts reset-password       # same as npm run reset-password
node server.ts restore <backup-file>   # same as npm run restore --
node server.ts --version
```

On Linux, autostart without an active login session needs
`loginctl enable-linger $(whoami)` once (`service install` prints a reminder). Every
error (no free port, an unknown command, a missing systemd/launchd, no permission to
write the unit file) exits non-zero with a one-line, plain-text way out.

On first start the server prints a one-time setup link; open it to create the owner
account. Open studio at exactly the address given in `ORIGIN` — form posts from any
other address are rejected.

## Container

A container image is published to `ghcr.io/derdaehne/kabai-studio` on every tagged
release (and manually via the "Container image" workflow). It runs the same server
as `node server.ts` above, as a non-root user, with the data directory as a volume.

Inside the image, `HOST` defaults to `0.0.0.0` — safe by itself, because the
container's own network namespace is already the boundary; what actually controls
reachability from the host is the publish address. Two ways to run it:

```sh
# Bridge network (default): the safe default publishes only to the host's own
# loopback — expose further only deliberately (e.g. -p 0.0.0.0:3000:3000).
docker run -d --name kabai-studio \
  -e ORIGIN=http://127.0.0.1:3000 \
  -p 127.0.0.1:3000:3000 \
  -v kabai-studio-data:/data \
  ghcr.io/derdaehne/kabai-studio:latest

# Host network: the container shares the host's network namespace directly, so
# the image default (0.0.0.0) would bind on every host interface — override it
# back to loopback-only and skip -p.
docker run -d --name kabai-studio --network host \
  -e HOST=127.0.0.1 -e ORIGIN=http://127.0.0.1:3000 \
  -v kabai-studio-data:/data \
  ghcr.io/derdaehne/kabai-studio:latest
```

On first start, the one-time setup link is in the container's logs
(`docker logs kabai-studio`) — open it the same way as above to create the owner
account.

**Update:** pull the new image, then recreate the container on the same volume. The
owner, secrets and data survive (a backup also runs automatically before any
migration, see above):

```sh
docker pull ghcr.io/derdaehne/kabai-studio:latest
docker stop kabai-studio && docker rm kabai-studio
docker run …   # same command as above, same -v kabai-studio-data:/data
```

## Local models

Recommendations and parameters for local models (llama.cpp, LM Studio, Ollama,
llama-swap or any other OpenAI-compatible server), meant to drive model
recognition and default profile settings once those consumers land. Generated
from `src/lib/agents/model-catalog.ts` — edit the catalog, then run
`npm run docs:models`.

<!-- prettier-ignore-start -->
<!-- BEGIN GENERATED: model-catalog -->
| Model | Recommended for | Thinking | Min. context | Known pitfalls |
|---|---|---|---|---|
| `ornith-1.5-35b` | refine, code | on (chat_template_kwargs) | 32k | without thinking enabled it often asks a clarifying question before doing any work → enable thinking; with a small token budget (around 12k) thinking consumes it all and no answer is produced → raise max_tokens to at least 32000, or disable thinking; the model's own test expectations are sometimes wrong → always verify test results independently |
| `qwen3.6-35b` | code, tour | configurable (chat_template_kwargs) | 128k | never asks clarifying questions; open product decisions are silently skipped → have a reviewer check for skipped decisions, or use it only for tasks without open decisions; the model's own test expectations are sometimes wrong → always verify test results independently |
| `qwen3-coder-next` | tour (acceptable) | off (fixed) | 32k | weaker code quality in evaluation runs, and splits tasks too finely → raise the tool-loop step limit, or prefer another model for code tickets |
| `gpt-oss-20b` | code (acceptable) | on (fixed) | 32k | weak refinement quality and mixes languages in its output → use only for small, well-scoped auxiliary tasks, not for refine or review |
| `qwen3.8-27b` | — | configurable (chat_template_kwargs) | — | too slow once it no longer fits fully in VRAM (dense model, no MoE expert offloading) → prefer an MoE model of similar size, e.g. ornith-1.5-35b or qwen3.6-35b |
<!-- END GENERATED: model-catalog -->
<!-- prettier-ignore-end -->

## License

[AGPL-3.0](LICENSE) with an additional attribution term (GPLv3 §7(b), permitted
by the AGPL): forks and modified versions must keep a visible attribution to
this original project, in the source and in the running app.
