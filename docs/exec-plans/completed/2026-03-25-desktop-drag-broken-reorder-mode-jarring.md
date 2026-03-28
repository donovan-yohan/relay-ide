# Fix Plan: Desktop drag broken + reorder mode jarring

> **Status**: Complete | **Created**: 2026-03-25
> **Source**: `docs/bug-analyses/2026-03-25-desktop-drag-broken-reorder-mode-jarring-bug-analysis.md`
> **Branch**: shasta

## Goal

Remove `reorderMode` entirely. Restore always-on inline drag-and-drop for desktop. Add mobile-only long-press gating that doesn't change the visual layout.

## Progress

- [x] Task 1: Remove `reorderMode` state from `ui.svelte.ts`
- [x] Task 2: Rewrite DnD in `Sidebar.svelte` — device-aware `dragDisabled`
- [x] Task 3: Strip `inReorderMode` guards from `WorkspaceItem.svelte`
- [x] Task 4: Build + verify (396 tests pass, 0 errors)

---

### Task 1: Remove `reorderMode` state from `ui.svelte.ts`

**File:** `frontend/src/lib/state/ui.svelte.ts`

**Changes:**
- Delete `let reorderMode = $state(false);` (line 50)
- Delete the `reorderMode` getter/setter from `getUi()` (lines 71-72)
- Delete `export function enterReorderMode()` and `exitReorderMode()` (lines 80-81)

### Task 2: Rewrite DnD in `Sidebar.svelte`

**File:** `frontend/src/components/Sidebar.svelte`

**Changes:**
- Remove imports of `enterReorderMode`, `exitReorderMode`
- Add `isTouchDevice` reactive state using `matchMedia('(pointer: coarse)')` or `'ontouchstart' in window`
- Add `mobileDragEnabled` state (boolean, default false) — only used on touch devices
- Compute `dragDisabled`: `isTouchDevice && !mobileDragEnabled`
- Rewrite long-press handlers: on long-press set `mobileDragEnabled = true`; on finalize reset `mobileDragEnabled = false`
- Remove the `{#if ui.reorderMode}` / `{:else}` dual rendering — always render the grouped view with DnD
- Remove the "Done reordering" button
- Remove `handleDoneReorder` function
- The `use:dndzone` stays on `.workspace-list` with the new `dragDisabled` expression

### Task 3: Strip `inReorderMode` guards from `WorkspaceItem.svelte`

**File:** `frontend/src/components/WorkspaceItem.svelte`

**Changes:**
- Remove `let inReorderMode = $derived(ui.reorderMode);` (line 96)
- Remove all `{#if !inReorderMode}` conditionals (lines 226, 237, 241, 254, 384, 392) — always show content
- Remove `class:reorder-mode={inReorderMode}` from workspace-header (line 221)
- Remove the click guard: `if (!inReorderMode)` → always call `onSelectWorkspace` (line 223)
- Remove `.workspace-header.reorder-mode` CSS rules (lines 430-436)

### Task 4: Build + verify

- Run `npm run build` to ensure TypeScript compiles
- Run `npm test` to check for regressions
