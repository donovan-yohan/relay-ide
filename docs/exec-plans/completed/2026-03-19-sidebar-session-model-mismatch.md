# Execution Plan: Sidebar Session Model — Folder-Centric

> **Status**: Active | **Created**: 2026-03-19
> **Source**: `docs/bug-analyses/2026-03-19-sidebar-session-model-mismatch-bug-analysis.md`
> **Branch**: `worktree-sidebar-session-model`

## Progress

- [x] Task 1: Group sidebar sessions by repoPath in Sidebar.svelte
- [x] Task 2: Add persistent repo root entry
- [x] Task 3: Show session count badge on multi-session folders in WorkspaceItem
- [x] Task 4: Build and verify

---

### Task 1: Group sidebar sessions by repoPath
**Files:** `frontend/src/components/Sidebar.svelte`
**What:** Instead of passing flat session list to WorkspaceItem, group sessions by `repoPath`. Each unique repoPath becomes one entry. WorkspaceItem gets a `groupedSessions` map instead of a flat list.
**Fix:** In Sidebar.svelte, transform `activeSessions` into a Map<repoPath, SessionSummary[]>. For each repoPath group, create one sidebar entry using the most recent session as the "representative". Multiple sessions within the same path are tabs, not rows.

### Task 2: Add persistent repo root entry
**Files:** `frontend/src/components/Sidebar.svelte`, `frontend/src/components/WorkspaceItem.svelte`
**What:** The main repo folder (workspace.path) should always appear as the first sidebar entry even when no sessions exist. Currently it vanishes when all sessions are killed.
**Fix:** In the grouping logic, always include workspace.path as a group key. If no sessions exist for it, show it as "inactive" (like an inactive worktree). Clicking it navigates to the dashboard or creates a new session.

### Task 3: Session count badge on multi-session folders
**Files:** `frontend/src/components/WorkspaceItem.svelte`
**What:** When a folder has multiple sessions/tabs, show a count badge (e.g. `[3]`) on the sidebar row.
**Fix:** In WorkspaceItem, for each folder group with >1 session, render a small count badge next to the display name.

### Task 4: Build and verify
**What:** Run `npm run build` and `npm test` to verify changes compile and all tests pass.
