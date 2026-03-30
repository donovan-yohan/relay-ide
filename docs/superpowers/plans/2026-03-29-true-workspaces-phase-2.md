# True Workspaces Phase 2 — Workspace Session Launch + Sidebar Grouping

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add workspace session launch with coordinated worktrees + `--add-dir`, restructure the sidebar to visually group repos under workspaces with design-doc-accurate styling, and persist workspace session context across server restarts.

**Architecture:** The workspace-groups router gains a `POST /:id/session` endpoint that resolves worktrees per-repo (parallel), spawns a Claude PTY with `--add-dir` args, and stores `workspaceId` + `additionalDirs` on the session. The sidebar restructures from a flat repo list into workspace groups (with an ungrouped section), each rendered by a new `WorkspaceGroup.svelte` component. Session serialization includes the new fields.

**Tech Stack:** TypeScript + ESM (server), Svelte 5 runes (frontend), node-pty, Express

---

## File Structure

### Server — New/Modified

| File | Responsibility |
|------|----------------|
| `server/types.ts` | Add `workspaceId?` + `additionalDirs?` to BaseSession, SessionSummary |
| `server/workspace-groups.ts` | Add `POST /:id/session` route |
| `server/sessions.ts` | Serialize/restore `workspaceId` + `additionalDirs` |
| `server/index.ts` | Pass `sessions`, `gitWatcher`, `CONFIG_PATH` to workspace-groups router |

### Frontend — New/Modified

| File | Responsibility |
|------|----------------|
| `frontend/src/components/WorkspaceGroup.svelte` | **New** — workspace grouping container with collapse, border, launch button |
| `frontend/src/components/Sidebar.svelte` | Restructure to render workspace groups + ungrouped section |
| `frontend/src/lib/types.ts` | Add `workspaceId?` + `additionalDirs?` to SessionSummary |
| `frontend/src/lib/api.ts` | Add `launchWorkspaceSession()` |
| `frontend/src/lib/state/sessions.svelte.ts` | Add `workspaceGroups` state, `refreshAll` fetches groups |
| `frontend/src/lib/state/ui.svelte.ts` | Add `activeWorkspaceId` |
| `frontend/src/App.svelte` | Wire up workspace session launch handler |

### Tests — Modified

| File | Responsibility |
|------|----------------|
| `test/config.test.ts` | Test `resolveSessionSettings` with `workspaceId` |
| `test/workspace-groups.test.ts` | **New** — workspace session launch endpoint tests |

---

## Task 1: Add workspaceId + additionalDirs to Session Types

**Files:**
- Modify: `server/types.ts:31-49` (BaseSession), `server/types.ts:77-98` (SessionSummary)
- Modify: `frontend/src/lib/types.ts:21-38` (SessionSummary)

- [ ] **Step 1: Add fields to server BaseSession**

In `server/types.ts`, add two optional fields to the `BaseSession` interface after line 48 (`agentState`):

```typescript
// In BaseSession (after agentState: AgentState;)
  workspaceId?: string;
  additionalDirs?: string[];
```

- [ ] **Step 2: Add fields to server SessionSummary**

In `server/types.ts`, add the same fields to `SessionSummary` after line 97 (`currentActivity`):

```typescript
// In SessionSummary (after currentActivity)
  workspaceId?: string;
  additionalDirs?: string[];
```

- [ ] **Step 3: Add fields to frontend SessionSummary**

In `frontend/src/lib/types.ts`, add after line 37 (`agentState`):

```typescript
  workspaceId?: string | undefined;
  additionalDirs?: string[] | undefined;
```

- [ ] **Step 4: Update sessions.list() to include new fields**

In `server/sessions.ts:205-230`, update the `list()` function's `SessionSummary` mapping to include the new fields:

```typescript
// After currentActivity: s.currentActivity, (around line 227)
      ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}),
      ...(s.additionalDirs?.length ? { additionalDirs: s.additionalDirs } : {}),
```

- [ ] **Step 5: Build and verify no type errors**

Run: `npm run build`
Expected: Clean build with no errors

- [ ] **Step 6: Commit**

```bash
git add server/types.ts server/sessions.ts frontend/src/lib/types.ts
git commit -m "feat: add workspaceId + additionalDirs to session types"
```

---

## Task 2: Session Persistence — Serialize/Restore workspaceId + additionalDirs

**Files:**
- Modify: `server/sessions.ts:16-38` (SerializedPtySession), `server/sessions.ts:301-344` (serializeAll), `server/sessions.ts:468-494` (restore createParams)

- [ ] **Step 1: Add fields to SerializedPtySession**

In `server/sessions.ts`, add after `continuePolicy` (line 37):

```typescript
  workspaceId?: string;
  additionalDirs?: string[];
```

- [ ] **Step 2: Serialize the new fields**

In `server/sessions.ts:serializeAll`, add to the `serializedPty.push({...})` block after the `branchRenamePrompt` spread (around line 333):

```typescript
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(session.additionalDirs?.length ? { additionalDirs: session.additionalDirs } : {}),
```

- [ ] **Step 3: Restore the new fields**

In `server/sessions.ts:restoreFromDisk`, in the `createParams` construction (around line 469-490), add after the `branchRenamePrompt` spread (around line 489):

```typescript
        ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}),
        ...(s.additionalDirs?.length ? { additionalDirs: s.additionalDirs } : {}),
```

Note: `CreateParams` extends `CreatePtyParams` via `Omit<CreatePtyParams, 'id'>`. The `workspaceId` and `additionalDirs` fields are on `BaseSession` (which `PtySession` extends), but NOT on `CreatePtyParams`. They need to be set on the session object AFTER creation. This means we need a different approach:

Actually, looking at the code flow: `sessions.create()` calls `createPtySession()` which constructs the `PtySession` using `...rest` spread. Since `workspaceId` and `additionalDirs` aren't in `CreatePtyParams`, they'd be in the `rest` spread from `create()`. But `createPtySession` only uses known params. So we need to set them post-creation.

Instead, update `sessions.create()` to accept and set these fields:

In `server/sessions.ts:144`, update `create()` to destructure the new fields:

```typescript
function create({ id: providedId, needsBranchRename, branchRenamePrompt, initialPrompt, workspaceId, additionalDirs, agent = 'claude', cols = 80, rows = 24, args = [], port, forceOutputParser, ...rest }: CreateParams): CreateResult {
```

And add after `ptySession.initialPrompt = initialPrompt;` (line 178):

```typescript
  if (workspaceId) {
    ptySession.workspaceId = workspaceId;
  }
  if (additionalDirs?.length) {
    ptySession.additionalDirs = additionalDirs;
  }
```

Also add to `CreateParams` type (line 48):

```typescript
type CreateParams = Omit<CreatePtyParams, 'id'> & {
  id?: string;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
  initialPrompt?: string;
  workspaceId?: string;
  additionalDirs?: string[];
};
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: All existing tests pass

- [ ] **Step 6: Commit**

```bash
git add server/sessions.ts
git commit -m "feat: persist workspaceId + additionalDirs across server restarts"
```

---

## Task 3: Workspace Session Launch Endpoint

**Files:**
- Modify: `server/workspace-groups.ts` (add POST /:id/session route)
- Modify: `server/index.ts` (pass additional dependencies to router)

- [ ] **Step 1: Update router factory signature**

In `server/workspace-groups.ts`, update the imports and function signature to accept the dependencies needed for session creation:

```typescript
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { loadConfig, saveConfig, resolveSessionSettings } from './config.js';
import type { Config, Workspace, AgentType, ContinuePolicy } from './types.js';
import { AGENT_CONTINUE_ARGS, AGENT_YOLO_ARGS } from './types.js';
import { findOrCreateWorktreeForBranch } from './watcher.js';
import { detectGitRepo } from './workspaces.js';

const execFileAsync = promisify(execFile);

interface SessionDeps {
  sessions: typeof import('./sessions.js');
  gitWatcher: { watch(cwd: string): void };
  configPath: string;
}

export function createWorkspaceGroupsRouter(
  configPath: string,
  requireAuth: (req: any, res: any, next: any) => void,
  sessionDeps?: SessionDeps,
): Router {
```

- [ ] **Step 2: Add POST /:id/session route**

Before the `return router;` line in `workspace-groups.ts`, add:

```typescript
  // POST /workspace-groups/:id/session — launch a workspace session with coordinated worktrees
  if (sessionDeps) {
    router.post('/:id/session', requireAuth, async (req: Request, res: Response) => {
      const { id } = req.params as { id: string };
      const { agent, yolo, useTmux, claudeArgs, cols, rows } = req.body as {
        agent?: string;
        yolo?: boolean;
        useTmux?: boolean;
        claudeArgs?: string[];
        cols?: number;
        rows?: number;
      };

      let config: Config;
      try {
        config = loadConfig(configPath);
      } catch {
        res.status(500).json({ error: 'Failed to read config' });
        return;
      }

      const workspaces = config.workspaces ?? [];
      const workspace = workspaces.find(w => w.id === id);
      if (!workspace) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }

      if (workspace.repos.length === 0) {
        res.status(400).json({ error: 'Workspace has no repos' });
        return;
      }

      // Resolve paths per-repo in parallel: git repos get worktrees, non-git use path directly
      const execFn = (cmd: string, args: string[], opts: { cwd: string; timeout?: number }) =>
        execFileAsync(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 10_000 })
          .then(({ stdout, stderr }) => ({ stdout, stderr }));

      type RepoResult = { repoPath: string; resolvedPath: string } | { repoPath: string; error: string };

      const results = await Promise.allSettled(
        workspace.repos.map(async (repoPath): Promise<RepoResult> => {
          // Validate the directory exists
          if (!fs.existsSync(repoPath)) {
            return { repoPath, error: `directory not found: ${repoPath}` };
          }

          // Check if it's a git repo
          let gitInfo: { isGitRepo: boolean; defaultBranch: string | null };
          try {
            gitInfo = await detectGitRepo(repoPath);
          } catch {
            // Not a git repo or detection failed — use path directly
            return { repoPath, resolvedPath: repoPath };
          }

          if (!gitInfo.isGitRepo || !gitInfo.defaultBranch) {
            // Non-git directory — use directly
            return { repoPath, resolvedPath: repoPath };
          }

          // Git repo — find or create a worktree on the default branch
          try {
            const result = await findOrCreateWorktreeForBranch(repoPath, gitInfo.defaultBranch, execFn);
            return { repoPath, resolvedPath: result.worktreePath };
          } catch (err: any) {
            if (err?.constructor?.name === 'BranchCheckedOutInMainError') {
              // Default branch is checked out in main — use repo path directly
              return { repoPath, resolvedPath: repoPath };
            }
            return { repoPath, error: err?.message ?? 'worktree creation failed' };
          }
        }),
      );

      // Collect successes and failures
      const successes: Array<{ repoPath: string; resolvedPath: string }> = [];
      const failures: Array<{ repoPath: string; error: string }> = [];

      for (const result of results) {
        if (result.status === 'rejected') {
          failures.push({ repoPath: 'unknown', error: result.reason?.message ?? 'unknown error' });
          continue;
        }
        const val = result.value;
        if ('error' in val) {
          failures.push(val);
        } else {
          successes.push(val);
        }
      }

      if (successes.length === 0) {
        res.status(500).json({
          error: 'All repos failed to resolve',
          failures,
        });
        return;
      }

      // First repo = cwd, rest = --add-dir
      const primary = successes[0]!;
      const additionalDirs = successes.slice(1).map(s => s.resolvedPath);

      // Build --add-dir args for Claude
      const addDirArgs = additionalDirs.flatMap(dir => ['--add-dir', dir]);

      // Resolve settings with workspace cascade
      const resolved = resolveSessionSettings(config, primary.repoPath, {
        agent: agent as AgentType | undefined,
        yolo,
        useTmux,
        claudeArgs: claudeArgs ? [...claudeArgs, ...addDirArgs] : addDirArgs.length > 0 ? addDirArgs : undefined,
      }, workspace.id);

      const resolvedAgent = resolved.agent;

      const baseArgs = [
        ...(resolved.claudeArgs),
        ...(resolved.yolo ? AGENT_YOLO_ARGS[resolvedAgent] : []),
      ];

      const useContinue = resolved.continuePolicy === 'always';
      const args = useContinue
        ? [...AGENT_CONTINUE_ARGS[resolvedAgent], ...baseArgs]
        : [...baseArgs];

      const name = workspace.name;
      const displayName = sessionDeps.sessions.nextAgentName();

      const safeCols = typeof cols === 'number' && Number.isFinite(cols) && cols >= 1 && cols <= 500 ? Math.round(cols) : undefined;
      const safeRows = typeof rows === 'number' && Number.isFinite(rows) && rows >= 1 && rows <= 200 ? Math.round(rows) : undefined;

      // Determine cwd and worktreePath
      const cwd = primary.resolvedPath;
      const worktreePath = primary.resolvedPath !== primary.repoPath ? primary.resolvedPath : null;

      try {
        const session = sessionDeps.sessions.create({
          type: 'agent',
          agent: resolvedAgent,
          repoName: name,
          repoPath: primary.repoPath,
          worktreePath,
          cwd,
          branchName: '',
          displayName,
          args,
          useTmux: resolved.useTmux,
          yolo: resolved.yolo,
          claudeArgs: resolved.claudeArgs,
          continuePolicy: resolved.continuePolicy,
          workspaceId: workspace.id,
          additionalDirs: additionalDirs.length > 0 ? additionalDirs : undefined,
          ...(safeCols != null && { cols: safeCols }),
          ...(safeRows != null && { rows: safeRows }),
        });

        sessionDeps.gitWatcher.watch(session.cwd);

        const response: Record<string, unknown> = { ...session };
        if (failures.length > 0) {
          response.warnings = failures;
        }

        res.status(201).json(response);
      } catch (err: any) {
        res.status(500).json({ error: err?.message ?? 'Failed to create workspace session' });
      }
    });
  }
```

- [ ] **Step 3: Export detectGitRepo from workspaces.ts**

Check if `detectGitRepo` is already exported from `server/workspaces.ts`. If not, add `export` to its declaration. The function is at approximately line 115.

Verify: `grep 'export.*function detectGitRepo\|export async function detectGitRepo' server/workspaces.ts`

If not exported, change `async function detectGitRepo` to `export async function detectGitRepo`.

- [ ] **Step 4: Update index.ts to pass session dependencies**

In `server/index.ts`, find the mount line (line 384):
```typescript
app.use('/workspace-groups', createWorkspaceGroupsRouter(CONFIG_PATH, requireAuth));
```

Change to:
```typescript
app.use('/workspace-groups', createWorkspaceGroupsRouter(CONFIG_PATH, requireAuth, {
  sessions,
  gitWatcher,
  configPath: CONFIG_PATH,
}));
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: All existing tests pass

- [ ] **Step 7: Commit**

```bash
git add server/workspace-groups.ts server/workspaces.ts server/index.ts
git commit -m "feat: workspace session launch with coordinated worktrees + --add-dir"
```

---

## Task 4: Frontend API + State for Workspace Groups

**Files:**
- Modify: `frontend/src/lib/api.ts` (add `launchWorkspaceSession`)
- Modify: `frontend/src/lib/state/sessions.svelte.ts` (add workspace groups state)
- Modify: `frontend/src/lib/state/ui.svelte.ts` (add `activeWorkspaceId`)

- [ ] **Step 1: Add launchWorkspaceSession to api.ts**

In `frontend/src/lib/api.ts`, after the `deleteWorkspaceGroup` function (around line 574), add:

```typescript
export async function launchWorkspaceSession(workspaceId: string, opts?: {
  agent?: string;
  yolo?: boolean;
  useTmux?: boolean;
  claudeArgs?: string[];
  cols?: number;
  rows?: number;
}): Promise<SessionSummary & { warnings?: Array<{ repoPath: string; error: string }> }> {
  const res = await fetch(`/workspace-groups/${workspaceId}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok) throw new Error(await parseErrorBody(res, 'Failed to launch workspace session'));
  return res.json() as Promise<SessionSummary & { warnings?: Array<{ repoPath: string; error: string }> }>;
}
```

- [ ] **Step 2: Add workspace groups state to sessions.svelte.ts**

In `frontend/src/lib/state/sessions.svelte.ts`, add import for `Workspace`:

```typescript
import type { SessionSummary, WorktreeInfo, Repo, SidebarItem, Workspace } from '../types.js';
```

Add state variable after `repos` (line 25):

```typescript
let workspaceGroups = $state<Workspace[]>([]);
```

Update `getSessionState()` to expose it:

```typescript
    get workspaceGroups() { return workspaceGroups; },
```

Update `refreshAll()` to fetch workspace groups in parallel. Change:

```typescript
const [s, w, ws] = await Promise.all([
  api.fetchSessions(),
  api.fetchWorktrees(),
  api.fetchWorkspaces(),
]);
sessions = s;
worktrees = w;
repos = ws;
```

To:

```typescript
const [s, w, ws, wg] = await Promise.all([
  api.fetchSessions(),
  api.fetchWorktrees(),
  api.fetchWorkspaces(),
  api.fetchWorkspaceGroups(),
]);
sessions = s;
worktrees = w;
repos = ws;
workspaceGroups = wg;
```

- [ ] **Step 3: Add activeWorkspaceId to ui.svelte.ts**

In `frontend/src/lib/state/ui.svelte.ts`, add a new state variable for tracking the active workspace group. Add after `activeRepoPath`:

```typescript
const ACTIVE_WORKSPACE_GROUP_KEY = 'claude-remote-active-workspace-group';

function loadActiveWorkspaceId(): string | null {
  try { return localStorage.getItem(ACTIVE_WORKSPACE_GROUP_KEY); }
  catch { return null; }
}
```

Add state:

```typescript
let activeWorkspaceId = $state<string | null>(loadActiveWorkspaceId());
```

Expose in `getUi()`:

```typescript
    get activeWorkspaceId() { return activeWorkspaceId; },
    set activeWorkspaceId(id: string | null) {
      activeWorkspaceId = id;
      try {
        if (id === null) localStorage.removeItem(ACTIVE_WORKSPACE_GROUP_KEY);
        else localStorage.setItem(ACTIVE_WORKSPACE_GROUP_KEY, id);
      } catch { /* localStorage unavailable */ }
    },
```

- [ ] **Step 4: Add helper to get sessions for a workspace group**

In `frontend/src/lib/state/sessions.svelte.ts`, add after `getSessionsForRepo`:

```typescript
export function getSessionsForWorkspaceGroup(workspaceId: string): SessionSummary[] {
  // Workspace sessions (launched via workspace session launch)
  const directSessions = sessions.filter(s => s.workspaceId === workspaceId);
  // Also include single-repo sessions whose repoPath is in this workspace's repos
  const workspace = workspaceGroups.find(w => w.id === workspaceId);
  if (!workspace) return directSessions;
  const repoSet = new Set(workspace.repos);
  const repoSessions = sessions.filter(s => !s.workspaceId && repoSet.has(s.repoPath));
  return [...directSessions, ...repoSessions];
}
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/state/sessions.svelte.ts frontend/src/lib/state/ui.svelte.ts frontend/src/lib/types.ts
git commit -m "feat: frontend state + API for workspace groups and session launch"
```

---

## Task 5: WorkspaceGroup.svelte Component

**Files:**
- Create: `frontend/src/components/WorkspaceGroup.svelte`

This is the visual container for a workspace group in the sidebar. Must match DESIGN.md Workspace Grouping section: collapsed = colored left-edge accent (2px), expanded = full rectangular outline border.

- [ ] **Step 1: Create WorkspaceGroup.svelte**

Create `frontend/src/components/WorkspaceGroup.svelte`:

```svelte
<script lang="ts">
  import type { Workspace, Repo, SessionSummary, WorktreeInfo, PullRequest } from '../lib/types.js';
  import { getSessionState, isItemLoading, setLoading, clearLoading } from '../lib/state/sessions.svelte.js';
  import { toggleWorkspaceCollapse, isWorkspaceCollapsed } from '../lib/state/ui.svelte.js';
  import { deriveColor } from '../lib/colors.js';
  import CipherText from './CipherText.svelte';
  import TuiButton from './TuiButton.svelte';
  import TuiProgress from './TuiProgress.svelte';
  import WorkspaceItem from './WorkspaceItem.svelte';

  let {
    workspace,
    repos,
    sessions: workspaceSessions = [],
    worktrees: workspaceWorktrees = [],
    loading = false,
    onLaunchSession,
    onSelectSession,
    onSelectWorkspace,
    onNewWorktree,
    onOpenSettings,
    onDeleteSession,
    onDeleteWorktree,
    orgPrs,
  }: {
    workspace: Workspace;
    repos: Repo[];
    sessions?: SessionSummary[];
    worktrees?: WorktreeInfo[];
    loading?: boolean;
    onLaunchSession: (workspaceId: string) => void;
    onSelectSession: (id: string) => void;
    onSelectWorkspace: (path: string) => void;
    onNewWorktree: (workspace: Repo) => void;
    onOpenSettings: (workspace?: Repo) => void;
    onDeleteSession?: (id: string) => void;
    onDeleteWorktree?: (wt: WorktreeInfo) => void;
    orgPrs?: PullRequest[];
  } = $props();

  let collapsed = $derived(isWorkspaceCollapsed(workspace.id));
  let themeColor = $derived(workspace.themeColor || deriveColor(workspace.name));
  let borderColor = $derived(`color-mix(in srgb, ${themeColor} 30%, transparent)`);

  // Count sessions in this workspace group
  let workspaceSessionCount = $derived(workspaceSessions.length);

  // Workspace-level sessions (launched via workspace session launch, have workspaceId)
  let directSessions = $derived(workspaceSessions.filter(s => s.workspaceId === workspace.id));

  let launchKey = $derived(`ws-launch:${workspace.id}`);
  let launching = $derived(isItemLoading(launchKey));
</script>

<div
  class="workspace-group"
  class:collapsed
  class:expanded={!collapsed}
  style:--ws-border-color={borderColor}
  style:--ws-theme-color={themeColor}
  role="group"
  aria-expanded={!collapsed}
  aria-label="workspace: {workspace.name}"
>
  <!-- Header row — always visible -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="ws-header"
    onclick={() => toggleWorkspaceCollapse(workspace.id)}
  >
    <span class="ws-chevron" class:collapsed>{collapsed ? '›' : '⌄'}</span>
    <span class="ws-name">
      <CipherText text={workspace.name} {loading} />
    </span>
    {#if collapsed && workspaceSessionCount > 0}
      <span class="ws-session-count">{workspaceSessionCount} session{workspaceSessionCount !== 1 ? 's' : ''}</span>
    {/if}
  </div>

  {#if !collapsed}
    <!-- Workspace-level sessions (with workspace badge) -->
    {#each directSessions as session (session.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="ws-session-row" onclick={() => onSelectSession(session.id)}>
        <span class="ws-badge">workspace</span>
        <span class="ws-session-name">{session.displayName}</span>
      </div>
    {/each}

    <!-- Launch button -->
    <div class="ws-launch-row">
      <TuiButton
        variant="primary"
        onclick={(e) => { e.stopPropagation(); onLaunchSession(workspace.id); }}
        disabled={launching}
      >
        {#if launching}
          <TuiProgress variant="braille" /> launching...
        {:else}
          > launch workspace session
        {/if}
      </TuiButton>
    </div>

    <!-- Nested repos -->
    {#each repos as repo (repo.path)}
      {@const repoSessions = workspaceSessions.filter(s => s.repoPath === repo.path && !s.workspaceId)}
      {@const activeWorktreePaths = new Set(repoSessions.map(s => s.worktreePath).filter(Boolean) as string[])}
      {@const inactiveWorktrees = workspaceWorktrees.filter(wt =>
        wt.repoPath === repo.path &&
        wt.path.startsWith(repo.path + '/') &&
        !activeWorktreePaths.has(wt.path)
      )}
      {@const groupedByPath = (() => {
        const groups = new Map<string, SessionSummary[]>();
        groups.set(repo.path, []);
        for (const s of repoSessions) {
          const groupKey = s.worktreePath ?? s.repoPath;
          const existing = groups.get(groupKey);
          if (existing) existing.push(s);
          else groups.set(groupKey, [s]);
        }
        return groups;
      })()}
      <WorkspaceItem
        workspace={repo}
        sessionGroups={groupedByPath}
        {inactiveWorktrees}
        isActive={false}
        onSelectWorkspace={onSelectWorkspace}
        {onSelectSession}
        onNewWorktree={onNewWorktree}
        {onOpenSettings}
        onDeleteSession={(id) => onDeleteSession?.(id)}
        onDeleteWorktree={(wt) => onDeleteWorktree?.(wt)}
        {orgPrs}
      />
    {/each}

    {#if repos.length === 0}
      <div class="ws-empty">no repos</div>
    {/if}
  {/if}
</div>

<style>
  .workspace-group {
    display: flex;
    flex-direction: column;
  }

  /* Collapsed: colored left-edge accent (2px) */
  .workspace-group.collapsed {
    border-left: 2px solid var(--ws-border-color);
  }

  /* Expanded: full rectangular outline border */
  .workspace-group.expanded {
    border: 1px solid var(--ws-border-color);
    background: var(--bg);
    margin: 4px 8px;
  }

  .ws-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    min-height: 44px;
    transition: background 0.12s;
  }

  .ws-header:hover {
    background: var(--surface-hover);
  }

  .ws-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    flex-shrink: 0;
    transition: color 0.12s;
  }

  .ws-chevron:hover {
    color: var(--text);
  }

  .ws-name {
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1;
  }

  .ws-session-count {
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  /* Workspace session row */
  .ws-session-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 6px 36px;
    cursor: pointer;
    min-height: 36px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    transition: background 0.1s;
  }

  .ws-session-row:hover {
    background: var(--surface-hover);
  }

  /* Workspace session badge: --color-orange, outline-only, zero border-radius */
  .ws-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border: 1px solid #fb923c;
    color: #fb923c;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    line-height: 1.2;
    text-transform: lowercase;
    flex-shrink: 0;
  }

  .ws-session-name {
    color: var(--text-muted);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    min-width: 0;
  }

  /* Launch button row */
  .ws-launch-row {
    padding: 4px 12px 8px;
  }

  .ws-launch-row :global(button) {
    width: 100%;
  }

  /* Empty state */
  .ws-empty {
    padding: 12px 12px 12px 36px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
  }

  @media (max-width: 600px) {
    .ws-header {
      min-height: 48px;
    }
  }
</style>
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/WorkspaceGroup.svelte
git commit -m "feat: WorkspaceGroup.svelte — workspace container with borders, launch button, badge"
```

---

## Task 6: Restructure Sidebar for Workspace Groups + Ungrouped

**Files:**
- Modify: `frontend/src/components/Sidebar.svelte`

The sidebar currently renders a flat list of repos via `localDndItems`. We restructure it to show:
1. Workspace groups (each rendered by `WorkspaceGroup.svelte`)
2. Ungrouped repos (repos not in any workspace group)

- [ ] **Step 1: Update imports in Sidebar.svelte**

Add imports at the top of the `<script>` block:

```typescript
import type { Workspace } from '../lib/types.js';
import WorkspaceGroup from './WorkspaceGroup.svelte';
import { getSessionsForRepo } from '../lib/state/sessions.svelte.js';
```

Remove the import of `getSessionsForRepo` from the existing line if it's already imported (line 12 already imports it — keep it).

Add `WorkspaceGroup` import.

- [ ] **Step 2: Add derived state for workspace grouping**

Add after the existing derived state, before the DnD section:

```typescript
  // Workspace groups + ungrouped repos
  let workspaceGroups = $derived(sessionState.workspaceGroups);

  // Repos grouped under workspaces
  let groupedRepoPaths = $derived(
    new Set(workspaceGroups.flatMap(ws => ws.repos))
  );

  // Ungrouped repos (not in any workspace group)
  let ungroupedRepos = $derived(
    sessionState.repos.filter(r => !groupedRepoPaths.has(r.path))
  );

  // Map repos by path for quick lookup
  let reposByPath = $derived(
    new Map(sessionState.repos.map(r => [r.path, r]))
  );
```

- [ ] **Step 3: Add props for workspace session launch**

Add to the props destructuring:

```typescript
    onLaunchWorkspaceSession,
```

And to the type:

```typescript
    onLaunchWorkspaceSession?: (workspaceId: string) => void;
```

- [ ] **Step 4: Replace workspace-list markup**

Replace the entire `<div class="workspace-list" ...>` block (lines 172-225) with:

```svelte
    <div class="workspace-list">
      <!-- Workspace groups -->
      {#each workspaceGroups.sort((a, b) => a.order - b.order) as ws (ws.id)}
        {@const wsRepos = ws.repos.map(p => reposByPath.get(p)).filter((r): r is Repo => r !== undefined)}
        {@const wsSessions = sessionState.sessions.filter(s =>
          s.workspaceId === ws.id || ws.repos.includes(s.repoPath)
        )}
        {@const wsWorktrees = sessionState.worktrees.filter(wt =>
          ws.repos.includes(wt.repoPath)
        )}
        <WorkspaceGroup
          workspace={ws}
          repos={wsRepos}
          sessions={wsSessions}
          worktrees={wsWorktrees}
          onLaunchSession={(id) => onLaunchWorkspaceSession?.(id)}
          onSelectSession={onSelectSession}
          onSelectWorkspace={handleSelectWorkspace}
          onNewWorktree={onNewWorktree}
          onOpenSettings={onOpenSettings}
          onDeleteSession={(id) => onDeleteSession?.(id)}
          onDeleteWorktree={(wt) => onDeleteWorktree?.(wt)}
          orgPrs={orgPrs}
        />
      {/each}

      <!-- Ungrouped section -->
      {#if ungroupedRepos.length > 0}
        {#if workspaceGroups.length > 0}
          <div class="ungrouped-label">ungrouped</div>
        {/if}

        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="ungrouped-list"
          use:dndzone={{ items: localDndItems, flipDurationMs, type: 'workspaces', dropTargetStyle: {}, dragDisabled }}
          onconsider={handleDndConsider}
          onfinalize={handleDndFinalize}
          ontouchstart={handleTouchStart}
          ontouchend={cancelTouch}
          ontouchmove={cancelTouch}
          ontouchcancel={cancelTouch}
        >
          {#each localDndItems.filter(item => !groupedRepoPaths.has(item.id)) as item (item.id)}
            {@const workspace = item.workspace}
            {@const activeSessions = getSessionsForRepo(workspace.path)}
            {@const activeWorktreePaths = new Set(activeSessions.map(s => s.worktreePath).filter(Boolean) as string[])}
            {@const inactiveWorktrees = sessionState.worktrees.filter(wt =>
              wt.repoPath === workspace.path &&
              wt.path.startsWith(workspace.path + '/') &&
              !activeWorktreePaths.has(wt.path)
            )}
            {@const groupedByPath = (() => {
              const groups = new Map<string, typeof activeSessions>();
              groups.set(workspace.path, []);
              for (const s of activeSessions) {
                const groupKey = s.worktreePath ?? s.repoPath;
                const existing = groups.get(groupKey);
                if (existing) existing.push(s);
                else groups.set(groupKey, [s]);
              }
              return groups;
            })()}
            <div>
              <WorkspaceItem
                {workspace}
                sessionGroups={groupedByPath}
                {inactiveWorktrees}
                isActive={ui.activeRepoPath === workspace.path && !sessionState.activeSessionId}
                onSelectWorkspace={handleSelectWorkspace}
                {onSelectSession}
                onNewWorktree={onNewWorktree}
                {onOpenSettings}
                onDeleteSession={(id) => onDeleteSession?.(id)}
                onDeleteWorktree={(wt) => onDeleteWorktree?.(wt)}
                {orgPrs}
              />
            </div>
          {/each}
        </div>
      {/if}

      <!-- Empty states -->
      {#if sessionState.repos.length === 0}
        <div class="empty-state">
          <span>no workspaces</span>
        </div>
      {:else if workspaceGroups.length === 0 && ungroupedRepos.length > 0}
        <div class="empty-workspace-hint">
          <span>no workspaces yet</span>
        </div>
      {/if}
    </div>
```

- [ ] **Step 5: Add CSS for ungrouped section and empty states**

Add to the `<style>` block:

```css
  .ungrouped-label {
    padding: 8px 12px 4px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    text-transform: lowercase;
  }

  .ungrouped-list {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .empty-workspace-hint {
    padding: 12px 12px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    color: var(--text-muted);
    opacity: 0.5;
    text-align: center;
  }
```

- [ ] **Step 6: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/Sidebar.svelte
git commit -m "feat: sidebar workspace grouping with ungrouped section and empty states"
```

---

## Task 7: Wire Up Workspace Session Launch in App.svelte

**Files:**
- Modify: `frontend/src/App.svelte`

- [ ] **Step 1: Add import for launchWorkspaceSession**

In `frontend/src/App.svelte`, add to the API imports:

```typescript
import { launchWorkspaceSession } from './lib/api.js';
```

Also import from sessions state:

```typescript
import { setLoading, clearLoading } from './lib/state/sessions.svelte.js';
```

(Check if these are already imported — they may be.)

- [ ] **Step 2: Add handler function**

Add a handler function after `handleNewWorktree` (around line 581):

```typescript
  async function handleLaunchWorkspaceSession(workspaceId: string) {
    const loadingKey = `ws-launch:${workspaceId}`;
    if (isItemLoading(loadingKey)) return;
    setLoading(loadingKey);
    try {
      const result = await launchWorkspaceSession(workspaceId);
      await refreshAll();
      sessionState.activeSessionId = result.id;
      ui.activeRepoPath = result.repoPath;
      ui.activeWorkspaceId = workspaceId;
      closeSidebar();

      if (result.warnings?.length) {
        // Toast partial failure warnings
        console.warn('[workspace-session] partial failure:', result.warnings);
      }
    } catch (err) {
      console.error('[workspace-session] launch failed:', err);
    } finally {
      clearLoading(loadingKey);
    }
  }
```

(Import `isItemLoading`, `setLoading`, `clearLoading` from sessions state if not already imported.)

- [ ] **Step 3: Pass handler to Sidebar**

Find the `<Sidebar` component usage in App.svelte's markup and add:

```svelte
onLaunchWorkspaceSession={handleLaunchWorkspaceSession}
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.svelte
git commit -m "feat: wire workspace session launch from sidebar to backend"
```

---

## Task 8: Collapse State Uses Workspace IDs

**Files:**
- Modify: `frontend/src/lib/state/ui.svelte.ts`

The current `collapsedWorkspaces` Set uses repo paths as keys. Workspace groups need to use workspace IDs as keys. Since `WorkspaceGroup.svelte` already calls `toggleWorkspaceCollapse(workspace.id)`, and `WorkspaceItem.svelte` calls `toggleWorkspaceCollapse(workspace.path)`, both key types coexist naturally in the same Set — no code change needed.

However, we should clear stale localStorage entries on first v4 load. This is already handled by the design doc ("localStorage collapse/active state gracefully resets on v4 migration"). Since the config migration is server-side and localStorage is client-side, we handle this pragmatically: the old path-based keys just become orphans in the Set and don't cause harm. No explicit cleanup needed.

- [ ] **Step 1: Verify collapse works for both repo paths and workspace IDs**

The existing `toggleWorkspaceCollapse` and `isWorkspaceCollapsed` in `ui.svelte.ts` use a `Set<string>` keyed by arbitrary string. Both workspace IDs (UUIDs) and repo paths work as keys without code changes.

Run: `npm run build`
Expected: Clean build, no changes needed

- [ ] **Step 2: Commit (skip if no changes)**

No commit needed if no code changes.

---

## Task 9: Tests for Workspace Session Launch

**Files:**
- Create: `test/workspace-groups.test.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Add resolveSessionSettings workspace cascade test**

In `test/config.test.ts`, add a test case for workspace settings cascade. Find the describe block for `resolveSessionSettings` and add:

```typescript
  it('cascades workspace settings when workspaceId is provided', () => {
    const config: Config = {
      ...DEFAULTS,
      configVersion: 4,
      repos: ['/tmp/test-repo'],
      workspaces: [{
        id: 'ws-1',
        name: 'test workspace',
        repos: ['/tmp/test-repo'],
        order: 0,
        settings: {
          defaultYolo: true,
          defaultAgent: 'claude',
        },
      }],
      repoSettings: {},
    };

    const result = resolveSessionSettings(config, '/tmp/test-repo', {}, 'ws-1');
    assert.strictEqual(result.yolo, true, 'workspace settings should cascade yolo');
    assert.strictEqual(result.agent, 'claude');
  });

  it('repo settings override workspace settings', () => {
    const config: Config = {
      ...DEFAULTS,
      configVersion: 4,
      repos: ['/tmp/test-repo'],
      workspaces: [{
        id: 'ws-1',
        name: 'test workspace',
        repos: ['/tmp/test-repo'],
        order: 0,
        settings: {
          defaultYolo: true,
        },
      }],
      repoSettings: {
        '/tmp/test-repo': { defaultYolo: false },
      },
    };

    const result = resolveSessionSettings(config, '/tmp/test-repo', {}, 'ws-1');
    assert.strictEqual(result.yolo, false, 'repo settings should override workspace');
  });
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass including new ones

- [ ] **Step 3: Commit**

```bash
git add test/config.test.ts
git commit -m "test: workspace settings cascade in resolveSessionSettings"
```

---

## Task 10: Final Build + Smoke Test

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean build with zero errors

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Verify server starts**

Run: `npm start` (briefly, then Ctrl+C)
Expected: Server starts without errors, logs "Listening on..."

- [ ] **Step 4: Final commit if any stragglers**

```bash
git status
# If any unstaged changes, commit them
```
