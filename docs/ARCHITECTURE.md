# Architecture

This document describes the high-level architecture of Relay IDE.
If you want to familiarize yourself with the codebase, you are in the right place.

## Bird's Eye View

Relay IDE is a remote web interface for interacting with Claude Code CLI sessions from any device. A user opens the web UI in a browser, authenticates with a PIN, and gets a terminal connected to a tmux-backed CLI process running on the host machine. The server manages tmux-backed PTY sessions, relays I/O over WebSocket, and watches for git worktree changes.

Input: browser keystrokes, session management commands, clipboard images.
Output: terminal rendering via xterm.js, real-time session state updates.

The system has two compilation targets: a TypeScript + ESM backend (Express + node-pty + tmux + WebSocket) compiled to `dist/`, and a React 19 frontend (Zustand + TanStack Query + Vite) compiled to `dist/frontend/`.

## Code Map

### `server/`

59 TypeScript modules (including `adapters/`, `output-parsers/`, and `protocol-adapters/` subdirectories) compiled to `dist/server/` via `tsc`. Modules communicate via ESM `import` statements.

| Module                                  | Role                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`                              | Composition root: Express app, REST routes, auth middleware, static serving                                                                                                                                                                                        |
| `workspaces.ts`                         | Repo CRUD, Express Router: dashboard, settings, CI status, branch switch, path autocomplete                                                                                                                                                                        |
| `workspace-groups.ts`                   | Workspace grouping entity CRUD: Express Router at `/workspace-groups` for create/read/update/delete/reorder workspace entities                                                                                                                                     |
| `sessions.ts`                           | Session registry: routes `create()` to pty-handler, lifecycle ops, restore/reattach, idle sweep                                                                                                                                                                    |
| `pty-handler.ts`                        | PTY session creation via node-pty attached to tmux, scrollback buffering (256KB), tmux session naming, continue-retry                                                                                                                                              |
| `git.ts`                                | Git/GitHub CLI integration: branches, activity feed, CI status, PR lookup, branch switch, branch lifecycle state computation (`ensureBranchLocal`, `isPrMerged`, `computeBranchLifecycleState`); exports `extractOwnerRepo` and `buildRepoMap` for webhook-manager |
| `ws.ts`                                 | WebSocket upgrade handler: binary relay for PTY I/O + resize JSON, event broadcast channel                                                                                                                                                                         |
| `utils.ts`                              | Shared server utilities                                                                                                                                                                                                                                            |
| `watcher.ts`                            | File system watching: WorktreeWatcher (workspace dirs), BranchWatcher (.git/HEAD), RefWatcher (upstream tracking refs for PR auto-refresh), GitWatcher (.git/ dirs for changed-files events with `changedFiles: string[]` from `git status`)                       |
| `auth.ts`                               | PIN hashing (scrypt), rate limiting (5 fails = 15-min lockout), cookie tokens                                                                                                                                                                                      |
| `config.ts`                             | Config loading/saving with defaults, v3→v4 migration (configVersion, repoSettings, workspace promotion), per-repo settings, worktree metadata, settings cascade (global→workspace→repo→session)                                                                    |
| `clipboard.ts`                          | System clipboard detection and image-set operations (osascript/xclip)                                                                                                                                                                                              |
| `service.ts`                            | Background service install/uninstall/status (launchd on macOS, systemd on Linux)                                                                                                                                                                                   |
| `push.ts`                               | Web Push notification management (VAPID keys, subscription registry, SDK event enrichment)                                                                                                                                                                         |
| `hooks.ts`                              | Claude Code hook HTTP endpoints: state detection (Stop, Notification, UserPromptSubmit), activity tracking (PreToolUse, PostToolUse), session cleanup (SessionEnd), and branch rename. Localhost-only with per-session token auth.                                 |
| `types.ts`                              | Shared TypeScript interfaces (Session, Repo, Workspace entity, Config v4, WorkspaceLevelSettings, PR, CI, Activity types)                                                                                                                                          |
| `analytics.ts`                          | Local analytics: SQLite-backed event tracking, `trackEvent()`, batch ingest endpoint, DB size/clear endpoints                                                                                                                                                      |
| `port-allocator.ts`                     | Durable per-worktree port allocation, persisted assignments, `.env` managed-block reconciliation, and startup verification of allocated ports                                                                                                                      |
| `review-poller.ts`                      | PR review automation: polls GitHub notifications for review requests, creates worktrees, optionally starts review sessions                                                                                                                                         |
| `output-parsers/`                       | Vendor-extensible terminal output parsing for semantic agent state detection (AgentState), keyed by AgentType. Contains `index.ts` (registry + dispatch), `claude-parser.ts`, `codex-parser.ts`                                                                    |
| `github-app.ts`                         | GitHub OAuth App flow: authorization URL generation (with CSRF state), token exchange callback, connection status, disconnect                                                                                                                                      |
| `github-graphql.ts`                     | GitHub GraphQL client: PR search query, response mapping (PRs → PullRequest[]), fetchPrsGraphQL()                                                                                                                                                                  |
| `webhooks.ts`                           | GitHub webhook receiver: HMAC signature verification, event routing, broadcast to frontend                                                                                                                                                                         |
| `webhook-manager.ts`                    | GitHub webhook CRUD, smee client lifecycle, health state, auto-provision backfill, smart polling fallback (30s interval, batched broadcasts for repos without webhooks)                                                                                            |
| `branch-linker.ts`                      | Maps ticket IDs (Jira-style and GH-NNN) extracted from branch names to workspace repos; 60s cache; Express Router at `/branch-linker/links`; exports `invalidateBranchLinkerCache()`                                                                               |
| `integration-github.ts`                 | GitHub Issues integration: fetches open issues assigned to `@me` across all workspaces via `gh` CLI; per-repo 60s cache; Express Router at `/integrations/github/issues`                                                                                           |
| `integration-jira.ts`                   | Jira integration via `acli`: fetches open issues assigned to current user, fetches project statuses; 60s cache; Express Router at `/integrations/jira/issues` and `/integrations/jira/statuses`                                                                    |
| `org-dashboard.ts`                      | Org-wide PR dashboard: aggregates open PRs involving the current user across all workspaces via `gh` search API or GraphQL fallback; triggers ticket transitions on PR state changes; 60s cache                                                                    |
| `ticket-transitions.ts`                 | Automated ticket state machine: transitions GitHub Issues (labels) and Jira tickets (acli) through in-progress → code-review → ready-for-qa based on session creation and PR merge events                                                                          |
| `agent-events.ts`                       | Canonical agent event schema and thin adapter: normalizes lifecycle events (session, tool, permission, telemetry) across agent frameworks into a unified `AgentEvent` type                                                                                         |
| `browser-content.ts`                    | Serves per-file browser content with scoped Bearer token + per-file token gating and realpath-based path-traversal protection                                                                                                                                      |
| `codex-hooks-adapter.ts`                | Adapter that maps Codex CLI hook payloads into the unified hook/agent-event pipeline                                                                                                                                                                               |
| `gh.ts` / `gh-routes.ts`                | `gh` CLI helpers and Express Router exposing `gh`-backed endpoints (repo/branch lookups, workflow runs)                                                                                                                                                            |
| `git-routes.ts`                         | Express Router for git operations that don't live on workspaces (branch lifecycle, PR lookups, branch switches) — delegates to `git.ts`                                                                                                                            |
| `logger.ts`                             | `createLogger(name)` factory; pino-backed, used uniformly across server modules (zero raw `console.*` in production)                                                                                                                                               |
| `opencode-relay.ts`                     | OpenCode agent transport relay: WebSocket/SSE proxy that bridges web sessions to the OpenCode CLI                                                                                                                                                                  |
| `protocol-adapter.ts`                   | Abstract `ProtocolAdapter` base class; concrete adapters live in `protocol-adapters/{claude,codex,opencode,hermes,mock}.ts`                                                                                                                                               |
| `telemetry.ts` / `telemetry-adapter.ts` | Framework-neutral telemetry bus + abstract adapter; concrete adapters in `adapters/{claude,codex,opencode}-telemetry.ts` self-register at import time                                                                                                              |
| `web-session-handler.ts`                | Request/response handler for web-chat sessions (non-PTY): creation, input delivery, event streaming via `ChatEvent`                                                                                                                                                |
| `sandbox.ts`                            | Spawns isolated relay-ide server instances with ephemeral config, dynamic port allocation, and readiness polling for agent-driven testing                                                                                                                          |
| `agent-browser.ts`                      | Playwright-based browser automation for agents: launches Chromium, captures screenshots, validates pages via console-error collection (`launchBrowser`, `screenshot`, `validatePage`, `closeBrowser`)                                                               |

### `shared/`

Compiled by both `tsconfig.json` (server build) and `frontend/tsconfig.json` (Vite); modules here are the only place where server and frontend are allowed to share source.

| Module                     | Role                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-events.ts`           | `ChatEvent` discriminated union and type guards — the wire protocol for web-chat transcripts                                                         |
| `mobile-input-pipeline.ts` | Pure-function event-intent pipeline for mobile virtual keyboard input — consumed by the React `MobileInput` component; unit-tested via JSON fixtures |

**Architecture Invariant:** `index.ts` is the composition root and MUST NOT be imported by other modules. Cross-module dependencies flow downward: `index.ts` imports all others; `ws.ts` may import `sessions`; `sessions.ts` imports `pty-handler`; `workspaces.ts` imports `git` and `config`; `hooks.ts` receives `sessions`, `git`, `config`, `analytics`, `telemetry`, and `push` via a `HookDeps` injection seam (composition root wires them; `hooks.ts` does statically import those modules to type the deps but does not invoke them directly from module scope); all other modules are self-contained. **Exception:** `analytics.ts`, `push.ts`, and `logger.ts` are pure output dependencies (fire-and-forget) imported by multiple modules — this is acceptable because they have no effect on callers' control flow. Each module owns a single concern and confines its npm dependencies (e.g., only `auth.ts` depends on crypto.scrypt, only `pty-handler.ts` depends on node-pty, only `analytics.ts` depends on better-sqlite3, only `push.ts` depends on web-push). The `output-parsers/` module confines all output-parsing logic and may depend on `types.ts` only — it MUST NOT import from `utils.ts` or any other server module. There are currently 58 server modules, including modules in the `adapters/`, `output-parsers/`, and `protocol-adapters/` subdirectories.

### `frontend/`

React 19 SPA built by Vite, output to `dist/frontend/`. Express serves the compiled output.

| Path                                  | Role                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/src/components/`            | React 19 TSX components (Terminal, Sidebar, RepoItem, PrTopBar, SessionTabBar, RepoDashboard, CommandPalette, dialogs, etc.)                                                                |
| `frontend/src/lib/state/`             | Pure logic modules (`display-state.ts` — 6-state display state machine, `sidebar-items.ts` — unified SidebarItem construction with reconciliation, `attention.ts` — state priority scoring) |
| `frontend/src/hooks/`                 | React hooks for state and side effects (`useEventSocket`, `useSessionHandlers`, `useActionRegistry`, `useRepoAggregation`, etc.)                                                            |
| `frontend/src/lib/api.ts`             | REST API client functions                                                                                                                                                                   |
| `frontend/src/lib/ws.ts`              | WebSocket connection management (PTY relay + event channel)                                                                                                                                 |
| `frontend/src/lib/types.ts`           | Frontend TypeScript interfaces                                                                                                                                                              |
| `frontend/src/lib/actions/`           | Command center action registry: types, pure registry logic (`registry.ts`), reactive hook wrapper, and co-located action definitions in `definitions/`                                      |
| `frontend/src/lib/notifications.ts`   | Browser Notification API wrapper, service worker registration, Web Push subscription                                                                                                        |
| `frontend/src/lib/utils.ts`           | Shared utilities (path display, relative time formatting, device detection)                                                                                                                 |
| `frontend/src/lib/pr-state.ts`        | PR lifecycle state machine: derives action from PR state + CI + mergeable + unresolved comments                                                                                             |
| `frontend/src/lib/file-tree-utils.ts` | Pure file tree functions: `buildChangedFilesTree`, `flattenVisibleNodes`, `findMostRecentlyChanged`, `parseLineReference`, status badge helpers                                             |
| `frontend/src/lib/analytics.ts`       | Frontend analytics: batch event collection, `data-track` attribute integration                                                                                                              |

**Architecture Invariant:** The frontend does NOT vendor any libraries. xterm.js, xterm-addon-fit, `react`, `zustand`, and `@tanstack/react-query` are npm dependencies. State lives in Zustand stores and React hooks, not in component files (PR data is an exception — managed via TanStack Query cache).

### `bin/`

`bin/relay-ide.ts` — CLI entry point. Parses flags (`--port`, `--host`, `--config`, `--version`, `--help`, `--bg`, `install`, `uninstall`, `status`, `update`), manages config directory, prompts for PIN on first run.

**Architecture Invariant:** CLI flags are passed to the server via environment variables (`RELAY_IDE_CONFIG`, `RELAY_IDE_PORT`, `RELAY_IDE_HOST`), not direct function calls.

### `test/`

Unit/integration tests use `vitest` (migrated from `node:test` on 2026-04-03). TypeScript source is consumed directly via `vite-node` (no `tsc -p tsconfig.test.json` step). E2E tests live under `test/e2e/**/*.spec.ts` and run separately via `playwright.config.ts`.

**Architecture Invariant:** Single unit/integration test runner (`vitest`). Unit/integration tests MUST NOT require a running server instance.

## Data Flow

**PTY relay:**

```
Browser (xterm.js) <--WebSocket /ws/:id--> ws.ts <--PTY I/O--> node-pty <--attaches/spawns--> tmux session <--runs--> agent CLI / shell
                                              |
                                         scrollback buffer (in-memory, per session)
```

**Event channel:**

```
Browser (React)    <--WebSocket /ws/events-- ws.ts <-- watcher.ts (fs.watch on .worktrees/)
                                                    <-- POST/DELETE /roots (manual broadcast)
```

PTY flow:

1. User types in xterm.js terminal
2. Keystrokes sent via WebSocket to server
3. Server writes to PTY stdin
4. PTY stdout/stderr relayed back over WebSocket
5. xterm.js renders output in browser
6. Resize events sent as JSON: `{type: 'resize', cols, rows}`

## Tmux Substrate

xterm.js remains the browser renderer. tmux is the required server-side session and process substrate for interactive agent and terminal sessions. `node-pty` is the adapter between the WebSocket relay and tmux; it is not the durable owner of the agent process tree.

Tmux session names are stable and human-readable:

```
<prefix><sanitized repo-or-repo-branch slug>-<first 8 chars of session id>
```

- Production sessions use the `relay-ide-` prefix.
- Dev mode sessions (`NO_PIN=1`) use the `relay-dev-` prefix.
- The slug is sanitized to alphanumeric/hyphen characters and capped before the session id suffix.
- Restore paths preserve the original session id and tmux session name so browser tabs can reconnect to the same server-side process after a server restart.
- On startup, the server checks whether the named tmux session still exists. If it does, Relay reattaches with `tmux -u attach-session -t <name>`. If it does not, agent sessions fall back to agent-specific continue args and create a fresh tmux-backed process.
- `sessions.ts` exposes targeted tmux helpers (`sendTmuxKeys`, `sendTmuxText`, `captureTmuxPane`) so future workspace panes can address a specific tmux-backed process by session id instead of relying only on the currently attached PTY stream.

This makes workspace, tab, and pane customization (#263) viable without losing process ownership. Browser-level tabs and panes can be rearranged freely while the underlying tmux session remains the stable process identity for reconnect, restore, resize, copy-mode, and cleanup.

## REST API

| Method   | Path                            | Description                                                                                                                           |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/auth`                         | Authenticate with PIN, returns session cookie                                                                                         |
| `GET`    | `/sessions`                     | List active sessions                                                                                                                  |
| `POST`   | `/sessions`                     | Create session (agent or terminal, in workspace root or worktree)                                                                     |
| `PATCH`  | `/sessions/:id`                 | Rename session                                                                                                                        |
| `DELETE` | `/sessions/:id`                 | Terminate session                                                                                                                     |
| `POST`   | `/sessions/:id/image`           | Upload clipboard image                                                                                                                |
| `GET`    | `/branches`                     | List local and remote branches                                                                                                        |
| `GET`    | `/worktrees`                    | List inactive Claude Code worktrees                                                                                                   |
| `DELETE` | `/worktrees`                    | Remove worktree, prune refs, delete branch                                                                                            |
| `GET`    | `/workspaces`                   | List configured workspace folders with git info                                                                                       |
| `POST`   | `/workspaces`                   | Add workspace folder (body: `{path}`)                                                                                                 |
| `DELETE` | `/workspaces`                   | Remove workspace folder                                                                                                               |
| `GET`    | `/workspaces/dashboard`         | Aggregated PRs + activity for a workspace (`?path=X`)                                                                                 |
| `GET`    | `/workspaces/settings`          | Per-workspace settings (`?path=X`)                                                                                                    |
| `PATCH`  | `/workspaces/settings`          | Update per-workspace settings                                                                                                         |
| `GET`    | `/workspaces/pr`                | PR info for a branch (`?path=X&branch=Y`)                                                                                             |
| `GET`    | `/workspaces/ci-status`         | CI check results (`?path=X&branch=Y`)                                                                                                 |
| `POST`   | `/workspaces/branch`            | Switch branch (`?path=X`, body: `{branch}`)                                                                                           |
| `GET`    | `/workspaces/browse`            | Browse filesystem directories (and files with `includeFiles=true`) for tree UI (`?path=X&prefix=Y&showHidden=bool&includeFiles=bool`) |
| `POST`   | `/workspaces/bulk`              | Add multiple workspace paths at once (body: `{paths}`)                                                                                |
| `GET`    | `/workspaces/autocomplete`      | Path prefix autocomplete (`?prefix=X`)                                                                                                |
| `POST`   | `/workspaces/worktree`          | Create worktree with mountain name (`?path=X`)                                                                                        |
| `GET`    | `/workspaces/current-branch`    | Current checked-out branch (`?path=X`)                                                                                                |
| `GET`    | `/version`                      | Check for npm updates                                                                                                                 |
| `POST`   | `/update`                       | Self-update via npm                                                                                                                   |
| `GET`    | `/config/defaultAgent`          | Get default coding agent                                                                                                              |
| `PATCH`  | `/config/defaultAgent`          | Set default coding agent (`claude` or `codex`)                                                                                        |
| `POST`   | `/hooks/stop`                   | Hook callback: set session state to idle (localhost-only, per-session token auth)                                                     |
| `POST`   | `/hooks/notification`           | Hook callback: permission-prompt or waiting-for-input state (localhost-only, per-session token auth)                                  |
| `POST`   | `/hooks/prompt-submit`          | Hook callback: set processing state, trigger branch rename on first message (localhost-only, per-session token auth)                  |
| `POST`   | `/hooks/session-end`            | Hook callback: session cleanup dedup (localhost-only, per-session token auth)                                                         |
| `POST`   | `/hooks/tool-use`               | Hook callback: set currentActivity (tool name + detail) (localhost-only, per-session token auth)                                      |
| `POST`   | `/hooks/tool-result`            | Hook callback: clear currentActivity (localhost-only, per-session token auth)                                                         |
| `POST`   | `/webhooks/manage/setup`        | Create GitHub webhook + start smee client for current workspace (`?path=X`)                                                           |
| `DELETE` | `/webhooks/manage/setup`        | Delete GitHub webhook and stop smee client (`?path=X`)                                                                                |
| `GET`    | `/webhooks/manage/status`       | Webhook health state (smee connected, last event timestamp)                                                                           |
| `POST`   | `/webhooks/manage/reload`       | Reload smee client from saved config                                                                                                  |
| `POST`   | `/webhooks/manage/ping`         | Send test ping to smee channel                                                                                                        |
| `POST`   | `/webhooks/manage/repos`        | Add a repo to the webhook-managed set (body: `{path}`)                                                                                |
| `POST`   | `/webhooks/manage/repos/remove` | Remove a repo from the webhook-managed set (body: `{path}`)                                                                           |
| `POST`   | `/webhooks/manage/backfill`     | Auto-provision webhooks for all repos that don't have one                                                                             |
| `GET`    | `/workspaces/changed-files`     | List changed files in a repo (`?path=X&base=ref`)                                                                                     |
| `GET`    | `/workspaces/file-diff`         | Get unified diff for a single file (`?path=X&file=Y&base=ref`)                                                                        |

## WebSocket Channels

- `/ws/:sessionId` — PTY session relay: raw binary terminal I/O + resize JSON. Close code 1000 = PTY exited.
- `/ws/events` — Server-to-client broadcast (`worktrees-changed`, `session-idle-changed`, `files-changed` with `changedFiles: string[]`).

Both channels require authentication via `token` cookie verified during HTTP upgrade.

## Cross-Cutting Concerns

**Build:** TypeScript compiles via `tsc` to `dist/`. Frontend builds via Vite to `dist/frontend/`. ESM throughout (`"type": "module"`), all relative imports use `.js` extensions, Node builtins use `node:` prefix.

**Auth:** Every HTTP request (except `/auth` POST) and every WebSocket upgrade requires a valid session cookie. Rate limiting is per-IP.

**Session lifecycle:** Runtime session records are in-memory during normal operation, while tmux owns the durable process tree. Multiple sessions per directory are allowed (multi-tab support). PTY exit triggers automatic cleanup. Scrollback buffers cap at 256KB with FIFO eviction. PTY spawns are wrapped with `trap '' PIPE; exec` to prevent SIGPIPE from killing sessions. During auto-updates, sessions are serialized to disk (`pending-sessions.json` + scrollback files) and restored on restart by reattaching to the preserved tmux name when possible.

---

## Architecture Decision Records

> Normative constraints are summarized in the table below. The underlying ADR markdown files referenced here (`docs/adrs/`) were never committed to the repository — the table is authoritative. Regenerate with `/adr:update`.

| ADR     | Topic                                                                          |
| ------- | ------------------------------------------------------------------------------ |
| ADR-001 | Modular server architecture (composition root, dependency flow) |
| ADR-003 | PTY session management (tmux substrate, in-memory state, scrollback, CLAUDECODE stripping) |
| ADR-004 | PIN authentication (scrypt, cookie tokens, rate limiting)                      |
| ADR-005 | Vitest as unit/integration test runner (migrated from node:test 2026-04-03)    |
| ADR-006 | Dual distribution (npm global + local dev, CLI flags via env vars)             |
| ADR-007 | WebSocket dual channels (PTY relay + event broadcast, debounced watcher)       |
| ADR-008 | TypeScript + ESM (strict mode, .js extensions, node: prefix, Node >= 24)       |

> ADR-002 (vanilla JS frontend) was superseded by the Svelte 5 migration, which was subsequently superseded by the React 19 migration. `hooks.ts` does not yet have a dedicated ADR.
