---
status: current
created: 2026-03-27
branch:
supersedes:
implemented-by:
consulted-learnings: []
---

# Open From Picker — Unified Branch/PR/Issue Launcher

## Problem

The current "new worktree" button is a text row (`+ new worktree`) that takes up vertical space under every workspace. It only creates a blank worktree — there's no quick way to open a session from an existing branch, PR, or Jira issue without going through the full custom "new session" modal.

## Reference UX

Cursor's "Create from..." picker (⌘⇧N):
- Searchable modal with tabs: **Pull requests**, **Branches**, **Issues**
- Each row shows icon + number/name + title + author
- "Create ↵" action on hover/selection
- Detects existing sessions on a branch → offers "Open ↵" vs "Duplicate branch ⌘↵"
- Repo selector in top-right when multiple repos are available

## Proposal

### 1. Replace "+ new worktree" Row with Inline Icons

Replace the text row with compact icon buttons in the workspace header actions area (next to the settings gear):

```
⌄  [E]  claude-remote-cli          ⚙  +  ⊕
   ^initial                         ^  ^  ^
                              settings |  create-from
                                    new (blank)
```

- **`+`** — quick new blank worktree (current behavior, just as an icon)
- **`⊕`** or similar — opens the "Open from..." picker modal

Both get tooltips with keyboard shortcuts (ties into the tooltip/shortcuts TODO).

### 2. Open From Picker Modal

A searchable modal with three tabs, scoped to the workspace:

**Tabs:**
- **Pull requests** — open PRs from GitHub (already have this data via org PR enrichment)
- **Branches** — local + remote branches (already have `fetchBranches` API)
- **Issues** — GitHub issues + Jira issues (already have both APIs)

**Search:**
- Single search input at top: "Search by title, number, or author"
- Filters across all tabs simultaneously
- Keyboard navigation: ↑↓ to move, Enter to select, Tab to switch tabs

**Row display:**
- PR icon (with open/draft/merged state color) + `#number` + title + author
- Branch icon + branch name
- Issue icon + `#number` / `KEY-123` + title + assignee

**Actions per row (context-dependent):**
- **No existing session:** "Create ↵" — creates worktree + session from this branch/PR/issue
- **Has existing session:** "Open ↵" (navigate to it) + "Duplicate ⌘↵" (create parallel session)
- For issues with no branch yet: creates worktree with a branch named from the issue

**Repo selector:**
- Only shown in org-level context (if we ever add cross-workspace opening)
- For workspace-scoped picker, the workspace is implicit

### 3. Reusable Picker Component

The search + tabbed list of branches/PRs/issues should be extracted as a reusable component:

**`BranchPrIssuePicker.svelte`**
- Props: `workspacePath`, `onSelect(item)`, `initialTab?`
- Fetches branches, PRs, issues on mount (with caching via TanStack Query)
- Emits selected item with type info (`{ kind: 'pr' | 'branch' | 'issue', ... }`)

This component can then be embedded in:
1. The new "Open from..." modal (primary use)
2. The existing full custom "New Session" dialog (as a branch/context selector)
3. Potentially the dashboard (start work on a PR/issue from the PR table)

### 4. Relationship to Existing "New Session" Modal

The full "New Session" modal keeps all its power (agent selection, yolo, tmux, custom args, etc.). The picker is a **fast path** — it uses workspace defaults for everything and just lets you quickly pick what to work on.

**Option A — Picker is standalone, modal stays separate:**
- Picker: fast, opinionated (workspace defaults)
- Modal: full control, all settings exposed
- Picker could have a "Advanced..." link that opens the full modal pre-filled

**Option B — Picker embedded in modal:**
- Full modal gets a new "Open from" section at the top with the picker component
- Selecting a PR/branch/issue pre-fills the branch and context fields
- Rest of the modal settings remain available below

Likely **Option A** is better UX — the picker is about speed, the modal is about control. But the shared `BranchPrIssuePicker` component serves both.

### 5. Duplicate Session Handling

When selecting a branch that already has an active session:

- Show the session's current state (running/idle/permission) in the row
- **"Open ↵"** — navigates to the existing session (default action)
- **"Duplicate ⌘↵"** — creates a new session in the same worktree (parallel agent)
- Could also offer **"New worktree ⌘⇧↵"** — creates a fresh worktree from the same branch (true isolation)

This is a brainstorm area — the exact UX for duplicates vs parallel sessions deserves its own design pass.

## Data Sources (Already Available)

| Tab | API | Status |
|-----|-----|--------|
| Pull requests | `GET /prs/org` | Implemented, cached |
| Branches | `GET /workspaces/branches?path=...` | Implemented |
| GitHub issues | `GET /issues?path=...` | Implemented |
| Jira issues | `GET /jira/issues?projectKey=...` | Implemented |

## Open Questions

- Should the picker auto-focus the search input on open?
- Tab order: PRs first (most common) or Branches first (most general)?
- Should we show recently used branches at the top (frecency)?
- How to handle repos with no GitHub/Jira integration — just show Branches tab?
- Keyboard shortcut assignment: ⌘N for blank, ⌘⇧N for picker? Or vice versa?
