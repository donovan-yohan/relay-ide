# backend-core

Composition root, auth, config, PTY sessions, WebSocket relay, CLI, sandbox, service install.

## Scope

- `server/index.ts` — Express composition root; wires all routers, starts HTTP + WS + watchers
- `server/auth.ts` — scrypt PIN hashing, per-IP rate limiter (5 attempts, 15-min lockout), cookie tokens
- `server/config.ts` — `loadConfig`/`saveConfig`, `DEFAULTS`, `readMeta`/`writeMeta`, v3→v4 migration, `resolveSessionSettings` cascade
- `server/sessions.ts` — Session registry, `createSession` dispatch (pty vs web), serialize/restore to `pending-sessions.json`, idle sweep
- `server/pty-handler.ts` — `createPtySession`, `node-pty` spawn, tmux wrapping (`relay-ide-`/`relay-dev-` prefix), 256 KB scrollback FIFO, continue-retry
- `server/ws.ts` — HTTP upgrade handler; `/ws/:sessionId` binary PTY relay + resize JSON; `/ws/events` broadcast channel; auth via `token` cookie
- `server/sandbox.ts` — spawns isolated relay-ide instances with ephemeral config + dynamic ports for agent-driven testing
- `server/service.ts` — launchd/systemd install/uninstall/status; `isGlobalInstall()` detects worktree vs global bin
- `server/port-allocator.ts` — durable per-worktree port allocation (10000–11999), `.env` managed-block reconciliation, startup verification
- `server/analytics.ts` — SQLite event store (`better-sqlite3`), batched ingest, engagement metrics, retention cleanup
- `server/push.ts` — Web Push: VAPID keys, subscription registry, SDK event enrichment
- `server/clipboard.ts` — `osascript`/`xclip` image-set, clipboard detection
- `server/logger.ts` — `createLogger(name)` pino factory (no raw `console.*` in production)
- `server/utils.ts` — `cleanEnv` (strips `CLAUDECODE` so nested Claude sessions work), path helpers
- `server/types.ts` — `Session`, `Config`, `AgentType`, `PtySession`, `WebSession`, `FilterPreset`, `WorktreeMetadata` shared interfaces
- `bin/relay-ide.ts` — CLI entry; parses `--port`/`--host`/`--config`/`--bg`/`install`/`uninstall`/`status`/`update`
- `scripts/agent-browser-cli.ts` — CLI wrapper around `server/agent-browser.ts`
- `scripts/sandbox-cli.ts` — CLI wrapper around `server/sandbox.ts`

## Key Decisions

- **Composition root invariant** — `server/index.ts` imports every other module; nothing imports `index.ts`. `hooks.ts` receives `sessions`/`git`/`config`/`analytics`/`telemetry`/`push` via a `HookDeps` injection seam so it type-references but never calls those modules at module scope (see `docs/ARCHITECTURE.md` line 74).
- **Output-sink exception** — `analytics.ts`, `push.ts`, and `logger.ts` are fire-and-forget output deps imported freely by anyone. They have no effect on caller control flow.
- **In-memory session state + disk serialization for updates only** — Sessions live in-memory during normal operation. `serializeAll`/`restoreFromDisk` snapshot to `pending-sessions.json` + scrollback files only across auto-update restarts (ADR-003).
- **PTY wrapping** — spawns are wrapped with `trap '' PIPE; exec` so SIGPIPE cannot kill the shell. `CLAUDECODE` env var is stripped via `cleanEnv()` so Claude sessions can nest. Scrollback capped at 256 KB with FIFO eviction.
- **tmux optional** — `getTmuxPrefix()` returns `relay-dev-` when `NO_PIN=1`, else `relay-ide-`. tmux wrapping enables clipboard passthrough, vi copy-mode, and session restore across reconnects.
- **Auth** — scrypt-only (legacy bcrypt hashes rejected at verify time). Per-IP rate limit map is in-memory, reset on restart. `_resetForTesting()` exported for `test/auth.test.ts`.
- **Port allocator** — primary range 10000–10999, overflow 11000–11999. Allocations persisted to `port-assignments.json`. `.env` blocks delimited by explicit `# --- relay-ide managed ports ---` markers so user content is preserved.
- **CLI ↔ server boundary** — `bin/relay-ide.ts` communicates with the server via environment variables (`RELAY_IDE_CONFIG`, `RELAY_IDE_PORT`, `RELAY_IDE_HOST`), never direct function calls (ADR-006).

## Conventions

- All relative imports use `.js` extensions; Node builtins use `node:` prefix (ADR-008).
- Every module creates its logger via `createLogger('name')` — no `console.log` / `console.error` in committed code.
- PTY-owning code (`pty-handler.ts`) is the only module that may import `node-pty`. `auth.ts` is the only module that may use `crypto.scrypt`. `analytics.ts` is the only module that may import `better-sqlite3`. `push.ts` is the only module that may import `web-push` (see `docs/ARCHITECTURE.md` line 74).
- Express routers are created by factory functions (`createWorkspaceRouter`, `createHooksRouter`, etc.) and mounted in `index.ts`. Routers never read config directly — dependencies are injected as factory args.
- Test isolation: modules that keep in-memory state (`auth.ts`) expose `_resetForTesting()` rather than allowing tests to poke internals.
- WebSocket close code 1000 = PTY exited; any other code = transient and client should reconnect.
- Node >= 24.0.0 required (`engines` field); `.nvmrc` present.

<!-- octogent:suggested-skills:start -->

## Suggested Skills

You can use these skills if you need to.

- `investigate`
- `review`
- `codex`
- `qa`
<!-- octogent:suggested-skills:end -->
