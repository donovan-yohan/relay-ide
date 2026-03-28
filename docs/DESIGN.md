# Design

Backend patterns and conventions for claude-remote-cli. The server is a composition-root architecture where `index.ts` wires together single-concern modules communicating via ESM imports.

## Key Decisions

| Decision | Rationale | Source |
|----------|-----------|--------|
| No dependency injection | Direct ESM imports are simpler for a small module count | ADR-001 |
| In-memory sessions with update persistence | Sessions are ephemeral PTY processes, but serialized to disk before auto-updates and restored on restart | ADR-003, Design doc |
| scrypt + cookie tokens | PIN hashed with scrypt (migrated from bcrypt), cookie-based session auth, rate limiting | ADR-004 |
| Dual-path PIN setup | TTY: interactive CLI prompt at startup. Non-TTY (background service): server starts PIN-less, PinGate frontend gates all access until PIN set via `POST /auth/setup` | Bug fix 2026-03-28 |
| Dev tmux isolation | Dev mode (`NO_PIN=1`) uses `crcd-` tmux prefix; production uses `crc-`. Orphan cleanup only kills sessions matching its own prefix, preventing cross-instance kills | Bug fix 2026-03-28 |
| node:test, no Jest/Vitest | Fewer dependencies, built-in to Node.js | ADR-005 |
| Dual distribution (global + local) | npm global for production, local clone for dev | ADR-006 |
| TypeScript + ESM migration | Type safety, modern module system, strict mode | ADR-008 |
| Multi-agent CLI support | Abstract UI concepts (yolo, continue) map to agent-specific flags via `AGENT_COMMANDS`/`AGENT_YOLO_ARGS`/`AGENT_CONTINUE_ARGS` records in sessions.ts | Design doc |
| Global session defaults | `defaultContinue`, `defaultYolo`, `launchInTmux` extend the `defaultAgent` pattern; shared reactive store (`config.svelte.ts`) ensures all components see fresh values after settings changes | Design doc |
| Tmux clipboard passthrough | OSC 52 sequences from tmux flow through PTY→WebSocket to xterm.js; frontend handler decodes and writes to browser Clipboard API. Shift+click bypasses tmux mouse capture for native selection | Design doc |
| Tmux copy-mode for mobile selection | Long-press on mobile enters tmux copy-mode (vi bindings) instead of browser-native selection. Toolbar swaps to copy-mode buttons (hjkl, w/b, Space, Copy, Exit). `mode-keys vi` set in session config. | Design doc |
| Push notifications | Browser Notification API (desktop/open tab) + Web Push via service worker (mobile PWA). Per-session toggle in context menu, global default in settings. Server-side `push.ts` module owns `web-push` dependency and VAPID keys. | Design doc |
| Fixture-based mobile input testing | Event-intent pipeline extracted to `server/mobile-input-pipeline.ts` for unit testing; JSON fixtures in `test/fixtures/mobile-input/` | Design doc |
| File system browser API | `GET /workspaces/browse` returns directory entries with `isGitRepo`/`hasChildren` metadata. `POST /workspaces/bulk` for multi-add. FileBrowser.svelte provides lazy tree UI with filter, multi-select, keyboard nav. Denylist skips `node_modules`/.git/etc, 100 entry cap. | Design doc |
| Session-end broadcast | `session-ended` event emitted via `/ws/events` on PTY exit and `kill()`. Follows `onIdleChange` callback pattern in sessions.ts. Frontend invalidates svelte-query PR/CI caches on receipt. | Design doc |
| PR lifecycle state machine | `pr-state.ts` derives action from PR state + CI + mergeable + unresolved comments. Supports dual buttons (resolve + review). Archive flow kills session + deletes worktree. GraphQL query for unresolved review thread count. | Design doc |
| Hooks-based state detection | Claude Code hooks (--settings injection) replace fragile regex parsing for AgentState. Parser kept as fallback with 30s reconciliation timeout. | Design doc, CEO review |
| Hook-driven branch rename | UserPromptSubmit hook triggers claude -p for descriptive branch names, replacing ws.ts keystroke capture | CEO review override of design doc |
| forceOutputParser config | Escape hatch to disable hooks and use parser-only mode | Eng review |
| Local analytics | SQLite-backed event tracking (`analytics.ts` module). Auto-capture clicks via `data-track` attributes + explicit `trackEvent()` calls. Agent-queryable via direct `sqlite3` CLI access to `~/.config/claude-remote-cli/analytics.db`. Frontend batches events to `POST /analytics/events`. | Design doc |
| GitHub webhook self-service | `webhook-manager.ts` owns webhook CRUD, smee-client lifecycle, and health state. The webhook receiver (`/webhooks`) is mounted unconditionally so it is ready before any webhook is configured. Smart polling (`startSmartPolling`) runs a 30-second interval that broadcasts `pr-updated`/`ci-updated` only for repos that have no working webhook (`webhookEnabled !== true` or `webhookError` set) — automatically going silent once webhooks are active. Auto-provision backfill (`POST /webhooks/manage/backfill`) creates webhooks for all configured workspaces in one shot. | Design doc |
| OAuth scope for webhooks | GitHub OAuth App authorisation requests `repo admin:repo_hook` scope (previously `repo` only). The extra scope is required for `POST /repos/{owner}/{repo}/hooks` webhook creation. | Design doc |
| `extractOwnerRepo` + `buildRepoMap` in git.ts | Helper functions for resolving "owner/repo" from a git remote URL (SSH and HTTPS forms) and building a workspace-path lookup map. Extracted to `git.ts` so both `webhook-manager.ts` and `review-poller.ts` share one implementation. | Design doc |
| Enriched branch API | `GET /branches` returns `BranchInfo[]` with `isLocal`, `isRemote`, and `checkedOutIn` (worktree path + session ID). Cross-references `git worktree list --porcelain` with active sessions. | Design doc |
| Agent-running guard on branch ops | Branch switching, rename, and PR base change are disabled when `agentState === 'processing'`. Copy branch name is always available (read-only). | Design doc |
| PR base branch change | `POST /workspaces/pr-base` runs `gh pr edit --base` to change a PR's target branch from the UI. TargetBranchSwitcher dropdown shows remote-only branches. | Design doc |
| Inline branch rename + PR warning modal | Pencil icon triggers inline rename input. If a PR exists for the old branch, a warning modal offers Push (to remote), Ignore, or Cancel (undo rename). | Design doc |

## Config Precedence (canonical)

1. CLI flags (`--port`, `--host`, `--config`)
2. Environment variables (`CLAUDE_REMOTE_PORT`, `CLAUDE_REMOTE_HOST`, `CLAUDE_REMOTE_CONFIG`)
3. Config file (`~/.config/claude-remote-cli/config.json` global, `./config.json` dev)
4. Hardcoded defaults

## PTY Management

- `CLAUDECODE` env var stripped from PTY env to allow nesting
- Scrollback buffer: max 256KB per session, FIFO eviction
- PTY sessions survive browser disconnects — server keeps them alive
- Session auto-deleted when PTY exits; WebSocket closed with code 1000
- `claudeArgs` from POST body merged with `config.claudeArgs` (config args first)
- Re-attaching to a previous agent conversation uses agent-specific continue args (`--continue` for Claude, `resume --last` for Codex); reconnecting to a live PTY session requires no special args
- **Session persistence across updates:** When `POST /update` triggers a restart, `serializeAll()` writes session metadata (including `yolo`, `claudeArgs`, `hookToken`, `hooksActive`, `needsBranchRename`, and `branchRenamePrompt` flags) to `pending-sessions.json` (version 3) and scrollback buffers to `scrollback/<id>.buf` in the config directory. On startup, `restoreFromDisk()` reads them back: tmux sessions re-attach to surviving tmux server processes; non-tmux agent sessions re-spawn with `--continue` args plus preserved flags (yolo, claudeArgs); terminal sessions re-spawn the shell. Original session IDs are preserved for seamless frontend reconnection. Stale files (>5 min) are ignored. Version 2 pending files (with `repoPath` instead of `cwd`/`workspacePath`/`worktreePath`) are migrated on load via the v2→v3 migration path in `restoreFromDisk()`.
- **PTY retry on `--continue` failure:** If a session spawned with continue args exits within 3 seconds (regardless of exit code), the retry mechanism strips continue args and respawns. Exit code is intentionally not checked because tmux wrapping masks inner exit codes to 0. WebSocket clients are reattached via `onPtyReplacedCallbacks` (supports multiple concurrent connections). Tmux retries use a `-retry` suffix on the session name to avoid collision.

## Session Types

Sessions are typed as `'agent' | 'terminal'`. All sessions carry a `workspacePath` (the repo root) and an optional `worktreePath` (null for workspace-root sessions, populated for worktree sessions). There is no `'repo'` or `'worktree'` type distinction — the presence of `worktreePath` encodes location.

- **Agent sessions** — The selected coding agent (Claude or Codex) runs in either the workspace root (`worktreePath` is null) or a git worktree (`worktreePath` is set). Workspace-root agent sessions support `continue: true`, which maps to agent-specific continue args. Multiple sessions per workspace are allowed.
- **Terminal sessions** — A bare shell spawned in either the workspace root or a worktree. Useful for running commands alongside agent sessions.
- **Worktree creation** — `POST /workspaces/worktree` creates a new git worktree with the next mountain name (everest, kilimanjaro, denali, ...) tracked per-config via `nextMountainIndex`. The frontend then calls `POST /sessions` with the returned `worktreePath` to start a session in the new worktree. `POST /sessions` does not create worktrees itself.
- **Branch auto-rename** — New worktrees with mountain names get `needsBranchRename: true`. The rename instruction is delivered via a sideband `claude -p` invocation (a one-shot non-interactive Claude process) rather than PTY injection, keeping the main session's input stream clean. The `BranchWatcher` (`server/watcher.ts`) uses `fs.watch` on `.git/HEAD` files to detect branch changes reactively and broadcasts `session-renamed` when a branch changes. Additionally, `GET /sessions` enriches session data with live branch names (rate-limited to 10s intervals).
- **Worktree deletion** (`DELETE /worktrees`) — Validated via `git worktree list` (supports arbitrary paths, not just `.worktrees/`). Main worktree cannot be deleted.

## Session State Detection

- Backend computes a merged `BackendDisplayState` (`initializing | running | idle | permission`) from `agentState` + PTY idle timer, deduplicated (only emits when state changes)
- `session-backend-state-changed` is the single WebSocket event for all state changes (replaces the old dual `session-idle-changed` + `session-state-changed` events)
- PTY idle timer (`5s` silence) and output parser are inputs to `computeBackendState()` in `sessions.ts`; the merge eliminates spurious idle cycling from PTY noise
- For agents with hooks (Claude), `agentState` from hooks is authoritative. Parser reconciliation overrides after 30s of stale hooks. Raw idle is the fallback for agents without parsers (Codex stub).

## Output Parser

The `server/output-parsers/` directory implements a vendor-extensible registry for parsing terminal output into semantic `AgentState` values.

- **Registry pattern:** `index.ts` exports a `getParser(agentType)` function that returns the appropriate parser keyed by `AgentType`. Callers do not import individual parsers directly.
- **Per-vendor parsers:** `claude-parser.ts` and `codex-parser.ts` each export a stateless parse function `(chunk: string, currentState: AgentState) => AgentState`.
- **No cross-module deps:** The `output-parsers/` module only imports from `types.ts`; it does not depend on any other server module.
- **Extending:** To add a new agent, create `<vendor>-parser.ts` and register it in `index.ts`.

## Hook System

`server/hooks.ts` registers an Express Router mounted at `/hooks` in `index.ts`. Endpoints receive callbacks from Claude Code's hooks mechanism, which is injected via `--settings` when spawning PTY sessions.

- **State detection:** `POST /hooks/stop` sets session state to idle; `POST /hooks/notification` sets `permission-prompt` or `waiting-for-input` based on the notification title; `POST /hooks/prompt-submit` sets state to `processing`.
- **Activity tracking:** `POST /hooks/tool-use` sets `currentActivity` (tool name + detail); `POST /hooks/tool-result` clears it.
- **Session cleanup:** `POST /hooks/session-end` triggers session cleanup with deduplication (ignores duplicate events within a short window).
- **Branch rename:** `POST /hooks/prompt-submit` also triggers the branch rename flow on the first user message, replacing the previous ws.ts keystroke-capture approach.
- **Claude-only:** Hooks are injected only for Claude PTY sessions. Codex sessions continue to use the output parser exclusively.
- **Parser fallback:** The output parser remains active with a 30-second reconciliation timeout — if a hook-derived state has not been confirmed by a subsequent hook event within 30s, the parser state takes precedence.
- **Restored tmux sessions:** `hookToken` and `hooksActive` are serialized and restored. Surviving tmux sessions (old Claude instance still running) keep their original token — the server accepts hook calls with the preserved token. Dead tmux sessions (respawned with `--continue`) get the settings file re-created with the preserved token and `--settings` re-injected into spawn args.
- **Auth:** Endpoints are localhost-only. Each session uses a per-session token (not the user's PIN cookie) to authenticate hook callbacks.

## Clipboard Image Passthrough

1. Browser paste/drop detects image, base64-encodes and POSTs to `/sessions/:id/image`
2. Server saves to `/tmp/claude-remote-cli/:sessionId/paste-:timestamp.:ext`
3. Attempts system clipboard set (osascript on macOS, xclip on Linux)
4. If clipboard set succeeds: sends `\x16` (Ctrl+V) to PTY stdin
5. If fails: returns file path; frontend shows "Insert Path" button

**Platform-specific:** On Windows/Linux, xterm.js intercepts Ctrl+V (custom key handler reads Clipboard API). On macOS, only Cmd+V triggers paste.

## Background Service

- `--bg` is shortcut for `install` (installs + starts)
- Service files generated with current CLI flags baked in
- macOS: launchd plist (`RunAtLoad` + `KeepAlive`); Linux: systemd user unit (`Restart=on-failure`)
- To change port/host: `uninstall` then re-install with new flags

## Slash Commands

- Claude Code slash commands live in `.claude/commands/` and are tracked in git
- `.gitignore` ignores `.claude/` subdirectories individually (not blanket) to allow `commands/` to be versioned
- Commands are markdown prompt templates executed interactively by Claude

## Deep Docs

| Document | Purpose |
|----------|---------|
| `design-docs/core-beliefs.md` | Agent-first operating principles |
| `design-docs/` | Feature design documents (brainstorm outputs) |

## See Also

- [Architecture](ARCHITECTURE.md) — module boundaries and invariants
- [Frontend](FRONTEND.md) — Svelte 5 patterns and component conventions
- [Quality](QUALITY.md) — testing patterns and test isolation
- [Plans](PLANS.md) — active and completed execution plans
