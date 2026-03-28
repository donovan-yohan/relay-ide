# Execution Plan: Enriched Sidebar Session Rows

> **Status**: Active | **Created**: 2026-03-19
> **Source**: `docs/design-docs/2026-03-19-enriched-sidebar-sessions-design.md`
> **Branch**: `worktree-enriched-sidebar-sessions`

## Progress

- [x] Task 1: Add SessionMeta type + getWorkingTreeDiff to server
- [x] Task 2: Add session meta cache + API endpoints in server
- [x] Task 3: Add formatRelativeTimeCompact + time tick to frontend utils/ui
- [x] Task 4: Add collapsible workspaces to ui state
- [x] Task 5: Add frontend API + session state for meta
- [x] Task 6: Enrich WorkspaceItem with two-line rows, collapse, diff, time
- [x] Task 7: Wire App.svelte to refresh meta on session select

---

### Task 1: Add SessionMeta type + getWorkingTreeDiff
**Files:** `server/types.ts`, `server/git.ts`
**What:** Add SessionMeta interface to types. Add `getWorkingTreeDiff(repoPath)` to git.ts that runs `git diff --shortstat` and parses additions/deletions.

### Task 2: Add session meta cache + API endpoints
**Files:** `server/sessions.ts`, `server/index.ts`
**What:** Add in-memory `Map<string, SessionMeta>` cache. Add `getSessionMeta(id)` and `getAllSessionMeta()`. New routes: `GET /sessions/meta` (bulk), `GET /sessions/:id/meta` (individual with optional `?refresh=true`).

### Task 3: Add formatRelativeTimeCompact + time tick
**Files:** `frontend/src/lib/utils.ts`, `frontend/src/lib/state/ui.svelte.ts`
**What:** Add compact time format function. Add 30-second tick counter in ui state for reactive time display.

### Task 4: Add collapsible workspaces to ui state
**Files:** `frontend/src/lib/state/ui.svelte.ts`
**What:** Add `collapsedWorkspaces` Set with localStorage persistence. Export `toggleWorkspaceCollapse` and `isWorkspaceCollapsed`.

### Task 5: Add frontend API + session state for meta
**Files:** `frontend/src/lib/api.ts`, `frontend/src/lib/state/sessions.svelte.ts`, `frontend/src/lib/types.ts`
**What:** Add `SessionMeta` type to frontend types. Add `fetchAllSessionMeta()` and `fetchSessionMeta(id, refresh?)` to api.ts. Add `sessionMeta` map to sessions state, populated in `refreshAll()`.

### Task 6: Enrich WorkspaceItem with two-line rows
**Files:** `frontend/src/components/WorkspaceItem.svelte`
**What:** Two-line session/worktree rows (display name + diff stats on line 1, worktree name + PR# + time on line 2). Collapsible workspace sections with chevron. Import meta/collapse/time from state.

### Task 7: Wire App.svelte meta refresh on session select
**Files:** `frontend/src/App.svelte`
**What:** Call `fetchSessionMeta(id, { refresh: true })` in `handleSelectSession` after setting active session ID.
