---
status: implemented
created: 2026-03-25
branch: branch-switcher
supersedes:
implemented-by:
consulted-learnings: []
---

# Branch Bar Redesign

Redesign the PrTopBar branch area to match IDE-style branch bars: `⑂ branch → target ◇` with hover-reveal icons, a worktree-aware branch switcher dropdown, a target branch dropdown for changing PR base, and session-state guards.

## Problem

The current PrTopBar shows branches but lacks:
- Visual direction indicator (current branch → target base branch)
- Worktree awareness in the branch dropdown (no indication of which branches are checked out elsewhere)
- Ability to change PR base branch from the UI
- Hover-reveal actions (copy branch name, rename branch)
- Session-state safety (branch operations available while agent is actively running)

## Design

### Visual Layout

**Resting state:**
```
⑂ dy/refactor/wire-create-form  →  origin/development ◇
```

**Hover state** (icons fade in on bar-left hover):
```
⑂ dy/refactor/wire-create-form [📋] [✏️]  →  origin/development ◇
```

- `📋` — copy branch name to clipboard
- `✏️` — rename branch (inline edit)

**No PR** (arrow + target hidden):
```
⑂ feature/my-branch
```

### Component Architecture

#### 1. BranchSwitcher.svelte (enhanced)

The existing dropdown gains four new behaviors:

**a. Worktree awareness**
Each branch row is cross-referenced against worktree data from the backend. Branches checked out in other worktrees show:
- Strikethrough text + muted color (not selectable)
- If an active session exists in that worktree: link-out icon (→) that calls `setActiveSession()` to jump there
- If no active session (inactive worktree): link-out icon that starts a new session in that worktree (same as clicking an inactive worktree in the sidebar)

The current worktree's branch shows with a checkmark (existing behavior, no strikethrough).

**b. "Create new branch" option**
If filter text doesn't exactly match any branch, show a "Create `{filterText}`" row at the top. Selecting it runs `git checkout -b {filterText}` via a new backend endpoint.

**c. Agent-running guard**
New prop: `disabled: boolean`. When true:
- Trigger button is visually dimmed (opacity)
- Tooltip: "Unavailable while agent is running"
- Dropdown will not open
- Copy branch name remains functional (read-only, no guard needed)

**d. Backend enrichment**
`GET /branches` response changes from `string[]` to:
```typescript
interface BranchInfo {
  name: string;
  isLocal: boolean;
  isRemote: boolean;
  checkedOutIn?: {
    worktreePath: string;
    sessionId?: string;  // present if active session exists
  };
}
```

#### 2. TargetBranchSwitcher (new component or BranchSwitcher variant)

Same searchable dropdown pattern, but:
- Only shows remote branches (filtered from `GET /branches` response — `isRemote: true`)
- Trigger displays the base branch name + caret `◇`
- On select, calls `POST /workspaces/pr-base` which runs `gh pr edit <number> --base <branch>`
- Only renders when a PR exists (existing conditional: `{#if pr?.baseRefName}`)
- Subject to same agent-running guard as BranchSwitcher

#### 3. PrTopBar.svelte (layout changes)

- **Arrow indicator:** Replace `›` separator with SVG arrow `→` between branch and target. Always visible when PR exists (part of resting state)
- **Hover icons:** Copy + rename buttons in `.bar-left`, hidden by default, fade in on `:hover` of bar-left. CSS: `opacity: 0` → `opacity: 1` on `.bar-left:hover`
- **Disabled prop:** New `agentRunning: boolean` prop, forwarded to both BranchSwitcher and TargetBranchSwitcher as `disabled`
- **Rename flow:** Inline edit — clicking ✏️ replaces branch name text with an input field. Enter confirms, Escape cancels. After rename, if a PR exists, show a warning modal

#### 4. Rename Warning Modal

When a branch is renamed and a PR exists for the old branch name:

**Modal content:**
```
Branch renamed: old-name → new-name

This PR's head branch no longer matches. Push the renamed
branch to update GitHub?

[Push]  [Ignore]  [Cancel (undo rename)]
```

- **Push:** Runs `git push origin new-name` + `git push origin --delete old-name` (or `git push origin :old-name new-name`)
- **Ignore:** Close modal, branch is renamed locally but PR is stale
- **Cancel:** Runs `git branch -m new-name old-name` to undo the rename

### New Backend Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /branches` (enhanced) | GET | Return `BranchInfo[]` with `checkedOutIn` cross-referenced from `git worktree list` |
| `POST /workspaces/pr-base` | POST | Run `gh pr edit <prNumber> --base <branch>` to change PR base |
| `POST /workspaces/rename-branch` | POST | Run `git branch -m <old> <new>`, return `{ success, oldName, newName }` |
| `POST /workspaces/create-branch` | POST | Run `git checkout -b <name>`, return `{ success, branch }` |

### API Details

**GET /branches?repo=/path** (enhanced response)
```typescript
// Current: string[]
// New:
interface BranchInfo {
  name: string;
  isLocal: boolean;
  isRemote: boolean;
  checkedOutIn?: {
    worktreePath: string;
    worktreeName: string;
    sessionId?: string;
  };
}
```

Cross-referencing logic in the handler:
1. Run `git branch -a` (existing `listBranches()`)
2. Run `git worktree list --porcelain` to get worktree→branch mapping
3. Look up active sessions per worktree path from `getSessions()`
4. Annotate each branch with its worktree info

**POST /workspaces/pr-base**
```typescript
// Request body
{ path: string; prNumber: number; baseBranch: string }
// Runs: gh pr edit <prNumber> --base <baseBranch> --repo <owner/repo>
// Response: { success: true } | { success: false; error: string }
```

**POST /workspaces/rename-branch**
```typescript
// Request body
{ path: string; newName: string }
// Runs: git branch -m <currentBranch> <newName>
// Response: { success: true; oldName: string; newName: string } | { success: false; error: string }
```

**POST /workspaces/create-branch**
```typescript
// Request body
{ path: string; branchName: string }
// Runs: git checkout -b <branchName>
// Response: { success: true; branch: string } | { success: false; error: string }
```

### Session State Guard

PrTopBar receives a new prop from App.svelte:

```svelte
<!-- App.svelte -->
<PrTopBar
  workspacePath={ui.activeWorkspacePath ?? ''}
  branchName={activeSession?.branchName ?? ''}
  sessionId={sessionState.activeSessionId}
  agentRunning={activeSession?.agentState === 'processing'}
  onArchive={handleArchive}
/>
```

`agentRunning` is forwarded to:
- `BranchSwitcher disabled={agentRunning}` — prevents branch checkout
- `TargetBranchSwitcher disabled={agentRunning}` — prevents base branch change
- Rename icon button `disabled={agentRunning}` — prevents rename
- Copy icon is NOT gated (always available, read-only)

### Dropdown UX Details

**Branch switcher dropdown rows:**

```
┌──────────────────────────────────────┐
│ [Filter branches...]                 │
├──────────────────────────────────────┤
│ + Create "my-new-branch"            │  ← only if filter doesn't match exactly
│ ✓ current-branch                    │  ← checkmark, accent color
│   feature/other-branch              │  ← available, normal style
│   ~~main~~ (denali) →               │  ← strikethrough, muted, link-out icon
│   ~~feature/old~~ (kilimanjaro) →   │  ← strikethrough, muted, link-out icon
│   origin/feature/remote-only        │  ← remote-only branch, normal style
└──────────────────────────────────────┘
```

- Parenthetical shows worktree name for context
- `→` link-out icon is a small clickable button at the right edge
- Clicking the row on a checked-out branch does nothing (disabled)
- Clicking `→` jumps to session or starts one

**Target branch switcher dropdown rows:**
```
┌──────────────────────────────────────┐
│ [Filter branches...]                 │
├──────────────────────────────────────┤
│ ✓ development                       │  ← current base, accent
│   main                              │
│   staging                           │
│   release/v3                        │
└──────────────────────────────────────┘
```

- Only remote branches (stripped of `origin/` prefix)
- No worktree annotations (not relevant for base branch)
- Selecting runs `gh pr edit` immediately

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Branch checked out in current worktree | Checkmark, not strikethrough (current behavior) |
| Branch in worktree with active session | Strikethrough + link-out icon → jump to session |
| Branch in worktree with no active session | Strikethrough + link-out icon → start session in that worktree |
| Rename while PR exists | Warning modal: Push / Ignore / Cancel (undo) |
| Rename while agent running | Rename icon disabled |
| Create branch with invalid name | Backend returns error, shown in dropdown error area |
| `gh` CLI not installed | Target branch switcher hidden (same as current: PR data returns null) |
| Branch switch fails (uncommitted changes) | Error shown in dropdown (existing behavior) |
| No PR exists | Arrow + target branch area hidden entirely |
| Mobile (<600px) | Arrow + target branch hidden (existing responsive rule). Hover icons → always visible (no hover on touch). Or: move to context menu |

### Mobile Considerations

On mobile (touch devices), hover doesn't exist. Options:
- Show copy/rename icons always (smaller, right-aligned)
- Or: fold copy/rename into the existing session context menu (ContextMenu component)

Recommend: show icons always on mobile since the bar has more room without the target branch section.

### Files Changed

**Backend:**
- `server/git.ts` — add `listBranchesEnriched()`, `renameBranch()`, `createBranch()`, `changePrBase()`
- `server/workspaces.ts` — add `POST /workspaces/pr-base`, `POST /workspaces/rename-branch`, `POST /workspaces/create-branch`
- `server/index.ts` — enhance `GET /branches` handler to return `BranchInfo[]`

**Frontend:**
- `frontend/src/components/BranchSwitcher.svelte` — worktree awareness, create branch, disabled state
- `frontend/src/components/TargetBranchSwitcher.svelte` — new component (or generalize BranchSwitcher)
- `frontend/src/components/PrTopBar.svelte` — arrow, hover icons, agentRunning prop, rename flow
- `frontend/src/components/RenameWarningModal.svelte` — new modal for rename + PR warning
- `frontend/src/lib/api.ts` — add `renameBranch()`, `createBranch()`, `changePrBase()`
- `frontend/src/lib/types.ts` — add `BranchInfo` interface

**Estimated scope:** Medium — leverages existing infrastructure heavily. No new server modules, no schema changes.
