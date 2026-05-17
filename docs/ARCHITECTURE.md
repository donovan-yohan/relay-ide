# Architecture

This document describes the high-level architecture of Relay IDE.
If you want to familiarize yourself with the codebase, you are in the right place.

## Bird's Eye View

Relay IDE is a remote web interface for interacting with agent and terminal sessions from any device. A user opens the web UI in a browser, authenticates with a PIN, and gets a terminal connected to a tmux-backed process running either on the hub machine or on a paired Relay node. The hub manages auth, UI, routing, node registry state, reverse node-link RPC, aggregated repo inventory, and local hub-as-node sessions; each node owns its own PTY/session execution and local filesystem/git checkout state.

Input: browser keystrokes, session management commands, clipboard images.
Output: terminal rendering via xterm.js, real-time session state updates.

The system has two compilation targets: a TypeScript + ESM backend (Express + node-pty + tmux + WebSocket) compiled to `dist/`, and a React 19 frontend (Zustand + TanStack Query + Vite) compiled to `dist/frontend/`.

## Six-Layer Vocabulary Contract (#444)

Relay's product information architecture is now described as **View -> Workspace -> Project -> Instance -> Bench -> Tab**. This vocabulary is a source-of-truth for docs and implementation planning; it does not mean every layer must be visible in every UI state. The single-repo golden path should stay compact, while remote, non-repo, and multi-node states expose the layer needed to avoid false repo/worktree assumptions.

| Layer         | What it answers                                       | Current / compatibility boundary                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **View**      | What lens am I looking through?                       | A filter or presentation across tabs/projects/workers. Views are not durable storage unless a future saved-view feature defines that persistence.                                                                      |
| **Workspace** | What am I organizing?                                 | A user-owned grouping of Projects and pins. Do not use Workspace as the universal name for a filesystem path or repo checkout. Existing `/workspaces` routes remain legacy repo-folder compatibility during migration. |
| **Project**   | What is being worked on?                              | Canonical identity: commonly a git remote, but also node, agent-provider, playbook, or other target kinds. Use `repo` only when the affordance is specifically git/PR/branch/remote.                                   |
| **Instance**  | Where is that Project realized?                       | A host/node realization of a Project. Existing repo instance IDs such as `(nodeId, repoPath)` are git-specific Instance compatibility shapes.                                                                          |
| **Bench**     | Which cwd + environment is active inside an Instance? | Generalizes git worktrees. Existing `worktreePath` and worktree instance IDs stay valid for git Bench compatibility and destructive git-worktree operations.                                                           |
| **Tab**       | What leaf surface is active?                          | Terminal, agent chat, file, diff, or preview surface. Existing session/stream IDs remain process and routing identity, not the primary user-facing IA label.                                                           |

**Project = what; Worker = who.** Worker/agent status should remain dynamic decoration on a Bench or Tab, not a structural tree node between Project and Instance. Future decoration fields may include names like `currentWorkers`, `activeWorker`, or `mode`, but those are not a shipped shared contract yet. `Project.identity.kind = 'agent'` means agent-as-target/configuration, not the active worker doing the work.

### Internal and compatibility identities

Keep these names precise where they describe implemented plumbing:

- `globalSessionId` remains an internal stream/routing identifier for hub/node session lookup and reconnect. It should not become primary user-facing copy.
- `repoInstanceId`, `worktreeInstanceId`, `repoPath`, and `worktreePath` remain compatibility fields while shared/server/frontend contracts migrate.
- `repo`, `branch`, `remote`, and `worktree` remain correct inside git-specific docs, routes, widgets, and destructive operations. The anti-pattern is treating them as universal IA terms for every Tab.

### First-wave implementation lanes

1. **Docs/source of truth:** keep this contract, `docs/FRONTEND.md`, and `docs/federated-relay.md` aligned before broad code changes.
2. **Compatibility adapters:** add helpers that map legacy `repoPath`/`worktreePath`/workspace storage keys into Project/Instance/Bench/Tab view models without destructive localStorage or persistence migration.
3. **Copy-only UI pass:** update low-risk visible copy to stop saying repo/worktree/session when the state may be remote, free/non-git, or tab-scoped. Preserve git nouns for literal git affordances.
4. **Backend/shared contracts:** introduce new Workspace/Project/Instance/Bench entities and route wrappers while keeping legacy API fields readable.
5. **Frontend IA migration:** migrate sidebar, command palette, create-tab, restore/resume, and utility rail consumers behind tab/context adapters, coordinated with #473.

### Explicit non-goals for this docs slice

- No blanket repo-wide rename of `workspace`, `repo`, `worktree`, or `session`.
- No full #473 right-rail/create-tab migration in this PR.
- No #428 remote file RPC guarantee; remote file browsing can stay unavailable until that work lands.
- No Worker/Agent tree node. Worker remains decoration and can later power a Worker-focused View.

## Code Map

### `server/`

69 TypeScript modules (including `adapters/`, `output-parsers/`, and `protocol-adapters/` subdirectories) compiled to `dist/server/` via `tsc`. Modules communicate via ESM `import` statements.

| Module                                  | Role                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`                              | Composition root: Express app, REST routes, auth middleware, static serving                                                                                                                                                                                        |
| `workspaces.ts`                         | Legacy repo-folder compatibility router: dashboard, settings, CI status, branch switch, path autocomplete. These `/workspaces` routes are not the future six-layer Workspace entity source of truth.                                                               |
| `workspace-groups.ts`                   | Current workspace grouping CRUD for user-organized repo groups; compatibility surface until six-layer Workspace/Project persistence lands.                                                                                                                         |
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
| `types.ts`                              | Shared TypeScript interfaces, including legacy `Session`, `Repo`, `Workspace`, `repoPath`, and `worktreePath` compatibility shapes that map toward Project/Instance/Bench/Tab view models.                                                                         |
| `analytics.ts`                          | Local analytics: SQLite-backed event tracking, `trackEvent()`, batch ingest endpoint, DB size/clear endpoints                                                                                                                                                      |
| `port-allocator.ts`                     | Durable per-worktree port allocation, persisted assignments, `.env` managed-block reconciliation, and startup verification of allocated ports                                                                                                                      |
| `review-poller.ts`                      | PR review automation: polls GitHub notifications for review requests, creates worktrees, optionally starts review sessions                                                                                                                                         |
| `output-parsers/`                       | Vendor-extensible terminal output parsing for semantic agent state detection (AgentState), keyed by AgentType. Contains `index.ts` (registry + dispatch), `claude-parser.ts`, `codex-parser.ts`                                                                    |
| `github-app.ts`                         | GitHub OAuth App flow: authorization URL generation (with CSRF state), token exchange callback, connection status, disconnect                                                                                                                                      |
| `github-graphql.ts`                     | GitHub GraphQL client: PR search query, response mapping (PRs → PullRequest[]), fetchPrsGraphQL()                                                                                                                                                                  |
| `webhooks.ts`                           | GitHub webhook receiver: HMAC signature verification, event routing, broadcast to frontend                                                                                                                                                                         |
| `webhook-manager.ts`                    | GitHub webhook CRUD, smee client lifecycle, health state, auto-provision backfill, webhook source status mapping, and per-repo last webhook receipt timestamps                                                                                                     |
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
| `protocol-adapter.ts`                   | Abstract `ProtocolAdapter` base class; concrete adapters live in `protocol-adapters/{claude,codex,opencode,hermes,mock}.ts`                                                                                                                                        |
| `telemetry.ts` / `telemetry-adapter.ts` | Framework-neutral telemetry bus + abstract adapter; concrete adapters in `adapters/{claude,codex,opencode}-telemetry.ts` self-register at import time                                                                                                              |
| `web-session-handler.ts`                | Request/response handler for web-chat sessions (non-PTY): creation, input delivery, event streaming via `ChatEvent`                                                                                                                                                |
| `frameworks.ts`                         | Agent framework registry client surface: resolves configured/built-in agent frameworks, probes CLI availability, and surfaces runtime web availability where supported                                                                                             |
| `node-manifest.ts`                      | Local node capability manifest: probes platform/arch/hostname/version, WSL, service manager, tmux/git/clipboard/browser/gh/tailscale/ssh, and agent tool availability non-fatally                                                                                  |
| `local-node.ts`                         | Local node state: identity, manifest, repo inventory, credential storage, and heartbeat sender for the current machine when acting as a node                                                                                                                       |
| `hub-node-router.ts`                    | Express Router for hub/node REST API: pair tokens, pairing exchange, node heartbeat, node listing, direct session creation routing, manual/online credential rotation, rotation clear-recovery, node revocation                                                    |
| `hub-node-registry.ts`                  | Pair-token lifecycle, SHA256-hashed credential storage, timing-safe authentication, hub-owned ACL policy/default migration, heartbeat state tracking, credential rotation proof/audit, offline/stale/revoked status, registry persistence with debounced writes    |
| `security-audit-log.ts`                 | Hash-chained security audit persistence: append-only SQLite table, atomic inserts, verifier for gaps/tamper/corruption, and CLI-facing verification result shape                                                                                                   |
| `hub-node-link.ts`                      | Reverse WebSocket link manager: node link registration, RPC request/response, PTY stream proxy between browser and node, node event broadcast, cleanup on disconnect/revocation                                                                                    |
| `repo-inventory.ts`                     | Local repo inventory collection: workspace scanning, git remote normalization, capability-gated repo identity resolution                                                                                                                                           |
| `features/repo-inventory.ts`            | Repo inventory feature service: stores node-reported inventory snapshots and aggregates local + remote reports by canonical repo identity                                                                                                                          |
| `features/repo-router.ts`               | Repo-aware hub HTTP routes moved out of `hub-node-router.ts`: `GET /hub/repo-inventory` aggregation and `POST /hub/nodes/:nodeId/sessions/reopen` cold-reopen routing                                                                                              |
| `sandbox.ts`                            | Spawns isolated relay-ide server instances with ephemeral config, dynamic port allocation, and readiness polling for agent-driven testing                                                                                                                          |
| `agent-browser.ts`                      | Playwright-based browser automation for agents: launches Chromium, captures screenshots, validates pages via console-error collection (`launchBrowser`, `screenshot`, `validatePage`, `closeBrowser`)                                                              |

### `shared/`

Compiled by both `tsconfig.json` (server build) and `frontend/tsconfig.json` (Vite); modules here are the only place where server and frontend are allowed to share source.

| Module                     | Role                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-events.ts`           | `ChatEvent` discriminated union and type guards — the wire protocol for web-chat transcripts                                                                                                    |
| `control-state.ts`         | Product control-state summary and tab intervention event contracts; keeps `controlMode` independent from transport `mode`                                                                       |
| `work-context.ts`          | Versioned WorkContext contract linking actors, tasks, node/session/project/repo/bench refs, artifacts, audit refs, capability refs, and privacy metadata without requiring raw logs/transcripts |
| `mobile-input-pipeline.ts` | Pure-function event-intent pipeline for mobile virtual keyboard input — consumed by the React `MobileInput` component; unit-tested via JSON fixtures                                            |
| `node-manifest.ts`         | Shared `NodeManifest` / `NodeCapabilities` schema for platform, service manager, WSL, and tool/agent capability probes                                                                          |
| `bootstrap-diagnostics.ts` | Relay-node bootstrap command generation, redaction helpers, and diagnostics taxonomy for local/SSH/Tailscale pairing                                                                            |

**Architecture Invariant:** `index.ts` is the composition root and MUST NOT be imported by other modules. Cross-module dependencies flow downward: `index.ts` imports all others; `ws.ts` may import `sessions`; `sessions.ts` imports `pty-handler`; `workspaces.ts` imports `git` and `config`; `hooks.ts` receives `sessions`, `git`, `config`, `analytics`, `telemetry`, and `push` via a `HookDeps` injection seam (composition root wires them; `hooks.ts` does statically import those modules to type the deps but does not invoke them directly from module scope); all other modules are self-contained. **Exception:** `analytics.ts`, `push.ts`, and `logger.ts` are pure output dependencies (fire-and-forget) imported by multiple modules — this is acceptable because they have no effect on callers' control flow. Each module owns a single concern and confines its npm dependencies (e.g., only `auth.ts` depends on crypto.scrypt, only `pty-handler.ts` depends on node-pty, only `analytics.ts` depends on better-sqlite3, only `push.ts` depends on web-push). The `output-parsers/` module confines all output-parsing logic and may depend on `types.ts` only — it MUST NOT import from `utils.ts` or any other server module. There are currently 69 server modules, including modules in the `adapters/`, `output-parsers/`, and `protocol-adapters/` subdirectories.

### `frontend/`

React 19 SPA built by Vite, output to `dist/frontend/`. Express serves the compiled output.

| Path                                  | Role                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/src/components/`            | React 19 TSX components (Terminal, Sidebar, RepoItem, PrTopBar, WorkspaceArea, RepoDashboard, CommandPalette, dialogs, etc.)                                                                |
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

`bin/relay-ide.ts` — CLI entry point. Parses flags (`--port`, `--host`, `--config`, `--version`, `--help`, `--bg`, `hub`, `node`, `install`, `uninstall`, `status`, `update`), manages config directory, prompts for PIN on first run. Hub/node roles intentionally share the single `relay-ide` npm binary; see `docs/RELAY_HUB_NODE_PACKAGING.md`.

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

**Federated node-link flow (current):**

```
Browser <--WS /nodes/:nodeId/ws/sessions/:sessionId--> Hub
Hub     <--WS /hub/node-link (reverse outbound link)--> Node
Node    <--node-pty/tmux--> shell / agent CLI
```

Implemented today:

- `relay-ide node connect` exchanges a short-lived pair token, writes `node-credential.json`, sends one authenticated heartbeat, and exits.
- `relay-ide node link --hub <url>` is the foreground long-running reverse WebSocket client. It sends `control.hello`/`control.heartbeat` with manifest + repo inventory, handles `sessions.create` / `sessions.kill` RPC, and hosts routed PTY streams.
- The hub can create remote sessions through `POST /hub/nodes/:nodeId/sessions` and attach browsers through `/nodes/:nodeId/ws/sessions/:sessionId` when the node is online, protocol-compatible, and tmux-capable.
- `server/local-node.ts` makes the hub itself look like the default local node for existing sessions/events.
- Hub-owned node ACL policy is enforced on each routed decision; ACL changes apply immediately in hub policy and do not wait for node credential rotation.
- Credential rotation is shipped for explicit operator/manual and online reverse-link delivery. Manual delivery is an authenticated-operator route that deliberately returns `credential.token` so the operator can move it to the node out-of-band; node summaries and audit rows expose credential IDs/rotation IDs only, never bearer tokens. Online delivery sends `credential.rotate` over `/hub/node-link`; the node writes the new credential and the next HTTP or reverse-link heartbeat proves `nextCredentialId`, swaps the active credential, invalidates the previous token, and appends a redacted `rotation`/`rotated` audit event.
- Clear-recovery is an operator escape hatch for failed or non-stable rotations: it preserves the current hub credential, invalidates the unproved next credential, and unblocks another rotation. Until that clear action, failed or delivered rotations keep the next credential hash so a node that already wrote the next credential can reconnect and prove possession without manual credential surgery or re-pairing.

Planned/deferred, not shipped:

- #428 File RPC (`fs.read`, `fs.list`, `fs.write`, `fs.tail`) remains in spikes/design docs, not source.
- #476 hub/node log proxy (`logs.tail`, node-log streaming, diagnostic bundles beyond current CLI `node status|logs|doctor`) is not implemented.
- #427 trust-tier/capability/ACL schema and legacy defaults are implemented in `shared/security-policy.ts` and `server/hub-node-registry.ts`. The hash-chained audit sink/verifier primitive is implemented in `shared/security-audit.ts` and `server/security-audit-log.ts`. Policy evaluator gates, two-token confirmation, manual/online credential rotation, and redacted rotation proof audit are implemented; scheduled/default credential rotation and external audit shipping remain configurable/deferred.
- #444 six-layer IA (`View -> Workspace -> Project -> Instance -> Bench -> Tab`) is not the persisted/current backend model.

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
- Ordinary dev mode sessions (`NO_PIN=1`) use the `relay-dev-` prefix.
- Self-host mode sessions (`relay-ide dev --self-host` / `npm run dev:self`) use the `relay-self-` prefix and a config path under user config state, not the production config.
- The slug is sanitized to alphanumeric/hyphen characters and capped before the session id suffix.
- Restore paths preserve the original session id and tmux session name so browser tabs can reconnect to the same server-side process after a server restart.
- On startup, the server checks whether the named tmux session still exists. If it does, Relay reattaches with `tmux -u attach-session -t <name>`. If it does not, agent sessions fall back to agent-specific continue args and create a fresh tmux-backed process.
- `sessions.ts` exposes targeted tmux helpers (`sendTmuxKeys`, `sendTmuxText`, `captureTmuxPane`) so future workspace panes can address a specific tmux-backed process by session id instead of relying only on the currently attached PTY stream.

This makes Tab and pane customization (#263) viable without losing process ownership; the tmux/session name is process substrate, while the browser Tab is the user-visible leaf surface. Browser-level tabs and panes can be rearranged freely while the underlying tmux session remains the stable process identity for reconnect, restore, resize, copy-mode, and cleanup.

## REST API

| Method   | Path                                     | Description                                                                                                                                         |
| -------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/auth`                                  | Authenticate with PIN, returns session cookie                                                                                                       |
| `GET`    | `/sessions`                              | List active sessions                                                                                                                                |
| `POST`   | `/sessions`                              | Create local agent/terminal Tab process; current local contract requires `repoPath`, with `worktreePath` selecting cwd when set                     |
| `PATCH`  | `/sessions/:id`                          | Rename session                                                                                                                                      |
| `DELETE` | `/sessions/:id`                          | Terminate session                                                                                                                                   |
| `POST`   | `/sessions/:id/image`                    | Upload clipboard image                                                                                                                              |
| `GET`    | `/branches`                              | List local and remote branches                                                                                                                      |
| `GET`    | `/worktrees`                             | List inactive Claude Code worktrees                                                                                                                 |
| `DELETE` | `/worktrees`                             | Remove worktree, prune refs, delete branch                                                                                                          |
| `GET`    | `/workspaces`                            | Legacy: list configured repo/workspace folders with git info; not the future Workspace entity CRUD                                                  |
| `POST`   | `/workspaces`                            | Legacy: add a repo/folder path (body: `{path}`)                                                                                                     |
| `DELETE` | `/workspaces`                            | Remove workspace folder                                                                                                                             |
| `GET`    | `/workspaces/dashboard`                  | Aggregated PRs + activity for a workspace (`?path=X`)                                                                                               |
| `GET`    | `/workspaces/settings`                   | Per-workspace settings (`?path=X`)                                                                                                                  |
| `PATCH`  | `/workspaces/settings`                   | Update per-workspace settings                                                                                                                       |
| `GET`    | `/workspaces/pr`                         | PR info for a branch (`?path=X&branch=Y`)                                                                                                           |
| `GET`    | `/workspaces/ci-status`                  | CI check results (`?path=X&branch=Y`)                                                                                                               |
| `POST`   | `/workspaces/branch`                     | Switch branch (`?path=X`, body: `{branch}`)                                                                                                         |
| `GET`    | `/workspaces/browse`                     | Browse filesystem directories (and files with `includeFiles=true`) for tree UI (`?path=X&prefix=Y&showHidden=bool&includeFiles=bool`)               |
| `POST`   | `/workspaces/bulk`                       | Add multiple workspace paths at once (body: `{paths}`)                                                                                              |
| `GET`    | `/workspaces/autocomplete`               | Path prefix autocomplete (`?prefix=X`)                                                                                                              |
| `POST`   | `/workspaces/worktree`                   | Git-specific Bench compatibility: create a worktree with mountain name (`?path=X`)                                                                  |
| `GET`    | `/workspaces/current-branch`             | Current checked-out branch (`?path=X`)                                                                                                              |
| `GET`    | `/api/node/manifest`                     | Local node manifest: platform/arch/hostname/version, WSL, service manager, and non-fatal capability/tool probes; CLI mirror is `relay-ide manifest` |
| `POST`   | `/hub/pair-tokens`                       | Create a short-lived relay-node pair token with redacted-safe SSH/Tailscale/local bootstrap command variants                                        |
| `POST`   | `/hub/pairing/exchange`                  | Exchange a one-time pair token for a persistent revocable node credential                                                                           |
| `POST`   | `/hub/node-heartbeat`                    | Authenticated relay-node heartbeat using the persistent node credential                                                                             |
| `GET`    | `/nodes`                                 | List paired nodes with heartbeat status, reverse-link connection state, manifest capability summary, and hub-owned ACL policy summary               |
| `GET`    | `/hub/repo-inventory`                    | Aggregate local + node-reported repo inventory by canonical git remote identity                                                                     |
| `POST`   | `/hub/nodes/:nodeId/sessions`            | Route terminal/agent session creation to an online node over reverse-link RPC; RPC body uses `repoPath`, `worktreePath`, and `cwd`                  |
| `DELETE` | `/hub/nodes/:nodeId/sessions/:sessionId` | Kill a node-local session through reverse-link RPC                                                                                                  |
| `DELETE` | `/nodes/:nodeId`                         | Revoke a paired node credential                                                                                                                     |
| `GET`    | `/version`                               | Check for npm updates                                                                                                                               |
| `POST`   | `/update`                                | Self-update via npm                                                                                                                                 |
| `GET`    | `/config/defaultAgent`                   | Get default coding agent                                                                                                                            |
| `PATCH`  | `/config/defaultAgent`                   | Set default coding agent (`claude` or `codex`)                                                                                                      |
| `POST`   | `/hooks/stop`                            | Hook callback: set session state to idle (localhost-only, per-session token auth)                                                                   |
| `POST`   | `/hooks/notification`                    | Hook callback: permission-prompt or waiting-for-input state (localhost-only, per-session token auth)                                                |
| `POST`   | `/hooks/prompt-submit`                   | Hook callback: set processing state, trigger branch rename on first message (localhost-only, per-session token auth)                                |
| `POST`   | `/hooks/session-end`                     | Hook callback: session cleanup dedup (localhost-only, per-session token auth)                                                                       |
| `POST`   | `/hooks/tool-use`                        | Hook callback: set currentActivity (tool name + detail) (localhost-only, per-session token auth)                                                    |
| `POST`   | `/hooks/tool-result`                     | Hook callback: clear currentActivity (localhost-only, per-session token auth)                                                                       |
| `POST`   | `/webhooks/manage/setup`                 | Create GitHub webhook + start smee client for current workspace (`?path=X`)                                                                         |
| `DELETE` | `/webhooks/manage/setup`                 | Delete GitHub webhook and stop smee client (`?path=X`)                                                                                              |
| `GET`    | `/webhooks/manage/status`                | Webhook health state (smee connected, last event timestamp)                                                                                         |
| `POST`   | `/webhooks/manage/reload`                | Reload smee client from saved config                                                                                                                |
| `POST`   | `/webhooks/manage/ping`                  | Send test ping to smee channel                                                                                                                      |
| `POST`   | `/webhooks/manage/repos`                 | Add a repo to the webhook-managed set (body: `{path}`)                                                                                              |
| `POST`   | `/webhooks/manage/repos/remove`          | Remove a repo from the webhook-managed set (body: `{path}`)                                                                                         |
| `POST`   | `/webhooks/manage/backfill`              | Auto-provision webhooks for all repos that don't have one                                                                                           |
| `GET`    | `/workspaces/changed-files`              | List changed files in a repo (`?path=X&base=ref`)                                                                                                   |
| `GET`    | `/workspaces/divergence`                 | Branch divergence, line delta, dirty summary, base candidates, and capped side-specific commits (`?path=X&base=ref`)                                |
| `GET`    | `/workspaces/file-diff`                  | Get unified diff for a single file (`?path=X&file=Y&base=ref`)                                                                                      |

## WebSocket Channels

- `/ws/:sessionId` — PTY session relay: raw binary terminal I/O + resize JSON. Close code 1000 = PTY exited.
- `/nodes/:nodeId/ws/sessions/:sessionId` — Browser-to-hub endpoint for routed node PTY sessions. The hub proxies bytes to/from the node's reverse-link `pty` channel.
- `/hub/node-link` — Node-to-hub reverse WebSocket. Authenticates with the node credential Bearer token and carries `control`, `rpc`, `events`, and `pty` JSON envelopes.
- `/ws/events` — Server-to-client broadcast (`worktrees-changed`, `session-idle-changed`, `files-changed` with `changedFiles: string[]`).

Browser-facing channels require authentication via `token` cookie verified during HTTP upgrade. `/hub/node-link` uses the node credential Bearer token instead.

## Cross-Cutting Concerns

**Build:** TypeScript compiles via `tsc` to `dist/`. Frontend builds via Vite to `dist/frontend/`. ESM throughout (`"type": "module"`), all relative imports use `.js` extensions, Node builtins use `node:` prefix.

**Auth:** Every HTTP request (except `/auth` POST) and every WebSocket upgrade requires a valid session cookie. Rate limiting is per-IP.

**Session lifecycle:** Runtime session records are in-memory during normal operation, while tmux owns the durable process tree. Multiple sessions per directory are allowed (multi-tab support). PTY exit triggers automatic cleanup. Scrollback buffers cap at 256KB with FIFO eviction. PTY spawns are wrapped with `trap '' PIPE; exec` to prevent SIGPIPE from killing sessions. During auto-updates, sessions are serialized to disk (`pending-sessions.json` + scrollback files) and restored on restart by reattaching to the preserved tmux name when possible.

---

## Architecture Decision Records

> Full ADR markdown lives under `docs/adrs/` for entries that have been
> committed; older entries are summarized below until backfilled. Regenerate
> with `/adr:update`.

| ADR     | Topic                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADR-001 | Modular server architecture (composition root, dependency flow)                                                                                                                      |
| ADR-003 | PTY session management (tmux substrate, in-memory state, scrollback, CLAUDECODE stripping)                                                                                           |
| ADR-004 | PIN authentication (scrypt, cookie tokens, rate limiting)                                                                                                                            |
| ADR-005 | Vitest as unit/integration test runner (migrated from node:test 2026-04-03)                                                                                                          |
| ADR-006 | Dual distribution (npm global + local dev, CLI flags via env vars)                                                                                                                   |
| ADR-007 | WebSocket dual channels (PTY relay + event broadcast, debounced watcher)                                                                                                             |
| ADR-008 | TypeScript + ESM (strict mode, .js extensions, node: prefix, Node >= 24)                                                                                                             |
| ADR-009 | Hub/Node Federation (hub accepts node registrations via reverse WebSocket; nodes own data plane; hub owns routing/aggregation)                                                       |
| ADR-010 | Node-Initiated Outbound Links (nodes dial hub to avoid NAT/firewall inbound)                                                                                                         |
| ADR-011 | Agent-driven browser automation (`server/agent-browser.ts`, Playwright)                                                                                                              |
| ADR-012 | Pair-Token/Credential Lifecycle (short-lived pair token → persistent revocable node credential; SHA256 storage; immediate revocation)                                                |
| ADR-013 | Capability Manifest (nodes self-report probes; hub gates routing on capability state)                                                                                                |
| ADR-014 | Repo Identity Aggregation (canonical git/GitHub remote identity across nodes; local paths node-specific)                                                                             |
| ADR-015 | Core relay primitives are domain-agnostic; repo/git is a feature layer ([`docs/adrs/ADR-015-core-primitives-domain-agnostic.md`](./adrs/ADR-015-core-primitives-domain-agnostic.md)) |
| ADR-016 | Node-to-node isolation invariant; inter-node traffic flows through the hub ([`docs/adrs/ADR-016-node-to-node-isolation.md`](./adrs/ADR-016-node-to-node-isolation.md))               |

> ADR-002 (vanilla JS frontend) was superseded by the Svelte 5 migration, which was subsequently superseded by the React 19 migration. `hooks.ts` does not yet have a dedicated ADR.
