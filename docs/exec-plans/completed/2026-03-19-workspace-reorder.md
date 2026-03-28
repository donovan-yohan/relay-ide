# Execution Plan: Workspace Reorder & Sidebar Polish

> **Status**: Active | **Created**: 2026-03-19
> **Source**: `docs/design-docs/2026-03-19-workspace-reorder-design.md`
> **Branch**: `kilimanjaro`

## Progress

- [x] Task 1: Add PUT /workspaces/reorder backend endpoint
- [x] Task 2: Add reorderWorkspaces API call to frontend
- [x] Task 3: Add reorderMode state to ui.svelte.ts
- [x] Task 4: Install svelte-dnd-action and update Sidebar.svelte with drag-and-drop
- [x] Task 5: Simplify WorkspaceItem header (remove + and >_ buttons) and add grip handle
- [x] Task 6: Add mobile reorder mode (long-press, floating Done button, content collapse)
- [x] Task 7: Fix inactive session contrast styling

---

### Task 1: Add PUT /workspaces/reorder backend endpoint
**Files:** `server/workspaces.ts`
**What:** Add `PUT /workspaces/reorder` route. Accepts `{ paths: string[] }`. Validates that request paths are the same set as current `config.workspaces` (same length, same elements). Updates `config.workspaces` to the new order and calls `saveConfig()`. Returns `{ workspaces: Workspace[] }` with full metadata (same format as GET /workspaces).

### Task 2: Add reorderWorkspaces API call to frontend
**Files:** `frontend/src/lib/api.ts`, `frontend/src/lib/state/sessions.svelte.ts`
**What:** Add `reorderWorkspaces(paths: string[])` to api.ts that calls `PUT /workspaces/reorder`. In sessions.svelte.ts, add a `reorderWorkspaces(paths: string[])` function that calls the API and updates `workspaces` state array to match the new order.

### Task 3: Add reorderMode state to ui.svelte.ts
**Files:** `frontend/src/lib/state/ui.svelte.ts`
**What:** Add `reorderMode` boolean to the ui state (default false). Export `enterReorderMode()` and `exitReorderMode()` functions. `enterReorderMode` sets `reorderMode = true`. `exitReorderMode` sets `reorderMode = false`.

### Task 4: Install svelte-dnd-action and update Sidebar.svelte with drag-and-drop
**Files:** `frontend/package.json`, `frontend/src/components/Sidebar.svelte`
**Depends on:** Tasks 1, 2, 3
**What:** Install `svelte-dnd-action` as a dependency. In Sidebar.svelte:
- Import `dndzone` from `svelte-dnd-action` and `reorderWorkspaces` from sessions state
- Import `reorderMode`, `enterReorderMode`, `exitReorderMode` from ui state
- Wrap the workspace `{#each}` in a `use:dndzone` directive with `items={workspaceItems}` (map workspaces to objects with `id` field required by svelte-dnd-action)
- Handle `consider` and `finalize` events: on finalize, call `reorderWorkspaces()` with new order
- When `reorderMode` is true: hide SmartSearch, hide "Add Workspace" button, show floating "Done reordering" button at bottom
- Floating "Done" button style: accent border, accent text, full-width, matches existing button style

### Task 5: Simplify WorkspaceItem header and add grip handle
**Files:** `frontend/src/components/WorkspaceItem.svelte`
**Depends on:** Task 3
**What:**
- Remove the `+` (new session) and `>_` (new terminal) action-btn spans from workspace-actions div. Keep only the `⚙` (settings) button
- Add a grip handle element (`⠿` character) to the left of the collapse chevron in workspace-left. Style: `opacity: 0` by default, `opacity: 1` on `.workspace-header:hover` (desktop). Font-size ~0.8rem, color var(--text-muted), cursor grab
- When `reorderMode` is true: hide the collapse chevron, show grip handle at full opacity, hide the settings action button
- When `reorderMode` is true: hide the session-list (`ul.session-list`), hide the add-worktree-row, hide the workspace-divider — only show workspace headers for a compact draggable list
- Accept new `reorderMode` prop from Sidebar

### Task 6: Add mobile reorder mode (long-press entry + floating Done)
**Files:** `frontend/src/components/Sidebar.svelte`, `frontend/src/components/WorkspaceItem.svelte`
**Depends on:** Tasks 4, 5
**What:**
- On WorkspaceItem: add a long-press handler (500ms touchstart timer) on the workspace-header that calls `enterReorderMode()`. Clear timer on touchend/touchmove. Only register on mobile (check via media query or touch event presence)
- On mobile (max-width: 600px): always show grip handle in reorder mode (not hover-dependent)
- Ensure svelte-dnd-action touch drag works within the dndzone (it should by default)
- On Sidebar: the floating "Done reordering" button calls `exitReorderMode()` and triggers `reorderWorkspaces()` with current order

### Task 7: Fix inactive session contrast styling
**Files:** `frontend/src/components/WorkspaceItem.svelte`
**What:** Replace blanket opacity reduction with targeted color treatment:
- Remove: `.session-row.inactive { opacity: 0.6; }` and `.session-row.inactive:hover { opacity: 1; }`
- Add: `.session-row.inactive .session-name { color: var(--text-muted); }`
- Change: `.dot-inactive` background from `var(--border)` to `#555` for better visibility
- Add: `.session-row.inactive:hover .session-name { color: var(--text); }`
- Keep `.session-row.loading` styles unchanged
