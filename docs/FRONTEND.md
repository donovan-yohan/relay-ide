# Frontend

Svelte 5 SPA for claude-remote-cli. Built with runes syntax, TypeScript, and Vite. The frontend provides terminal access, session management, and real-time worktree monitoring.

## Current State

- Svelte 5 with runes (`$state`, `$derived`, `$effect`, `$props()`) — TypeScript throughout
- Vite builds `frontend/` to `dist/frontend/`; Express serves compiled output
- xterm.js consumed as npm dependency (`@xterm/xterm`, `@xterm/addon-fit`)
- Mobile-first responsive design with touch toolbar (hidden on desktop)

## Component Map

| Component | Role |
|-----------|------|
| `App.svelte` | Root layout: sidebar + main area (dashboard / PR top bar + tabs + terminal) |
| `Sidebar.svelte` | Flat workspace list with smart search, no tabs |
| `WorkspaceItem.svelte` | Workspace tree item: letter icon, sessions, inactive worktrees, context menus |
| `SmartSearch.svelte` | Terminal-style typeahead search with `>` prompt |
| `PrTopBar.svelte` | Dynamic PR/CI bar with branch switcher, target branch switcher, hover-reveal icons (copy/rename), inline rename flow, diff stats, merge conflict detection, dual action buttons (resolve+review), archive flow |
| `SessionTabBar.svelte` | Multi-tab session management per worktree (role=tablist) |
| `RepoDashboard.svelte` | Workspace dashboard: PRs with merge status, activity feed, CTAs |
| `BranchSwitcher.svelte` | Worktree-aware branch dropdown: filter, create new branch, strikethrough for checked-out branches, jump-to-session links, agent-running guard |
| `TargetBranchSwitcher.svelte` | PR base branch dropdown: remote-only branches, changes base via `gh pr edit` |
| `FileBrowser.svelte` | Lazy-loading tree-view filesystem browser with multi-select, filter, keyboard nav |
| `EmptyState.svelte` | Reusable empty state with icon, heading, description, CTA |
| `Terminal.svelte` | xterm.js terminal wrapper with WebSocket connection |
| `Toolbar.svelte` | Mobile touch toolbar for terminal interaction |
| `MobileHeader.svelte` | Mobile header with session info |
| `ContextMenu.svelte` | Universal "..." dropdown menu for session/item actions |
| `PinGate.svelte` | PIN authentication screen |
| `ImageToast.svelte` | Clipboard image paste feedback |
| `UpdateToast.svelte` | Version update notification |
| `AgentBadge.svelte` | Agent type indicator badge (Claude/Codex) |
| `SearchableSelect.svelte` | Searchable dropdown filter replacing native selects |
| `SessionItem.svelte` | Session list item with status dot, context menu, metadata row |
| `MobileInput.svelte` | Event-intent mobile keyboard input handler |
| `ChangedFiles.svelte` | Collapsible changed files panel below terminal with inline diff expansion, DataTable integration, mobile card layout |
| `DiffViewer.svelte` | Unified diff renderer with diff2html parsing and Shiki syntax highlighting |
| `CodeBlock.svelte` | Shared Shiki syntax highlighting wrapper component |
| `OrgDashboard.svelte` | Cross-repo PR list and tickets panel with tab navigation |
| `TicketsPanel.svelte` | Multi-provider ticket list: GitHub Issues, Jira, Linear tabs with skeleton loading and branch link indicators |
| `TicketCard.svelte` | Individual ticket row: status dot, provider-native metadata (labels/sprint/cycle/priority), branch link, Start Work button |
| `StartWorkModal.svelte` | Start Work modal: ticket info, workspace selector (for Jira/Linear), branch name input, creates worktree session with ticket context |
| `StatusMappingModal.svelte` | Map workflow transition states (in-progress, code-review, ready-for-qa) to Jira transition IDs / Linear status IDs |
| `dialogs/DialogShell.svelte` | Shared dialog wrapper (fullscreen/compact variants, terminal aesthetic, shared button/form CSS) |
| `dialogs/SettingRow.svelte` | Consistent setting row (name, description, action slot) |
| `dialogs/SettingsToc.svelte` | Settings TOC drawer with IntersectionObserver scroll tracking |
| `dialogs/integrations/GitHubIntegration.svelte` | GitHub OAuth App connection panel within SettingsDialog |
| `dialogs/integrations/WebhookIntegration.svelte` | GitHub webhook CRUD and smee proxy panel within SettingsDialog |
| `dialogs/integrations/JiraIntegration.svelte` | Jira connection and project config panel within SettingsDialog |
| `dialogs/RenameWarningModal.svelte` | Rename + PR warning: push renamed branch, ignore, or undo rename |
| `dialogs/WorkspaceEditor.svelte` | Workspace entity editor: name, repo assignment, theme color palette, delete — used in SettingsDialog workspaces section |
| `dialogs/` | Session customization, settings, workspace, and worktree deletion dialogs |

## State Management

State lives in `.svelte.ts` modules under `frontend/src/lib/state/` exporting reactive state and mutation functions. Components import state — they do not own it. PR data is managed via `@tanstack/svelte-query` v6 (cache + manual refresh), not in state modules.

| Module | Role |
|--------|------|
| `sessions.svelte.ts` | Session list, worktrees, repos (`Repo[]`), `SidebarItem[]` with display state machine, notification preferences, loading state; `getSessionsForRepo()` helper |
| `display-state.ts` | Pure display state machine: `transitionDisplayState(current, event) → newState`, `shouldNotify(from, to)` — 6 states: `initializing \| running \| unseen-idle \| seen-idle \| permission \| inactive` |
| `sidebar-items.ts` | Pure `buildSidebarItems()` function: merges sessions + worktrees + workspaces into `SidebarItem[]` with reconciliation |
| `config.svelte.ts` | Global session defaults (continue, yolo, tmux, agent, notifications); shared by SettingsDialog, SessionList, NewSessionDialog |
| `auth.svelte.ts` | Authentication state (PIN check, cookie token) |
| `ui.svelte.ts` | UI state (active tab, sidebar, filters) |
| `shiki.ts` | Shiki highlighter singleton, custom TUI theme, language detection, lazy grammar loading |
| `diff-summary.ts` | Rule-based smart diff summaries (v1): function detection, hunk analysis, fallback +N/-N |

### Action Registry (`frontend/src/lib/actions/`)

Typed action registry for the command palette. Actions are pure metadata (`ActionMeta`) defined in `definitions/` files, registered with handler closures in `App.svelte` via `registerGlobal()`. CommandPalette reads commands from the registry via `getAllActions()`.

| Module | Role |
|--------|------|
| `types.ts` | `Action`, `ActionMeta`, `ActionContext`, `ActionCategory` type definitions |
| `registry.ts` | Pure Map-based registry — `registerGlobal`, `registerContextual`, `getAction`, `getAllActions`, `getActionsByCategory`. Testable with node:test |
| `registry.svelte.ts` | Thin Svelte 5 wrapper — `$state` version counter for reactive invalidation |
| `definitions/session.ts` | Session actions (new-agent, new-terminal, close, kill, start-on-repo, start-on-ticket) |
| `definitions/workspace.ts` | Workspace actions (add, new-worktree) |
| `definitions/pr.ts` | PR/branch actions (create, push-branch, switch-branch) |
| `definitions/settings.ts` | Settings actions (open, connect-github, toggle-yolo, check-updates) |

## Conventions

- Scoped `<style>` blocks in each component; global CSS variables in `frontend/src/app.css`
- Sidebar status dots driven by `SidebarItem.displayState`: green (`running`), blue (`seen-idle`), amber glow (`unseen-idle`), yellow pulse (`permission`), gray (`inactive`/`initializing`)
- Display state machine enforces valid transitions — `seen-idle` can never become `unseen-idle` without going through `running` first. Backend emits single `session-backend-state-changed` event; frontend applies `transitionDisplayState()` to update dots
- Loading state: tracked in `loadingItems` reactive state; `setLoading`/`clearLoading` wrap async actions (start, kill, delete); WorkspaceItem shows CSS shimmer overlay with `pointer-events: none`
- Hover effects: fade mask on overflow text, scroll reveal animation
- Avoid naming local variables `state` in `.svelte` files — conflicts with `$state` rune
- `bind:this` refs used in `$effect` must be declared with `$state()` — plain `let` refs won't trigger effect re-runs in Svelte 5

## WebSocket Reconnection

- **Event socket** (`/ws/events`): auto-reconnect with fixed 3-second delay
- **PTY socket** (`/ws/:sessionId`): exponential backoff (1s, 2s, 4s, 8s, capped at 10s, max 30 attempts)
- **SDK socket** (`/ws/:sessionId`): separate reconnect counter from PTY; exponential backoff
- Close code 1000 = session ended — no reconnect
- Before PTY reconnect, client verifies session still exists via `GET /sessions`
- `[Reconnecting...]` shown once to avoid terminal spam
- All event WebSocket connections must have both `close` and `error` handlers
- SDK reconnect replays stored events from server on reconnection

## Key Patterns

- **Tab bar "+" dropdown** has three options: "New Agent" (instant create with workspace defaults via `createSession()`), "New Terminal" (instant create via `createSession()` with `type: 'terminal'`), "Customize..." (opens `CustomizeSessionDialog` which also calls `createSession()`). `Cmd/Ctrl+T` triggers instant agent creation. New tabs auto-name as "Agent 1", "Terminal 1" etc. and append rightmost
- All session/item actions are accessed via a "..." context menu button (ContextMenu component). Menu items vary by state: Active → Rename, Kill; Inactive worktree → Customize, Resume, Resume (YOLO), Delete; Idle repo → Customize, New Worktree
- "Customize" opens NewSessionDialog pre-filled with the item's workspace and branch (for worktrees). All session creation flows go through the single `createSession()` function → `POST /sessions`
- Repo root items always display "default" as their name (unless the user has explicitly renamed the active session). Both active and idle repo entries in `WorkspaceItem.svelte` enforce this
- Session item secondary row order: timestamp → branch name → PR number → context menu (right-aligned via `.context-menu-spacer`). This applies to active sessions and inactive worktrees. Idle-repo entries show only the default branch name (no timestamp or PR). Diff stats appear in the primary row
- PRs tab uses `PrRepoGroup` components — each repo group independently fetches PRs via `@tanstack/svelte-query` `createQuery` with `Accessor` pattern: `createQuery<T>(() => ({...}))` — the options must be wrapped in a function for Svelte 5 runes reactivity
- Filters (root, repo, search) live below the tab bar
- PR click cascade: active session → inactive worktree → create new worktree + session
- Worktree naming convention: `mobile-<name>-<timestamp>`
- Settings dialog close triggers `refreshAll()` for immediate sidebar update
- All dialogs are built on `DialogShell.svelte` — use the `fullscreen` prop for the Settings modal and omit it for compact dialogs (AddWorkspace, CustomizeSession, DeleteWorktree). DialogShell uses `popover="manual"` + `showPopover()`/`hidePopover()` to guarantee top-layer stacking above xterm.js canvas elements (z-index alone is insufficient for canvas stacking contexts)
- Cookie TTL uses human-readable format: `s` (seconds), `m` (minutes), `h` (hours), `d` (days). Default: `24h`
- Root directory scanning: one level deep for git repos, hidden directories excluded

## Mobile Touch & Input

- Custom touch scroll replaces xterm.js built-in (smoother UX); handlers use `addEventListener({ passive: false })` on `document`
- Long-press (500ms) triggers text selection: tmux sessions enter copy-mode (vi bindings, toolbar buttons for navigation); non-tmux sessions use browser-native selection with copy-on-tap
- `MobileInput` uses event-intent architecture: `beforeinput` captures intent, `input` dispatches to typed handlers (insert, delete, replacement, paste). Autocorrect at cursor-0 (iOS Safari bug) is recovered by sending backspaces + corrected text instead of reverting
- `visualViewport` API tracks keyboard state; layout adjusts dynamically (header hidden, terminal re-fit)
- xterm's internal `.xterm-helper-textarea` disabled on mobile to prevent focus fights with `MobileInput`
- Toolbar buttons use `mousedown` + `preventDefault()` to avoid keyboard dismissal
- Event-intent pipeline logic extracted to `server/mobile-input-pipeline.ts` (pure functions, no DOM); tested via JSON fixtures in `test/fixtures/mobile-input/`. When fixing mobile keyboard bugs, add a fixture first (see `docs/QUALITY.md` Mobile Input Testing section)

## See Also

- [Architecture](ARCHITECTURE.md) — full data flow and API routes
- [Design](DESIGN.md) — backend patterns, auth flow, session types
