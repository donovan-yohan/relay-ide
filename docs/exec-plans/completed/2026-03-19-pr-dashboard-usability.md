# Execution Plan: PR Dashboard Usability Fixes

> **Status**: Active | **Created**: 2026-03-19
> **Source**: `docs/bug-analyses/2026-03-19-pr-dashboard-usability-bug-analysis.md`
> **Branch**: `worktree-pr-dashboard-usability`

## Progress

- [x] Task 1: Fix scroll clipping
- [x] Task 2: Code Review button → worktree + session + prompt
- [x] Task 3: Per-PR "Open Session" button
- [x] Task 4: PR search/filter input

---

### Task 1: Fix scroll clipping
**File:** `frontend/src/components/RepoDashboard.svelte`, `frontend/src/App.svelte`
**What:** Dashboard content is clipped when PR list exceeds viewport because `.terminal-area` and `.pr-list` both have `overflow: hidden`.
**Fix:**
- Add `overflow-y: auto` to `.repo-dashboard` so dashboard scrolls within `.terminal-area`
- Change `.pr-list` `overflow: hidden` to `overflow: visible` (the rounded border can use `border-radius` without clipping since the dashboard itself scrolls)
- Keep `.terminal-area` `overflow: hidden` (needed for terminal view)

### Task 2: Code Review button → worktree + session + prompt
**Files:** `frontend/src/components/RepoDashboard.svelte`, `frontend/src/App.svelte`
**What:** The derived action pill (e.g. "Review PR") is an `<a href>` linking to GitHub. Should instead create a worktree session and inject the review prompt.
**Fix:**
- Add `onPrAction: (pr: PullRequest) => void` prop to RepoDashboard
- Change the action pill from `<a>` to `<button>` that calls `onPrAction(pr)`
- In App.svelte, wire `onPrAction` to a new `handlePrAction` function that:
  1. Finds or creates a worktree for `pr.headRefName` (reuse `handleFixConflicts` pattern)
  2. Creates a session in that worktree
  3. Derives the action prompt via `getActionPrompt(derivePrAction(...), ctx)` and sends it via PTY
- Import `getActionPrompt` and `derivePrAction` in App.svelte

### Task 3: Per-PR "Open Session" button
**Files:** `frontend/src/components/RepoDashboard.svelte`, `frontend/src/App.svelte`
**What:** No way to start a generic session on a specific PR's branch.
**Fix:**
- Add `onOpenPrSession: (pr: PullRequest) => void` prop to RepoDashboard
- Add a small "+" button next to each PR row's action pills
- In App.svelte, wire `onOpenPrSession` to a handler that creates/reuses a worktree for the PR branch and starts a normal session (no prompt injection)

### Task 4: PR search/filter input
**Files:** `frontend/src/components/RepoDashboard.svelte`
**What:** No way to filter PRs when the list is long.
**Fix:**
- Add a `searchQuery` state variable
- Add a search input above the PR list (styled consistently with the dashboard)
- Filter `data.prs` client-side by title or PR number matching the search query
- Only show the search input when there are more than 5 PRs
