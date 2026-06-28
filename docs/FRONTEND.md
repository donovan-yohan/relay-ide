# Frontend

React 19 SPA for Relay IDE. Built with TypeScript, Zustand, TanStack Query, and Vite. The frontend provides tab-first terminal surfaces, active session management, right-rail utilities, and repo/worktree affordances when the active tab has a verified repo binding.

## Current State

- React 19 with hooks, Zustand 5 for state management, TanStack React Query 5 for server state — TypeScript throughout
- Vite builds `frontend/` to `dist/frontend/`; Express serves compiled output in production
- Source dev uses `npm run dev`: real backend on `127.0.0.1:3457`, Vite HMR frontend on `127.0.0.1:5173`, with REST and `/ws/*` requests proxied so frontend code keeps relative fetch/WebSocket URLs
- Self-host dev uses `npm run dev:self`: same supervised backend + Vite HMR loop, but with per-worktree allocated ports and isolated config under `~/.config/relay-ide/self-host/` so Relay can safely build Relay inside an installed Relay session
- xterm.js consumed as npm dependency (`@xterm/xterm`, `@xterm/addon-fit`); it remains the browser renderer while `relay-pty`/libghostty-vt owns server-side session/process execution. Browser reconnect can reattach to a live Relay process; server restart is cold resume from saved metadata/scrollback only.
- Current implementation still has repo-centric state (`activeRepoPath`, `repoPath`, `worktreePath`) in App/sidebar/session paths; docs should describe that as the local repo Project/Bench case, not the full IA model
- `WorkspaceTab` session tabs can carry `nodeId`; non-local terminal creation routes through `/hub/nodes/:nodeId/sessions`, and PTY sockets route through `/nodes/:nodeId/ws/sessions/:sessionId`
- Utility rail context is derived from the active tab/session: local repo tabs expose file/git resources, remote tabs show explicit remote unavailable states until #428, and free/non-git local tabs can browse files without git widgets
- Mobile-first responsive design with touch toolbar (hidden on desktop)

## Product Vocabulary and Tab Context (#444)

Frontend copy and state should use the six-layer model as its mental model: **View -> Workspace -> Project -> Instance -> Bench -> Tab**. In code, many APIs still expose `repoPath`, `worktreePath`, `SessionSummary`, and old workspace storage keys; treat those as compatibility contracts until server/shared migrations land.

| Term          | Frontend meaning                                                                                        | Current implementation boundary                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **View**      | The active lens/filter, such as recent tabs, all sessions, this host, or a workspace-scoped view.       | Current sidebar and command palette filters are view-like but not yet saved View entities.                                                                |
| **Workspace** | User-owned organization: named grouping, project pins, and lenses.                                      | Existing workspace groups and `/workspaces` repo-folder APIs are legacy compatibility. Do not present a repo path as the whole Workspace.                 |
| **Project**   | The durable target: usually a repo, but eventually also node, agent provider, playbook, or saved query. | Existing repo rows are repo-kind Projects. Git labels remain correct for PRs, branches, remotes, and repo badges.                                         |
| **Instance**  | A Project on a node/host.                                                                               | Existing `(nodeId, repoPath)` repo instances are git-specific Instance compatibility. Prefer host labels in compact chrome if “Instance” is too abstract. |
| **Bench**     | cwd + environment within an Instance.                                                                   | Existing worktrees are git Bench compatibility. Use worktree copy only for literal git worktree operations.                                               |
| **Tab**       | The active leaf surface: terminal, agent chat, file, diff, or preview.                                  | `WorkspaceTab`, session ids, and PTY streams are implementation details that back the user-visible Tab.                                                   |

Worker/agent status is decoration, not hierarchy: **Project = what; Worker = who**. Future badges or view-model fields for active worker, human-driven/agent-driven/co-driven mode, or current workers should attach to Bench/Tab surfaces after their contract ships. Do not add a Worker tree node. `Project.identity.kind = 'agent'` means configuring an agent target, not showing an active worker.

### State-key and copy rules during migration

- Preserve legacy localStorage/API keys such as `claude-remote-active-workspace`, `claude-remote-workspace-sessions`, `relay-utility-rail::<path>`, `repoPath`, `worktreePath`, and `globalSessionId`; add adapter/view-model names around them instead of destructive renames.
- The active context is the active **Tab** plus optional Project/Instance/Bench/repo binding. Avoid global “active repo” copy unless the tab actually has a repo binding.
- The utility rail is tab-contextual. Its header and unavailable states should describe the active tab anchor: local repo tab, remote node tab, or free/non-git tab.
- “Not a git repo”, “remote files unavailable until file RPC lands”, and “no pinned projects” are normal empty/unavailable states, not red failure states.
- PR/git widgets read from explicit workspace pins and active-tab anchors; they must not silently fall back to a stale local repo when a remote/free tab is active.

### First-wave implementation lane map

1. Add vocabulary/view-model adapters for active tab anchor, project path/repo binding, utility-rail state key, and last-session recall while reading old storage keys.
2. Make a copy-only pass on low-risk surfaces: add/connect flow, sidebar empty states, command palette placeholders/actions, and right-rail unavailable messages.
3. Defer full #473 right-rail/create-tab migration, #428 remote file RPC, and broad sidebar IA reshaping to their own implementation PRs.
4. Keep destructive git worktree actions and git/PR panels using git words where they are literal.

## Tab-first IA Status

Relay's product vocabulary is `View -> Workspace -> Project -> Instance -> Bench -> Tab`. The frontend should use those nouns for product IA and keep repo/worktree/session language for git/process-specific surfaces:

- **Implemented now:** session/file `WorkspaceTab` layout, optional session `nodeId`, node-aware terminal creation and PTY routing, active-tab-derived utility rail context, guarded rail states for remote and non-git tabs, six-layer identity helpers, persisted IA Workspace grouping, workspace topic APIs, and bounded CLI file RPC.
- **Compatibility still present:** the right rail follows active tab/session context, while App/sidebar/PR/dashboard/session creation still use `activeRepoPath`, `repoPath`, and `worktreePath` where the flow is git-specific or not yet lifted to product IA nouns.
- **Flag-gated tree surface:** `ViewSpineTree` renders `Workspace -> Project -> Instance -> Bench -> Tab` navigation with persisted workspace membership overlays and git-bench session launch affordances. See [View-Spine Tree](#view-spine-tree) below.
- **Still deferred:** repo-wide vocabulary/API renames, full non-git Project/Instance/Bench CRUD, environment inheritance, and any high-risk write/control UX not backed by current contracts and tests.
- **Documentation rule:** say "active tab" when describing the visible surface; say "repo/worktree" only for the current local repo Project/Bench case or legacy API fields.

### View-Spine Tree

The six-layer navigation surface is still flag-gated, but it is no longer just a read-only projection. It renders `Workspace -> Project -> Instance -> Bench -> Tab` over existing repo/session/node data plus persisted IA Workspace membership, and it exposes git-bench session launch affordances where the bench has a valid git anchor.

- **Flag:** `viewSpineEnabled` in `frontend/src/lib/stores/ui.ts`, backed by the localStorage key `relay-view-spine`, default `false`. Only the explicit value `'1'` reads as ON (a stale `'0'`/`'false'` reads OFF). Enable in dev with `localStorage.setItem('relay-view-spine', '1')` then reload; `setViewSpineEnabled`/`toggleViewSpineEnabled` are the store actions.
- **Render swap:** `Sidebar.tsx` mounts `<ViewSpineTree>` (`frontend/src/components/ViewSpineTree.tsx`) when the flag is ON. The OFF path is the default `TopicSidebarShell`; the old repo/worktree sidebar fallback was removed after the #1027 parity dogfood gate.
- **Derive adapter:** `frontend/src/lib/state/view-tree.ts` projects repos, worktrees, sessions, workspace groups, persisted IA Workspaces, and nodes into the six-layer tree. A repo becomes a **Project** keyed on git remote identity (directory fallback keyed on node + path); a node realization becomes an **Instance**; a worktree/cwd becomes a **Bench**; sessions surface as **Tabs**. Sessions with no `repoPath` render in a separate free/remote lane so repo identity and branch do not leak into non-git tabs.
- **View lenses:** the segmented control filters/reorders the tree for common operator views such as recent, all sessions, and this host.
- **"+ tab" on a git bench:** a git Bench shows a `+ tab` affordance that creates an agent session anchored to the bench's `(nodeId, repoPath, worktreePath)` via the existing node-aware `createAgentSession` create path. The affordance is withheld on non-git/directory benches, which have no `config.repos`-validated repo anchor.
- **Deferred:** environment inheritance, broad repo-wide API renames, and full non-git Project/Instance/Bench CRUD remain follow-up work unless the current route/client contract says otherwise.

## Component Map

| Component                               | Role                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `App.tsx`                               | Root layout: left sidebar + SplitPaneLayout hosting WorkspaceArea and WorkspaceUtilityRail for session view; dashboard / PR top bar + tabs for non-session views                                                         |
| `Sidebar.tsx`                           | Left-nav shell: renders the default `TopicSidebarShell`, or the preserved opt-in `ViewSpineTree` when `viewSpineEnabled` is ON                                                                                           |
| `ViewSpineTree.tsx`                     | Flag-gated six-layer tree surface: Project/Instance/Bench/Tab rows, persisted Workspace grouping overlay, free/remote lane, View lens selector, git-bench `+ tab`, and workspace assignment controls                     |
| `CommandPalette.tsx`                    | Terminal-style command palette with action registry                                                                                                                                                                      |
| `PrTopBar.tsx`                          | Dynamic PR/CI bar with branch switcher, target branch switcher, diff stats, merge conflict detection, action buttons                                                                                                     |
| `RepoDashboard.tsx`                     | Repo-bound dashboard: PRs with merge status, activity feed, CTAs; shown only when the selected workspace/repo is the active local context                                                                                |
| `BranchSwitcher.tsx`                    | Worktree-aware branch dropdown: filter, create new branch, jump-to-session links, agent-running guard                                                                                                                    |
| `TargetBranchSwitcher.tsx`              | PR base branch dropdown: remote-only branches, changes base via `gh pr edit`                                                                                                                                             |
| `FileBrowser.tsx`                       | Lazy-loading tree-view filesystem browser with multi-select, filter, keyboard nav                                                                                                                                        |
| `Terminal.tsx`                          | xterm.js terminal wrapper with WebSocket connection, escape sequence sanitization                                                                                                                                        |
| `Toolbar.tsx`                           | Mobile touch toolbar for terminal interaction                                                                                                                                                                            |
| `MobileInput.tsx`                       | Event-intent mobile keyboard input handler                                                                                                                                                                               |
| `ContextMenu.tsx`                       | Universal "..." dropdown menu for session/item actions                                                                                                                                                                   |
| `PinGate.tsx`                           | PIN authentication screen with PinInput component                                                                                                                                                                        |
| `SessionIndicator.tsx`                  | Unicode shape-based session state indicator (shapes + colors + pulse animations)                                                                                                                                         |
| `SessionStatusBar.tsx`                  | Multi-framework telemetry status bar (model, context %, tokens)                                                                                                                                                          |
| `AgentBadge.tsx`                        | Agent type indicator badge (Claude/Codex/OpenCode/Hermes, with fallback lettering for custom agents)                                                                                                                     |
| `WorkspaceUtilityRail.tsx`              | Tab-contextual right utility rail: fixed icon strip, selected pane host, state key, file resource path, git resource path, and repo badge                                                                                |
| `UtilityRailFilesPanel.tsx`             | Files utility pane wrapper around changed files and lazy filesystem browsing; local cwd can browse files, git fetches require git context                                                                                |
| `UtilityRailReviewPanel.tsx`            | Review utility pane: changed-file list, diff source controls, and embedded DiffViewer; repo/git-bound only                                                                                                               |
| `UtilityRailLogsPanel.tsx`              | Logs utility pane shell for current session/activity output                                                                                                                                                              |
| `UtilityRailStatsPanel.tsx`             | Stats utility pane using telemetry summaries for active session and workspace                                                                                                                                            |
| `FileTreeSidebar.tsx`                   | Reusable files panel implementation: changes tab (git diff tree), all files tab (lazy filesystem browser)                                                                                                                |
| `WorkspaceArea.tsx`                     | Tab layout host for session/terminal, code, diff, and HTML tabs with draggable panes; session tabs carry optional `nodeId`                                                                                               |
| `SplitPaneLayout.tsx`                   | Resizable layout wrapper for the workspace area and utility rail with draggable resize handles                                                                                                                           |
| `DiffViewer.tsx`                        | Unified diff renderer with diff2html parsing and Shiki syntax highlighting                                                                                                                                               |
| `CodeBlock.tsx`                         | Shared Shiki syntax highlighting wrapper component                                                                                                                                                                       |
| `OrgDashboard.tsx`                      | Cross-repo PR list and tickets panel with tab navigation                                                                                                                                                                 |
| `WorkspaceEvidenceDashboard.tsx`        | `evidence` tab body in `RepoDashboard`: capability-driven files/artifacts/sessions/surfaces sections over the #896 workspace-evidence contract; remounts per `repoPath` to prevent stale-repo leak                       |
| `WorkspaceEvidenceArtifactsSection.tsx` | #898 artifacts section: resolves WorkContext ids from `['active-work']`, queries `['work-context-artifacts', wcId]`, renders metadata-only cards (no artifact HTML/iframe), copy/export via #890 public-summary endpoint |
| `ArtifactFeedbackPanel.tsx`             | #898 per-artifact feedback: mints an `artifact-ref` context packet and queues it to a session inbox (artifact analogue of `FileFeedbackPanel`)                                                                           |
| `TicketsPanel.tsx`                      | Multi-provider ticket list: GitHub Issues, Jira, Linear tabs                                                                                                                                                             |
| `TicketCard.tsx`                        | Individual ticket row: status dot, provider metadata, branch link, Start Work button                                                                                                                                     |
| `StartWorkModal.tsx`                    | Start Work modal: ticket info, workspace selector, branch name input                                                                                                                                                     |
| `TuiButton.tsx`                         | TUI-styled button with box-drawing corner characters                                                                                                                                                                     |
| `TuiCheckbox.tsx`                       | Terminal-style `[x]`/`[ ]` checkbox component                                                                                                                                                                            |
| `TuiInput.tsx`                          | Terminal-style input with block cursor                                                                                                                                                                                   |
| `Tooltip.tsx`                           | Design-system hover/focus tooltip for controls; can resolve labels/descriptions/shortcuts from command registry action IDs                                                                                               |
| `MarqueeText.tsx`                       | Horizontal scroll-on-hover for overflow text (Spotify-style)                                                                                                                                                             |
| `CipherText.tsx`                        | Cipher-decode loading/transition animation                                                                                                                                                                               |
| `Hint.tsx`                              | Progressive disclosure onboarding hint component                                                                                                                                                                         |

| **Dialogs** | |
| `dialogs/DialogShell.tsx` | Shared dialog wrapper (fullscreen/compact, terminal aesthetic, popover-based stacking) |
| `dialogs/SettingsDialog.tsx` | Full settings dialog with TOC, sections, integrations |
| `dialogs/CustomizeSessionDialog.tsx` | Session creation/customization with agent selection, args, workspace |
| `dialogs/AddWorkspaceDialog.tsx` | Workspace path browser and add flow |
| `dialogs/DeleteWorktreeDialog.tsx` | Worktree deletion with dirty-check confirmation |
| `dialogs/RenameWarningModal.tsx` | Rename + PR warning: push, ignore, or undo |
| `dialogs/WorkspaceEditor.tsx` | Workspace entity editor: name, repo assignment, theme color |

### Workspace evidence tab (#897)

`RepoDashboard` exposes an `evidence` tab (alongside `overview` and `tickets`) that auto-renders for any selected workspace, git or not — the tab strip lives above the git gate, so free-directory/no-git workspaces still get it (and default to it). `WorkspaceEvidenceDashboard` resolves the workspace's filesystem root from `GET /workspace-evidence/roots` (client-side `repoPath`/`workspaceId` match) and renders each section independently from the root's capabilities/backing: a `files` section (tree + bounded preview) only when an `available` root advertises `list`; optional `repo`/`worktree`/`branch` decorations only when `root.repo`/`root.worktree` are present; a read-only `sessions` list from `['active-work']`; and placeholder `artifacts` and `surfaces` slots. Previews are read-only — there is no editor, save, or write path (`capabilities.write` is always `false`); `html-source`/`sandboxRequired` files map to an unsupported notice (no iframe sandbox this slice). #1004 adds the shared read-only `FileActionMenu` (copy relative/absolute path + copy the `relay-ide v1 files read` command) to the preview header, which stays write-free — the same primitive the editable code tab mounts (see _File editor surface_ below). `/preview` returns 200 with `preview.state` for oversized/binary/unsupported, so rendering switches on `preview.state`/`preview.kind` (via `mapPreviewToRenderKind`), not on query errors. The dashboard is a read-only client over the shared workspace-evidence contract: per #849, the web UI is one client over Relay action contracts, not the source of truth, and adds no browser-only action (no attach/kill/input on sessions).

Issue #898 fills the artifacts slot (`WorkspaceEvidenceArtifactsSection`): `resolveWorkContextIdsForRepo` (in `workspace-evidence-view.ts`) maps the workspace's `repoPath` to WorkContext ids off the same `['active-work']` query the sessions section reads (no extra fetch), capped at the first 5 contexts with a `+N more contexts` line. Per matched context it runs `['work-context-artifacts', wcId]` → `fetchPipelineHandoffArtifacts`, rendering one card per artifact that preserves kind, stage, work-context provenance, a private/public visibility badge, taskRef source, capturedAt, and short head/payload SHAs (full in `title`). Cards render METADATA + the bounded public `summary` text ONLY — never artifact-derived HTML, never an iframe, never raw payload bytes; copy/export reuses the #890 `copyPipelineHandoffArtifact` public-summary endpoint (`rawPayloadAvailable: false`). Empty states: zero matched contexts → `no work context bound to this workspace`; matched contexts with no artifacts → `no typed evidence refs yet`; per-context query error → an inline notice that does not crash sibling contexts. Each card carries an expandable `ArtifactFeedbackPanel` that mints an `artifact-ref` context packet (`{ artifactId, workContextId, payloadSha256, kind, title }`, `createdBy: 'relay-web'`) and queues it to the selected session via the #757 inbox primitives — the artifact analogue of `FileFeedbackPanel`.

### File editor surface (#338 / #997 / #1004)

The editable code tab mounts `CodeMirrorFileEditor` (CodeMirror 6) via `FileTabContent`'s `renderCode` slot, wired in `WorkspaceArea.FileTabContentBridge`. The editor binds line numbers, fold gutter, active-line/gutter highlight, `drawSelection`, lazy per-language syntax highlighting, history (undo/redo), `indentWithTab`, and an explicit `Mod-s` save; the toolbar shows a `saved`/`unsaved`/`saving` status pill and a stale-disk conflict bar (`reload disk version` vs `keep mine, overwrite`) backed by mtime/SHA concurrency on `PUT /workspaces/file-content` (see `useSaveFileContent`). The read-only render path is **not** forked: the editor's non-editable display, the main file tab, and the evidence preview all go through the shared `CodeBlock` (Shiki) and `DiffViewer` renderers — `test/components/file-surface-parity.test.ts` asserts both the file tab and the evidence preview render via `CodeBlock`/`FileActionMenu` so the surfaces cannot drift.

Issue #1004 factors the open-file affordances into shared primitives instead of per-surface forks:

- `lib/editor-affordances.ts` — the single honest source for editor shortcuts (`EDITOR_SHORTCUTS`, where not-yet-wired bindings such as in-file search carry `available: false` + a follow-up note rather than being claimed) and the `relay-ide v1 files read/write --json` command strings. The command builders render the gateway contract's own `cli` template (`commandSpec('files.read' | 'files.write')`), so the copy affordance can never drift from the shipped contract.
- `FileActionMenu.tsx` — one capability-parameterized action menu (reusing the `ContextMenu` "···" trigger) consumed by every file surface. Editable surfaces pass `editable` + save/reload/show-changes callbacks for the full set (save, reload from disk, show changes, copy relative/absolute path, copy `files read`/`files write` command); read-only surfaces (the evidence preview) omit them and get the copy-path + copy-`files read`-command subset. Keyboard-reachable: the trigger is a real `<button aria-haspopup>`, items are focusable (`tabindex=0`), Escape closes.
- `EditorShortcutHelp.tsx` — a `?` toolbar popover that renders `EDITOR_SHORTCUTS` verbatim (formatted per platform via `formatShortcut`), dimming + footnoting anything `available: false`.

Unavailable-state copy today: binary (`binary file — cannot display`) and oversize (`file too large to display inline`) short-circuit before the editor mounts; stale disk surfaces the conflict bar; over-cap saves and other write failures render in the toolbar `cm-file-editor__error`. Detecting a read-only file / missing write capability / offline node up front is a follow-up — the `file-content` read contract exposes no read-only/capability flag yet, so those currently surface only as a failed save.

Global-shortcut isolation: `setupShortcutListener` (`lib/actions/shortcuts.ts`) treats the editor's focused `contenteditable` host like an `<input>` (matching the sibling guard in `useAppShortcuts`), so non-global registry shortcuts (`mod+w`, `mod+shift+[ ]`) do not leak into the editor while typing, and the editor's own bindings stay scoped to the CodeMirror keymap rather than reaching the workspace. Covered by `test/actions/shortcuts.test.ts`.

## State Management

State is managed via Zustand stores and React hooks. Pure logic modules live under `frontend/src/lib/state/`. Server state (PRs, sessions) is managed via `@tanstack/react-query` v5.

### Pure Logic Modules (`frontend/src/lib/state/`)

| Module             | Role                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `display-state.ts` | Pure display state machine: `transitionDisplayState(current, event) -> newState`, `shouldNotify(from, to)` — 6 states: initializing, running, unseen-idle, seen-idle, permission, inactive                                                                                                                                                                                                                                      |
| `sidebar-items.ts` | Pure `buildSidebarItems()` function: maintains legacy `SidebarItem[]` reconciliation for session/unread state while the visible desktop left nav is `TopicSidebarShell` / `ViewSpineTree`                                                                                                                                                                                                                                       |
| `view-tree.ts`     | Pure, read-only view-spine derive (#444): `buildViewTree()` projects repos/worktrees/sessions/workspace-groups + `/nodes` status into a `Workspace -> Project -> Instance -> Bench` tree (Tab counts as leaves, dedup across nodes by repo remote, free/remote lane); `applyLens()` applies the recent/all/this-host lenses; `benchCreatePayload()` resolves the git-bench `+ tab` create payload. No persistence, no new fetch |
| `attention.ts`     | State priority scoring: `STATE_SCORES` mapping, `highestPriorityState()`, `isAttentionState()` for repo-level aggregation                                                                                                                                                                                                                                                                                                       |
| `unread-logic.ts`  | Unread/attention state transition logic                                                                                                                                                                                                                                                                                                                                                                                         |
| `toasts.store.ts`  | Toast notification state                                                                                                                                                                                                                                                                                                                                                                                                        |

### Hooks (`frontend/src/hooks/`)

| Hook                    | Role                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `useEventSocket.ts`     | WebSocket connection to `/ws/events` with auto-reconnect, heartbeat, event dispatch |
| `useSessionHandlers.ts` | Session CRUD operations, state transitions, PTY lifecycle                           |
| `useActionRegistry.ts`  | Action registry integration for CommandPalette                                      |

| `useAppShortcuts.ts` | Global keyboard shortcuts (Cmd+T, Cmd+K, etc.) |
| `useScrollOverflow.ts` | Detects text overflow for MarqueeText behavior |
| `useUrlNav.ts` | URL-based navigation state |
| `useOnboardingHints.tsx` | Progressive disclosure hint system |
| `useWhatsNew.tsx` | What's-new feature announcements |

### Action Registry (`frontend/src/lib/actions/`)

Typed action registry for the command palette. Actions are pure metadata (`ActionMeta`) defined in `definitions/` files, registered with handler closures in `App.tsx` via `registerGlobal()`. CommandPalette reads commands from the registry via `getAllActions()`. Labels and descriptions should use Tab/Project/Bench vocabulary unless an action is literally git/repo/worktree-specific.

Action-contract parity rule: the web UI is one client over Relay action contracts, not the source of truth for agent-operable product behavior. Stable agent-facing commands come from `shared/cli-gateway-contract.ts` -> `shared/relay-command-manifest.ts` -> `shared/action-descriptor.ts`; UI-only Command Center helpers must stay clearly marked as UI-only unless a stable command descriptor exists. The #857 inventory and #860 follow-up map live in [`docs/refactor/857-action-parity-inventory.md`](refactor/857-action-parity-inventory.md) and [`docs/refactor/860-action-contract-follow-up-map.md`](refactor/860-action-contract-follow-up-map.md).

The first converted launch path (#859) is `sessions.create`. `sessionCreateActionDescriptor()` projects the shared `sessions.create` command descriptor into web/Command Center metadata; `session.new-agent`, `session.new-terminal`, `session.start-on-repo`, and `session.start-work-in-env` attach that descriptor. Their typed input is the `sessions.create` / `CreateSessionBody` shape, their result/error is the normal v1 gateway envelope, and `sessionCreateActionAvailability()` carries missing-context, offline-node, and unsupported-capability reasons so browser and CLI callers fail consistently.

| Module                     | Role                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                 | `Action`, `ActionMeta`, `ActionContext`, `ActionCategory` type definitions                                             |
| `registry.ts`              | Pure Map-based registry — `registerGlobal`, `registerContextual`, `getAction`, `getAllActions`, `getActionsByCategory` |
| `session-create.ts`        | Shared web/CLI descriptor and execution bridge for the stable `sessions.create` launch action                          |
| `definitions/session.ts`   | Session actions (new-agent, new-terminal, close, kill, start-on-repo, start-on-ticket)                                 |
| `definitions/workspace.ts` | Workspace actions (add, new-worktree)                                                                                  |
| `definitions/pr.ts`        | PR/branch actions (create, push-branch, switch-branch)                                                                 |
| `definitions/settings.ts`  | Settings actions (open, connect-github, toggle-yolo, check-updates)                                                    |

## Conventions

- CSS modules or scoped styles per component; global CSS variables in `frontend/src/app.css`
- Sidebar session indicators driven by `SessionIndicator.tsx` with Unicode shape language: `●` running, `▶` idle, `◆◇` permission/needs-answer, `■` error, `─` inactive
- Display state machine enforces valid transitions — `seen-idle` can never become `unseen-idle` without going through `running` first. Backend emits single `session-backend-state-changed` event; frontend applies `transitionDisplayState()` to update indicators
- Loading state: tracked in component state; `setLoading`/`clearLoading` wrap async actions (start, kill, delete); sidebar/task-room launch rows render disabled/loading states without a duplicate repo-sidebar fallback
- Hover effects: MarqueeText for overflow text, scroll reveal animation
- All UI follows DESIGN.md: monospace fonts, lowercase labels, no emoji, outline-only buttons, 0px border-radius

## WebSocket Reconnection

- **Event socket** (`/ws/events`): auto-reconnect with fixed 3-second delay
- **PTY socket** (`/ws/:sessionId`): exponential backoff (1s, 2s, 4s, 8s, capped at 10s, max 30 attempts)
- Close code 1000 = session ended — no reconnect
- Before PTY reconnect, client verifies session still exists via `GET /sessions`
- `[Reconnecting...]` shown once to avoid terminal spam
- All event WebSocket connections must have both `close` and `error` handlers

## Key Patterns

- **Tab bar "+" dropdown** has three options: "New Agent" (instant create with workspace defaults via `createSession()`), "New Terminal" (instant create via `createSession()` with `type: 'terminal'`), "Customize..." (opens `CustomizeSessionDialog` which also calls `createSession()`). `Cmd/Ctrl+T` triggers instant agent creation. New tabs auto-name as "Agent 1", "Terminal 1" etc. and append rightmost
- All session/item actions are accessed via a "..." context menu button (ContextMenu component). Menu items vary by state: Active → Rename, Kill; Inactive worktree → Customize, Resume, Resume (YOLO), Delete; Idle repo → Customize, New Worktree
- "Customize" opens NewSessionDialog pre-filled with the item's workspace and branch (for worktrees). All session creation flows go through the single `createSession()` function → `POST /sessions`
- Topic and ViewSpine rows derive visible session labels from the session `displayName` first, then cwd/bench labels; git branch metadata appears only for verified git benches
- Session/action row secondary metadata should stay contextual: timestamps/activity, branch only when git-bound, and no repo badge/branch leak into free or remote tabs
- PRs tab uses `PrRepoGroup` components — each repo group independently fetches PRs via `@tanstack/react-query` `useQuery`
- Filters (root, repo, search) live below the tab bar
- PR click cascade: active session → inactive worktree → create new worktree + session
- Worktree naming convention: `mobile-<name>-<timestamp>`
- Settings dialog close triggers `refreshAll()` for immediate sidebar update
- All dialogs are built on `DialogShell.tsx` — use the `fullscreen` prop for the Settings modal and omit it for compact dialogs (AddWorkspace, CustomizeSession, DeleteWorktree). DialogShell uses `popover="manual"` + `showPopover()`/`hidePopover()` to guarantee top-layer stacking above xterm.js canvas elements (z-index alone is insufficient for canvas stacking contexts)
- Cookie TTL uses human-readable format: `s` (seconds), `m` (minutes), `h` (hours), `d` (days). Default: `24h`
- **Utility rail + tabs** — `SplitPaneLayout` wraps the active Tab view with `WorkspaceArea` (session/file/diff/html tabs) and `WorkspaceUtilityRail` (right, visible/hidden via the PR top-bar toggle). The rail has a fixed-width icon strip at the far right; the selected utility pane renders immediately to its left, and clicking the active icon clears the selected pane while keeping the icon strip. Utility rail state is currently persisted with legacy workspace/path keys in the UI store; migration code should preserve those keys while exposing a tab-anchor/state-key adapter. `openFileTab()`/`closeFileTab()` drive file tabs inside WorkspaceArea.
- **Cross-node terminal tabs (#443)** — `WorkspaceTab` session variant carries an optional `nodeId`. When set, `ws.ts` `connectPtySocket` routes via `/nodes/:nodeId/ws/sessions/:sessionId` (resolved through `parseGlobalSessionId` or `session.nodeId`). `WorkspaceTabBar` renders a per-tab node badge (label + heartbeat dot) sourced from `SummaryContext.findNode`, which `WorkspaceArea` populates from `useQuery(['hub-nodes'], fetchHubNodes)`. The tab-bar `+` button is replaced by `TerminalNodePicker` — a dropdown listing "this host" plus paired nodes; only `online` nodes are selectable. Choosing a node calls `createAgentSession({ type: 'terminal', nodeId })`; the layout reconciler picks the new session up via `sessions[]` → `sessionToWorkspaceTab` (which copies `session.nodeId` onto the tab).
- **Node identity in sidebar/session rows (#864)** — tab chrome and topic/view-spine rows should show remote node identity only when the row is anchored to a non-local node; local-node sessions stay quiet, remote sessions show label + heartbeat state without fabricating repo context.

### Entrypoint sweep for tab-first IA

Keep these entrypoints aligned when changing tab/session semantics:

- **Create-tab modal / customize flow:** `CustomizeSessionDialog` and `createAgentSession()` still use workspace/repo defaults for local repo sessions, while node-aware terminal creation can pass `nodeId` and route through `/hub/nodes/:nodeId/sessions`.
- **Tab-plus picker:** `WorkspaceTabBar` uses `TerminalNodePicker` for terminal creation. It lists `this host` plus paired nodes, disables non-online nodes. Remote file browsing is available for online nodes via `fs.list` (#428); remote git actions remain unavailable.
- **Command palette / action registry:** `useActionRegistry()` registers session/workspace/PR actions. Contextual actions may still depend on `workspacePath` / `activeRepoPath`; treat those as repo-bound actions, not global active-tab truth.
- **Restore/resume:** `useSessionHandlers()`, session restore, and worktree resume paths still prefer `repoPath` / `worktreePath`. Remote/global session identity uses `nodeId` / `globalSessionId` when present.
- **Sidebar / right rail:** Sidebar navigation is topic-first by default with ViewSpine as an opt-in IA tree; the right rail derives `stateKey`, anchor label, file resource path, and git resource path from active session context via `deriveUtilityRailContext()`.
- **Close/delete:** Session close can route through `killSession(id, nodeId)` for remote sessions. Worktree delete remains git-worktree-specific and should only appear for local repo Project/Bench rows.
- **Hooks/stores:** `useUiStore` still persists rail state by a string key; for remote tabs that key is `node:<nodeId>:<cwd>` (shipped via #479). `useSessionsStore` still has repo enrichment APIs; use them only when a repo binding is verified.

### Tab and rail states

| active tab state               | anchor shown                                                                                     | files panel                                                           | git/branch/review panels            | implementation status                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| local repo tab                 | `local · <repoPath or worktreePath>` plus `[repo]` badge                                         | local cwd file browser                                                | enabled when git context exists     | implemented current path                                                        |
| remote node tab, online        | `<nodeId> · <remote cwd>` with no repo badge unless a future verified remote repo binding exists | remote files via `fs.list` (#428)                                     | `remote git unavailable` until #428 | terminal + remote file browse implemented; remote git planned                   |
| free/non-git local tab         | `local · <cwd>` with no repo badge                                                               | local cwd file browser                                                | `no git context`                    | implemented by utility rail guards                                              |
| offline/stale remote tab       | `<nodeId> · <last known cwd>` plus node status in tab chrome                                     | no live remote browsing                                               | no live git actions                 | explicit offline copy is planned; current guards are generic unavailable states |
| missing cwd / no workspace ctx | `local` or node label only                                                                       | `no workspace context`                                                | `no workspace context`              | guard exists in `deriveUtilityRailContext()`                                    |
| cwd exists, no repo binding    | `<nodeId or local> · <cwd>` with no repo badge                                                   | local files when local; remote files via `fs.list` (#428) when online | no repo/git widgets                 | implemented for local free folders; remote file browse shipped (#428)           |

Right rail rules:

- Rail state follows the active Tab, not the last selected repo. Remote state keys include `nodeId + cwd` to avoid collisions between nodes with the same path.
- Resource paths are separate from the state key. A remote tab has a stable rail state key and a live file fetch path via `fs.list` (#428); git fetch paths remain unavailable until a verified remote repo binding is wired.
- Repo/git/branch/PR widgets render only with a verified repo binding (`repoPath`, `worktreePath`, or a future repo-kind Project/Bench binding).
- Workspace pins/grouping can power dashboards and watch lists, but they are not proof that the active tab is repo-bound.

- Root directory scanning: one level deep for git repos, hidden directories excluded

## Mobile Touch & Input

- Custom touch scroll replaces xterm.js built-in (smoother UX); handlers use `addEventListener({ passive: false })` on `document`
- Long-press (500ms) triggers mobile text-selection controls over the Relay terminal surface; do not document tmux copy-mode as the current selection substrate.
- `MobileInput` uses event-intent architecture: `beforeinput` captures intent, `input` dispatches to typed handlers (insert, delete, replacement, paste). Autocorrect at cursor-0 (iOS Safari bug) is recovered by sending backspaces + corrected text instead of reverting
- `visualViewport` API tracks keyboard state; layout adjusts dynamically (header hidden, terminal re-fit)
- xterm's internal `.xterm-helper-textarea` disabled on mobile to prevent focus fights with `MobileInput`
- Toolbar buttons use `mousedown` + `preventDefault()` to avoid keyboard dismissal
- Event-intent pipeline logic extracted to `shared/mobile-input-pipeline.ts` (pure functions, no DOM); tested via JSON fixtures in `test/fixtures/mobile-input/`. When fixing mobile keyboard bugs, add a fixture first (see `docs/QUALITY.md` Mobile Input Testing section)

## See Also

- [Architecture](ARCHITECTURE.md) — full data flow and API routes
- [Design](DESIGN.md) — backend patterns, auth flow, session types
