# Architecture

This document describes the high-level architecture of claude-remote-cli.
If you want to familiarize yourself with the codebase, you are in the right place.

## Bird's Eye View

claude-remote-cli is a remote web interface for interacting with Claude Code CLI sessions from any device. A user opens the web UI in a browser, authenticates with a PIN, and gets a terminal connected to a Claude Code CLI process running on the host machine. The server manages PTY processes, relays I/O over WebSocket, and watches for git worktree changes.

Input: browser keystrokes, session management commands, clipboard images.
Output: terminal rendering via xterm.js, real-time session state updates.

The system has two compilation targets: a TypeScript + ESM backend (Express + node-pty + WebSocket) compiled to `dist/`, and a Svelte 5 frontend (runes + Vite) compiled to `dist/frontend/`.

## Code Map

### `server/`

Twenty-seven TypeScript modules compiled to `dist/server/` via `tsc`. Modules communicate via ESM `import` statements.

| Module | Role |
|--------|------|
| `index.ts` | Composition root: Express app, REST routes, auth middleware, static serving |
| `workspaces.ts` | Workspace CRUD (replaces roots), Express Router: dashboard, settings, CI status, branch switch, path autocomplete |
| `sessions.ts` | Session registry: routes `create()` to pty-handler, lifecycle ops, idle sweep |
| `pty-handler.ts` | PTY session creation via node-pty, scrollback buffering (256KB), tmux wrapping, continue-retry |
| `git.ts` | Git/GitHub CLI integration: branches, activity feed, CI status, PR lookup, branch switch; exports `extractOwnerRepo` and `buildRepoMap` for webhook-manager |
| `ws.ts` | WebSocket upgrade handler: binary relay for PTY I/O + resize JSON, event broadcast channel |
| `mobile-input-pipeline.ts` | Pure-function event-intent pipeline for mobile virtual keyboard input; unit-tested via JSON fixtures |
| `utils.ts` | Shared server utilities |
| `watcher.ts` | File system watching: WorktreeWatcher (workspace dirs), BranchWatcher (.git/HEAD), RefWatcher (upstream tracking refs for PR auto-refresh) |
| `auth.ts` | PIN hashing (scrypt), rate limiting (5 fails = 15-min lockout), cookie tokens |
| `config.ts` | Config loading/saving with defaults, per-workspace settings, worktree metadata |
| `clipboard.ts` | System clipboard detection and image-set operations (osascript/xclip) |
| `service.ts` | Background service install/uninstall/status (launchd on macOS, systemd on Linux) |
| `push.ts` | Web Push notification management (VAPID keys, subscription registry, SDK event enrichment) |
| `hooks.ts` | Claude Code hook HTTP endpoints: state detection (Stop, Notification, UserPromptSubmit), activity tracking (PreToolUse, PostToolUse), session cleanup (SessionEnd), and branch rename. Localhost-only with per-session token auth. |
| `types.ts` | Shared TypeScript interfaces (Session, Workspace, Config, PR, CI, Activity types) |
| `analytics.ts` | Local analytics: SQLite-backed event tracking, `trackEvent()`, batch ingest endpoint, DB size/clear endpoints |
| `review-poller.ts` | PR review automation: polls GitHub notifications for review requests, creates worktrees, optionally starts review sessions |
| `output-parsers/` | Vendor-extensible terminal output parsing for semantic agent state detection (AgentState), keyed by AgentType. Contains `index.ts` (registry + dispatch), `claude-parser.ts`, `codex-parser.ts` |
| `github-app.ts` | GitHub OAuth App flow: authorization URL generation (with CSRF state), token exchange callback, connection status, disconnect |
| `github-graphql.ts` | GitHub GraphQL client: PR search query, response mapping (PRs → PullRequest[]), fetchPrsGraphQL() |
| `webhooks.ts` | GitHub webhook receiver: HMAC signature verification, event routing, broadcast to frontend |
| `webhook-manager.ts` | GitHub webhook CRUD, smee client lifecycle, health state, auto-provision backfill, smart polling fallback (30s interval, batched broadcasts for repos without webhooks) |
| `branch-linker.ts` | Maps ticket IDs (Jira-style and GH-NNN) extracted from branch names to workspace repos; 60s cache; Express Router at `/branch-linker/links`; exports `invalidateBranchLinkerCache()` |
| `integration-github.ts` | GitHub Issues integration: fetches open issues assigned to `@me` across all workspaces via `gh` CLI; per-repo 60s cache; Express Router at `/integrations/github/issues` |
| `integration-jira.ts` | Jira integration via `acli`: fetches open issues assigned to current user, fetches project statuses; 60s cache; Express Router at `/integrations/jira/issues` and `/integrations/jira/statuses` |
| `org-dashboard.ts` | Org-wide PR dashboard: aggregates open PRs involving the current user across all workspaces via `gh` search API or GraphQL fallback; triggers ticket transitions on PR state changes; 60s cache |
| `ticket-transitions.ts` | Automated ticket state machine: transitions GitHub Issues (labels) and Jira tickets (acli) through in-progress → code-review → ready-for-qa based on session creation and PR merge events |

**Architecture Invariant:** `index.ts` is the composition root and MUST NOT be imported by other modules. Cross-module dependencies flow downward: `index.ts` imports all others; `ws.ts` may import `sessions`; `sessions.ts` imports `pty-handler`; `workspaces.ts` imports `git` and `config`; `hooks.ts` consumes `sessions`, `git`, `config`, and `push` via injected dependencies (not direct imports); all other modules are self-contained. **Exception:** `analytics.ts` and `push.ts` are pure output dependencies (fire-and-forget) imported by multiple modules — this is acceptable because they have no effect on callers' control flow. Each module owns a single concern and confines its npm dependencies (e.g., only `auth.ts` depends on crypto.scrypt, only `pty-handler.ts` depends on node-pty, only `analytics.ts` depends on better-sqlite3, only `push.ts` depends on web-push). The `output-parsers/` module confines all output-parsing logic and may depend on `types.ts` only — it MUST NOT import from `utils.ts` or any other server module. There are currently twenty-seven server modules.

### `frontend/`

Svelte 5 SPA built by Vite, output to `dist/frontend/`. Express serves the compiled output.

| Path | Role |
|------|------|
| `frontend/src/components/` | Svelte 5 components (Terminal, Sidebar, WorkspaceItem, PrTopBar, SessionTabBar, RepoDashboard, Spotlight, dialogs, etc.) |
| `frontend/src/lib/state/` | Reactive state modules (`.svelte.ts` files) exporting state + mutations; includes pure logic modules (`display-state.ts` — 6-state display state machine, `sidebar-items.ts` — unified SidebarItem construction with reconciliation) |
| `frontend/src/lib/api.ts` | REST API client functions |
| `frontend/src/lib/ws.ts` | WebSocket connection management (PTY relay + event channel) |
| `frontend/src/lib/types.ts` | Frontend TypeScript interfaces |
| `frontend/src/lib/actions.ts` | Shared Svelte actions (scroll-on-hover, longpress-click) |
| `frontend/src/lib/actions/` | Command center action registry: types, pure registry logic (`registry.ts`), reactive wrapper (`registry.svelte.ts`), and co-located action definitions in `definitions/` |
| `frontend/src/lib/notifications.ts` | Browser Notification API wrapper, service worker registration, Web Push subscription |
| `frontend/src/lib/utils.ts` | Shared utilities (path display, relative time formatting, device detection) |
| `frontend/src/lib/pr-state.ts` | PR lifecycle state machine: derives action from PR state + CI + mergeable + unresolved comments |
| `frontend/src/lib/analytics.ts` | Frontend analytics: batch event collection, `data-track` attribute integration |

**Architecture Invariant:** The frontend does NOT vendor any libraries. xterm.js, xterm-addon-fit, and `@tanstack/svelte-query` are npm dependencies. State lives in `.svelte.ts` modules, not in component files (PR data is an exception — managed via svelte-query cache).

### `bin/`

`bin/claude-remote-cli.ts` — CLI entry point. Parses flags (`--port`, `--host`, `--config`, `--version`, `--help`, `--bg`, `install`, `uninstall`, `status`, `update`), manages config directory, prompts for PIN on first run.

**Architecture Invariant:** CLI flags are passed to the server via environment variables (`CLAUDE_REMOTE_CONFIG`, `CLAUDE_REMOTE_PORT`, `CLAUDE_REMOTE_HOST`), not direct function calls.

### `test/`

Unit tests using `node:test` and `node:assert`. TypeScript source compiled via `tsc -p tsconfig.test.json`.

**Architecture Invariant:** No external test framework. Tests MUST NOT require a running server instance.

## Data Flow

**PTY relay:**
```
Browser (xterm.js) <--WebSocket /ws/:id--> ws.ts <--PTY I/O--> node-pty <--spawns--> agent CLI / shell
                                              |
                                         scrollback buffer (in-memory, per session)
```

**Event channel:**
```
Browser (Svelte)   <--WebSocket /ws/events-- ws.ts <-- watcher.ts (fs.watch on .worktrees/)
                                                    <-- POST/DELETE /roots (manual broadcast)
```

PTY flow:
1. User types in xterm.js terminal
2. Keystrokes sent via WebSocket to server
3. Server writes to PTY stdin
4. PTY stdout/stderr relayed back over WebSocket
5. xterm.js renders output in browser
6. Resize events sent as JSON: `{type: 'resize', cols, rows}`

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth` | Authenticate with PIN, returns session cookie |
| `GET` | `/sessions` | List active sessions |
| `POST` | `/sessions` | Create session (agent or terminal, in workspace root or worktree) |
| `PATCH` | `/sessions/:id` | Rename session |
| `DELETE` | `/sessions/:id` | Terminate session |
| `POST` | `/sessions/:id/image` | Upload clipboard image |
| `GET` | `/branches` | List local and remote branches |
| `GET` | `/worktrees` | List inactive Claude Code worktrees |
| `DELETE` | `/worktrees` | Remove worktree, prune refs, delete branch |
| `GET` | `/workspaces` | List configured workspace folders with git info |
| `POST` | `/workspaces` | Add workspace folder (body: `{path}`) |
| `DELETE` | `/workspaces` | Remove workspace folder |
| `GET` | `/workspaces/dashboard` | Aggregated PRs + activity for a workspace (`?path=X`) |
| `GET` | `/workspaces/settings` | Per-workspace settings (`?path=X`) |
| `PATCH` | `/workspaces/settings` | Update per-workspace settings |
| `GET` | `/workspaces/pr` | PR info for a branch (`?path=X&branch=Y`) |
| `GET` | `/workspaces/ci-status` | CI check results (`?path=X&branch=Y`) |
| `POST` | `/workspaces/branch` | Switch branch (`?path=X`, body: `{branch}`) |
| `GET` | `/workspaces/browse` | Browse filesystem directories for tree UI (`?path=X&prefix=Y&showHidden=bool`) |
| `POST` | `/workspaces/bulk` | Add multiple workspace paths at once (body: `{paths}`) |
| `GET` | `/workspaces/autocomplete` | Path prefix autocomplete (`?prefix=X`) |
| `POST` | `/workspaces/worktree` | Create worktree with mountain name (`?path=X`) |
| `GET` | `/workspaces/current-branch` | Current checked-out branch (`?path=X`) |
| `GET` | `/version` | Check for npm updates |
| `POST` | `/update` | Self-update via npm |
| `GET` | `/config/defaultAgent` | Get default coding agent |
| `PATCH` | `/config/defaultAgent` | Set default coding agent (`claude` or `codex`) |
| `POST` | `/hooks/stop` | Hook callback: set session state to idle (localhost-only, per-session token auth) |
| `POST` | `/hooks/notification` | Hook callback: permission-prompt or waiting-for-input state (localhost-only, per-session token auth) |
| `POST` | `/hooks/prompt-submit` | Hook callback: set processing state, trigger branch rename on first message (localhost-only, per-session token auth) |
| `POST` | `/hooks/session-end` | Hook callback: session cleanup dedup (localhost-only, per-session token auth) |
| `POST` | `/hooks/tool-use` | Hook callback: set currentActivity (tool name + detail) (localhost-only, per-session token auth) |
| `POST` | `/hooks/tool-result` | Hook callback: clear currentActivity (localhost-only, per-session token auth) |
| `POST` | `/webhooks/manage/setup` | Create GitHub webhook + start smee client for current workspace (`?path=X`) |
| `DELETE` | `/webhooks/manage/setup` | Delete GitHub webhook and stop smee client (`?path=X`) |
| `GET` | `/webhooks/manage/status` | Webhook health state (smee connected, last event timestamp) |
| `POST` | `/webhooks/manage/reload` | Reload smee client from saved config |
| `POST` | `/webhooks/manage/ping` | Send test ping to smee channel |
| `POST` | `/webhooks/manage/repos` | Add a repo to the webhook-managed set (body: `{path}`) |
| `POST` | `/webhooks/manage/repos/remove` | Remove a repo from the webhook-managed set (body: `{path}`) |
| `POST` | `/webhooks/manage/backfill` | Auto-provision webhooks for all repos that don't have one |

## WebSocket Channels

- `/ws/:sessionId` — PTY session relay: raw binary terminal I/O + resize JSON. Close code 1000 = PTY exited.
- `/ws/events` — Server-to-client broadcast (`worktrees-changed`, `session-idle-changed`).

Both channels require authentication via `token` cookie verified during HTTP upgrade.

## Cross-Cutting Concerns

**Build:** TypeScript compiles via `tsc` to `dist/`. Frontend builds via Vite to `dist/frontend/`. ESM throughout (`"type": "module"`), all relative imports use `.js` extensions, Node builtins use `node:` prefix.

**Auth:** Every HTTP request (except `/auth` POST) and every WebSocket upgrade requires a valid session cookie. Rate limiting is per-IP.

**Session lifecycle:** Sessions are in-memory during normal operation. Multiple sessions per directory are allowed (multi-tab support). PTY exit triggers automatic cleanup. Scrollback buffers cap at 256KB with FIFO eviction. PTY spawns are wrapped with `trap '' PIPE; exec` to prevent SIGPIPE from killing sessions. During auto-updates, sessions are serialized to disk (`pending-sessions.json` + scrollback files) and restored on restart.

---

## Architecture Decision Records

> Normative constraints are documented in `docs/adrs/`. Regenerate with `/adr:update`.

| ADR | Topic |
|-----|-------|
| ADR-001 | Modular server architecture (twenty-seven modules, composition root, dependency flow) |
| ADR-003 | PTY session management (in-memory state, scrollback, CLAUDECODE stripping) |
| ADR-004 | PIN authentication (scrypt, cookie tokens, rate limiting) |
| ADR-005 | Built-in test runner (node:test, nine test files, no external framework) |
| ADR-006 | Dual distribution (npm global + local dev, CLI flags via env vars) |
| ADR-007 | WebSocket dual channels (PTY relay + event broadcast, debounced watcher) |
| ADR-008 | TypeScript + ESM (strict mode, .js extensions, node: prefix, Node >= 24) |

> ADR-002 (vanilla JS frontend) was superseded by the Svelte 5 migration. `hooks.ts` does not yet have a dedicated ADR.
