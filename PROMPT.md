# Implementation: True Workspaces — Multi-Repo Workspace Grouping

**Priority: WAVE 2-3 — Phase 1 (rename + model) starts in Wave 2. Workspace session launch needs Worktree Lifecycle.**

## Pre-flight Checks

```bash
# 1. Current state
git status
git log --oneline -3

# 2. Pull latest nightly
git fetch origin nightly
git rebase origin/nightly

# 3. CRITICAL: Verify Worktree Lifecycle enhanced endpoint has landed
#    Workspace session launch creates coordinated worktrees per repo
grep -r "branch_checked_out_in_main\|branch_not_found" server/ || echo "BLOCKER for session launch: enhanced worktree endpoint not found"

# 4. Check if Sidebar UX indicators have landed (nice-to-have, not blocking)
grep -r "DisplayState\|attentionScore" frontend/src/ || echo "INFO: Sidebar UX indicators not yet landed (non-blocking)"

# 5. Check current workspace/repo naming in codebase (understand rename scope)
grep -rc "workspacePath\b" server/ | sort -t: -k2 -rn | head -10
grep -rc "workspacePath\b" frontend/src/ | sort -t: -k2 -rn | head -10

# 6. Design doc exists
cat docs/design-docs/2026-03-28-true-workspaces-design.md | head -5
```

**Phase 1 (rename + model + migration) can start without worktree lifecycle.** Only the workspace session launch (creating coordinated worktrees) needs the enhanced endpoint.

## Design Doc

Read fully: `docs/design-docs/2026-03-28-true-workspaces-design.md`

## What This Stream CONSUMES

### From Worktree Lifecycle (needed for workspace session launch):
- Enhanced `POST /workspaces/worktree` — called per-repo to create coordinated worktrees
- `continuePolicy: 'never'` — workspace session worktrees are always fresh

### From Sidebar UX (nice-to-have, not blocking):
- Three-axis indicator model — workspace sidebar rows use the same indicators
- attentionScore — workspace sorting by highest-urgency session

### From Command Center (NOT a blocker):
- Action registration — "launch workspace session" action registers later

## What This Stream PRODUCES

### Contract: Config v4 Schema

```typescript
interface Config {
  configVersion: 4;
  repos: string[];                           // renamed from workspaces (string[])
  repoSettings: Record<string, RepoSettings>; // renamed from workspaceSettings
  workspaces: Workspace[];                    // NEW: grouping entities
}

interface Workspace {
  id: string; name: string; repos: string[]; themeColor?: string;
  order: number; template?: WorkspaceTemplate; settings?: WorkspaceLevelSettings;
}
```

### Contract: Settings Cascade Extension

```typescript
// resolveSessionSettings() gets new optional parameter:
function resolveSessionSettings(repoPath: string, workspaceId?: string): ResolvedSettings;
// Cascade: global → workspace.settings (if workspaceId) → repoSettings[path] → session
```

### Contract: New API Routes

```
GET    /workspace-groups           → Workspace[]
POST   /workspace-groups           → Workspace
PUT    /workspace-groups/:id       → Workspace
DELETE /workspace-groups/:id       → void
PUT    /workspace-groups/reorder   → void
POST   /workspace-groups/:id/session → Session (workspace session with --add-dir)
```

### Contract: Session Type Extension

```typescript
interface BaseSession {
  repoPath: string;       // renamed from workspacePath
  workspaceId?: string;   // NEW: set for workspace sessions
  additionalDirs?: string[]; // NEW: --add-dir paths
}
```

## Implementation Order (vertical slice from design doc)

1. **Rename: workspacePath → repoPath** — Server types, config, sessions, routes. Grep-and-replace with judgment (workspace-group references keep "workspace")
2. **Config v4 migration** — Reconcile repos[], promote workspaceGroups, rename settings key
3. **Workspace entity + CRUD** — New type, new routes, settings dialog workspace section
4. **Sidebar workspace grouping** — WorkspaceGroup.svelte, collapse behavior, colored borders
5. **Workspace session launch** — POST /workspace-groups/:id/session with coordinated worktrees + --add-dir
6. **Session persistence** — pending-sessions.json v4 with workspaceId + additionalDirs

## What NOT to Build

- View mode toggle (repos/workspaces/sessions) → follow-up
- Repo role tags display → follow-up
- Workspace template import/export → follow-up
- Cross-repo intelligence → future epic
- Color picker UI → separate design doc exists

## Process

1. Start Step 1-2 immediately (rename + migration, no deps)
2. Run `/harness:plan` for the full vertical slice
3. Steps 3-4 can proceed in parallel
4. Gate Step 5 on worktree lifecycle endpoint landing
5. Run `/harness:complete`
