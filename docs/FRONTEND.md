# Frontend

React 19 SPA for Relay IDE. Built with TypeScript, Zustand, TanStack Query, and Vite. The frontend provides terminal access, session management, and real-time worktree monitoring.

## Current State

- React 19 with hooks, Zustand 5 for state management, TanStack React Query 5 for server state — TypeScript throughout
- Vite builds `frontend/` to `dist/frontend/`; Express serves compiled output
- xterm.js consumed as npm dependency (`@xterm/xterm`, `@xterm/addon-fit`); it remains the browser renderer while tmux owns the server-side session/process substrate
- Mobile-first responsive design with touch toolbar (hidden on desktop)

## Component Map

| Component                            | Role                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `App.tsx`                            | Root layout: left sidebar + SplitPaneLayout hosting WorkspaceArea and WorkspaceUtilityRail for session view; dashboard / PR top bar + tabs for non-session views |
| `Sidebar.tsx`                        | Flat workspace list with command palette search                                                                                                                      |
| `RepoItem.tsx`                       | Repo tree item: sessions, inactive worktrees, context menus, workspace group membership                                                                              |
| `CommandPalette.tsx`                 | Terminal-style command palette with action registry                                                                                                                  |
| `PrTopBar.tsx`                       | Dynamic PR/CI bar with branch switcher, target branch switcher, diff stats, merge conflict detection, action buttons                                                 |
| `RepoDashboard.tsx`                  | Workspace dashboard: PRs with merge status, activity feed, CTAs                                                                                                      |
| `BranchSwitcher.tsx`                 | Worktree-aware branch dropdown: filter, create new branch, jump-to-session links, agent-running guard                                                                |
| `TargetBranchSwitcher.tsx`           | PR base branch dropdown: remote-only branches, changes base via `gh pr edit`                                                                                         |
| `FileBrowser.tsx`                    | Lazy-loading tree-view filesystem browser with multi-select, filter, keyboard nav                                                                                    |
| `Terminal.tsx`                       | xterm.js terminal wrapper with WebSocket connection, escape sequence sanitization                                                                                    |
| `Toolbar.tsx`                        | Mobile touch toolbar for terminal interaction                                                                                                                        |
| `MobileInput.tsx`                    | Event-intent mobile keyboard input handler                                                                                                                           |
| `ContextMenu.tsx`                    | Universal "..." dropdown menu for session/item actions                                                                                                               |
| `PinGate.tsx`                        | PIN authentication screen with PinInput component                                                                                                                    |
| `SessionIndicator.tsx`               | Unicode shape-based session state indicator (shapes + colors + pulse animations)                                                                                     |
| `SessionStatusBar.tsx`               | Multi-framework telemetry status bar (model, context %, tokens)                                                                                                      |
| `AgentBadge.tsx`                     | Agent type indicator badge (Claude/Codex/OpenCode)                                                                                                                   |
| `WorkspaceUtilityRail.tsx`           | Right utility rail: fixed icon strip, selected utility pane host, visible/hidden shell model                                                                         |
| `UtilityRailFilesPanel.tsx`          | Files utility pane wrapper around changed files and lazy filesystem browsing                                                                                         |
| `UtilityRailReviewPanel.tsx`         | Review utility pane: changed-file list, diff source controls, and embedded DiffViewer                                                                                |
| `UtilityRailLogsPanel.tsx`           | Logs utility pane shell for current session/activity output                                                                                                          |
| `UtilityRailStatsPanel.tsx`          | Stats utility pane using telemetry summaries for active session and workspace                                                                                        |
| `FileTreeSidebar.tsx`                | Reusable files panel implementation: changes tab (git diff tree), all files tab (lazy filesystem browser)                                                            |
| `WorkspaceArea.tsx`                  | Workspace tab layout host for session, terminal, code, diff, and HTML tabs with draggable panes                                                                      |
| `SplitPaneLayout.tsx`                | Resizable layout wrapper for the workspace area and utility rail with draggable resize handles                                                                        |
| `DiffViewer.tsx`                     | Unified diff renderer with diff2html parsing and Shiki syntax highlighting                                                                                           |
| `CodeBlock.tsx`                      | Shared Shiki syntax highlighting wrapper component                                                                                                                   |
| `OrgDashboard.tsx`                   | Cross-repo PR list and tickets panel with tab navigation                                                                                                             |
| `TicketsPanel.tsx`                   | Multi-provider ticket list: GitHub Issues, Jira, Linear tabs                                                                                                         |
| `TicketCard.tsx`                     | Individual ticket row: status dot, provider metadata, branch link, Start Work button                                                                                 |
| `StartWorkModal.tsx`                 | Start Work modal: ticket info, workspace selector, branch name input                                                                                                 |
| `TuiButton.tsx`                      | TUI-styled button with box-drawing corner characters                                                                                                                 |
| `TuiCheckbox.tsx`                    | Terminal-style `[x]`/`[ ]` checkbox component                                                                                                                        |
| `TuiInput.tsx`                       | Terminal-style input with block cursor                                                                                                                               |
| `Tooltip.tsx`                        | Design-system hover/focus tooltip for controls; can resolve labels/descriptions/shortcuts from command registry action IDs                                           |
| `MarqueeText.tsx`                    | Horizontal scroll-on-hover for overflow text (Spotify-style)                                                                                                         |
| `CipherText.tsx`                     | Cipher-decode loading/transition animation                                                                                                                           |
| `Hint.tsx`                           | Progressive disclosure onboarding hint component                                                                                                                     |
| `WorkspaceGroup.tsx`                 | Workspace container with color-coded border grouping                                                                                                                 |
| **Dialogs**                          |                                                                                                                                                                      |
| `dialogs/DialogShell.tsx`            | Shared dialog wrapper (fullscreen/compact, terminal aesthetic, popover-based stacking)                                                                               |
| `dialogs/SettingsDialog.tsx`         | Full settings dialog with TOC, sections, integrations                                                                                                                |
| `dialogs/CustomizeSessionDialog.tsx` | Session creation/customization with agent selection, args, workspace                                                                                                 |
| `dialogs/AddWorkspaceDialog.tsx`     | Workspace path browser and add flow                                                                                                                                  |
| `dialogs/DeleteWorktreeDialog.tsx`   | Worktree deletion with dirty-check confirmation                                                                                                                      |
| `dialogs/RenameWarningModal.tsx`     | Rename + PR warning: push, ignore, or undo                                                                                                                           |
| `dialogs/WorkspaceEditor.tsx`        | Workspace entity editor: name, repo assignment, theme color                                                                                                          |

## State Management

State is managed via Zustand stores and React hooks. Pure logic modules live under `frontend/src/lib/state/`. Server state (PRs, sessions) is managed via `@tanstack/react-query` v5.

### Pure Logic Modules (`frontend/src/lib/state/`)

| Module             | Role                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `display-state.ts` | Pure display state machine: `transitionDisplayState(current, event) -> newState`, `shouldNotify(from, to)` — 6 states: initializing, running, unseen-idle, seen-idle, permission, inactive |
| `sidebar-items.ts` | Pure `buildSidebarItems()` function: merges sessions + worktrees + workspaces into `SidebarItem[]` with reconciliation                                                                     |
| `attention.ts`     | State priority scoring: `STATE_SCORES` mapping, `highestPriorityState()`, `isAttentionState()` for repo-level aggregation                                                                  |
| `unread-logic.ts`  | Unread/attention state transition logic                                                                                                                                                    |
| `toasts.store.ts`  | Toast notification state                                                                                                                                                                   |

### Hooks (`frontend/src/hooks/`)

| Hook                     | Role                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `useEventSocket.ts`      | WebSocket connection to `/ws/events` with auto-reconnect, heartbeat, event dispatch |
| `useSessionHandlers.ts`  | Session CRUD operations, state transitions, PTY lifecycle                           |
| `useActionRegistry.ts`   | Action registry integration for CommandPalette                                      |
| `useRepoAggregation.ts`  | Aggregates session states per repo for sidebar indicators                           |
| `useAppShortcuts.ts`     | Global keyboard shortcuts (Cmd+T, Cmd+K, etc.)                                      |
| `useScrollOverflow.ts`   | Detects text overflow for MarqueeText behavior                                      |
| `useUrlNav.ts`           | URL-based navigation state                                                          |
| `useOnboardingHints.tsx` | Progressive disclosure hint system                                                  |
| `useWhatsNew.tsx`        | What's-new feature announcements                                                    |

### Action Registry (`frontend/src/lib/actions/`)

Typed action registry for the command palette. Actions are pure metadata (`ActionMeta`) defined in `definitions/` files, registered with handler closures in `App.tsx` via `registerGlobal()`. CommandPalette reads commands from the registry via `getAllActions()`.

| Module                     | Role                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                 | `Action`, `ActionMeta`, `ActionContext`, `ActionCategory` type definitions                                             |
| `registry.ts`              | Pure Map-based registry — `registerGlobal`, `registerContextual`, `getAction`, `getAllActions`, `getActionsByCategory` |
| `definitions/session.ts`   | Session actions (new-agent, new-terminal, close, kill, start-on-repo, start-on-ticket)                                 |
| `definitions/workspace.ts` | Workspace actions (add, new-worktree)                                                                                  |
| `definitions/pr.ts`        | PR/branch actions (create, push-branch, switch-branch)                                                                 |
| `definitions/settings.ts`  | Settings actions (open, connect-github, toggle-yolo, check-updates)                                                    |

## Conventions

- CSS modules or scoped styles per component; global CSS variables in `frontend/src/app.css`
- Sidebar session indicators driven by `SessionIndicator.tsx` with Unicode shape language: `●` running, `▶` idle, `◆◇` permission/needs-answer, `■` error, `─` inactive
- Display state machine enforces valid transitions — `seen-idle` can never become `unseen-idle` without going through `running` first. Backend emits single `session-backend-state-changed` event; frontend applies `transitionDisplayState()` to update indicators
- Loading state: tracked in component state; `setLoading`/`clearLoading` wrap async actions (start, kill, delete); RepoItem shows CSS shimmer overlay with `pointer-events: none`
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
- Repo root items always display "default" as their name (unless the user has explicitly renamed the active session). Both active and idle repo entries in `RepoItem.tsx` enforce this
- Session item secondary row order: timestamp → branch name → PR number → context menu (right-aligned via `.context-menu-spacer`). This applies to active sessions and inactive worktrees. Idle-repo entries show only the default branch name (no timestamp or PR). Diff stats appear in the primary row
- PRs tab uses `PrRepoGroup` components — each repo group independently fetches PRs via `@tanstack/react-query` `useQuery`
- Filters (root, repo, search) live below the tab bar
- PR click cascade: active session → inactive worktree → create new worktree + session
- Worktree naming convention: `mobile-<name>-<timestamp>`
- Settings dialog close triggers `refreshAll()` for immediate sidebar update
- All dialogs are built on `DialogShell.tsx` — use the `fullscreen` prop for the Settings modal and omit it for compact dialogs (AddWorkspace, CustomizeSession, DeleteWorktree). DialogShell uses `popover="manual"` + `showPopover()`/`hidePopover()` to guarantee top-layer stacking above xterm.js canvas elements (z-index alone is insufficient for canvas stacking contexts)
- Cookie TTL uses human-readable format: `s` (seconds), `m` (minutes), `h` (hours), `d` (days). Default: `24h`
- **Utility rail + workspace tabs** — `SplitPaneLayout` wraps the session view with `WorkspaceArea` (session/file/diff/html tabs) and `WorkspaceUtilityRail` (right, visible/hidden via the PR top-bar toggle). The rail has a fixed-width icon strip at the far right; the selected utility pane renders immediately to its left, and clicking the active icon clears the selected pane while keeping the icon strip. Utility rail state is persisted per workspace path in the UI store; `openFileTab()`/`closeFileTab()` drive file tabs inside WorkspaceArea.
- Root directory scanning: one level deep for git repos, hidden directories excluded

## Mobile Touch & Input

- Custom touch scroll replaces xterm.js built-in (smoother UX); handlers use `addEventListener({ passive: false })` on `document`
- Long-press (500ms) triggers text selection by entering tmux copy-mode (vi bindings, toolbar buttons for navigation)
- `MobileInput` uses event-intent architecture: `beforeinput` captures intent, `input` dispatches to typed handlers (insert, delete, replacement, paste). Autocorrect at cursor-0 (iOS Safari bug) is recovered by sending backspaces + corrected text instead of reverting
- `visualViewport` API tracks keyboard state; layout adjusts dynamically (header hidden, terminal re-fit)
- xterm's internal `.xterm-helper-textarea` disabled on mobile to prevent focus fights with `MobileInput`
- Toolbar buttons use `mousedown` + `preventDefault()` to avoid keyboard dismissal
- Event-intent pipeline logic extracted to `shared/mobile-input-pipeline.ts` (pure functions, no DOM); tested via JSON fixtures in `test/fixtures/mobile-input/`. When fixing mobile keyboard bugs, add a fixture first (see `docs/QUALITY.md` Mobile Input Testing section)

## See Also

- [Architecture](ARCHITECTURE.md) — full data flow and API routes
- [Design](DESIGN.md) — backend patterns, auth flow, session types
