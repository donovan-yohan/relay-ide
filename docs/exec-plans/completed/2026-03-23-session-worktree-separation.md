# Session/Worktree Separation Implementation Plan

> **Status**: Complete | **Created**: 2026-03-23 | **Last Updated**: 2026-03-23
> **Design Doc**: `docs/design-docs/2026-03-23-session-worktree-separation-design.md`
> **For Claude:** Use /harness:orchestrate to execute this plan.

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-23 | Design | Session type = `'agent' \| 'terminal'` | `'repo' \| 'worktree'` conflated location with process type |
| 2026-03-23 | Design | Nullable `worktreePath` on sessions | Explicit foreign key is cleaner than path-prefix matching |
| 2026-03-23 | Design | Per-workspace mountain counter only | Global counter desynced, caused name collisions |
| 2026-03-23 | Eng Review | Full v2→v3 session persistence migration | Users must not lose sessions on update |
| 2026-03-23 | Eng Review | Clean `repoPath` → `cwd` rename (no aliases) | No external consumers, clean break is simpler |
| 2026-03-23 | Eng Review | `cwd` validation before PTY spawn | Prevents confusing errors when worktree deleted between API calls |

## Progress

- [x] Task 1: Update server type definitions
- [x] Task 2: Update session registry + persistence migration
- [x] Task 3: Add collision-retry to worktree endpoint
- [x] Task 4: Rewrite POST /sessions (unified, simplified)
- [x] Task 5: Update frontend types and API client
- [x] Task 6: Update frontend components
- [x] Task 7: Update hooks and remaining server references
- [x] Task 8: Update and add tests
- [x] Task 9: Update documentation

## Surprises & Discoveries

_None yet — updated during execution by /harness:orchestrate._

## Plan Drift

_None yet — updated when tasks deviate from plan during execution._

---

## File Structure

```
MODIFIED FILES:
  server/types.ts              — SessionType, BaseSession, PtySession, SessionSummary, Config
  server/sessions.ts           — CreateParams, create(), list(), SerializedPtySession, restoreFromDisk()
  server/workspaces.ts         — POST /workspaces/worktree collision retry + stale branch
  server/index.ts              — Rewrite POST /sessions, delete /repo + /terminal endpoints
  server/hooks.ts              — Rename repoPath → cwd references
  frontend/src/lib/types.ts    — SessionSummary, remove OpenSessionOptions unused fields
  frontend/src/lib/api.ts      — Update createSession(), delete createRepoSession/createTerminalSession
  frontend/src/App.svelte      — All handler updates
  frontend/src/components/Sidebar.svelte        — groupedByPath key change
  frontend/src/components/WorkspaceItem.svelte  — groupDisplayName type check
  frontend/src/components/dialogs/CustomizeSessionDialog.svelte — use createSession()
  frontend/src/lib/state/sessions.svelte.ts     — getSessionsForWorkspace()
  test/sessions.test.ts        — Update for new types + add migration tests
  test/worktrees.test.ts       — Add collision-retry tests
```

---

### Task 1: Update Server Type Definitions

**Goal:** Change the foundational types that everything else depends on.

**Files:**
- Modify: `server/types.ts`

- [ ] **Step 1: Update SessionType**

Change line 6:
```typescript
// Before
export type SessionType = 'repo' | 'worktree' | 'terminal';

// After
export type SessionType = 'agent' | 'terminal';
```

- [ ] **Step 2: Update BaseSession interface**

In `BaseSession` (lines 28-47), replace `repoPath`, `worktreeName`, `root` with new fields:
```typescript
interface BaseSession {
  id: string;
  type: SessionType;
  agent: AgentType;
  mode: SessionMode;
  workspacePath: string;          // was: root (partially) — workspace this belongs to
  worktreePath: string | null;    // NEW — null = repo root session
  cwd: string;                    // was: repoPath — actual directory PTY runs in
  repoName: string;
  branchName: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  idle: boolean;
  customCommand: string | null;
  status: SessionStatus;
  needsBranchRename: boolean;
  agentState: AgentState;
}
```

Remove: `root`, `repoPath`, `worktreeName`.
Add: `workspacePath`, `worktreePath`, `cwd`.

- [ ] **Step 3: Update PtySession interface**

`PtySession` extends `BaseSession` so inherits the changes. No additional modifications needed for the new fields. Verify the `cwd` field in the existing `PtySession` at line 43 — it already has `cwd: string` in `BaseSession`, so this is just removing `repoPath` and adding `workspacePath`/`worktreePath`.

- [ ] **Step 4: Update SessionSummary interface**

Mirror the same field changes in `SessionSummary` (lines 73-95):
```typescript
export interface SessionSummary {
  id: string;
  type: SessionType;
  agent: AgentType;
  mode: SessionMode;
  workspacePath: string;
  worktreePath: string | null;
  cwd: string;
  repoName: string;
  branchName: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  idle: boolean;
  customCommand: string | null;
  useTmux: boolean;
  tmuxSessionName: string;
  status: SessionStatus;
  needsBranchRename: boolean;
  agentState: AgentState;
  currentActivity?: { tool: string; detail?: string } | undefined;
}
```

Remove: `root`, `repoPath`, `worktreeName`.

- [ ] **Step 5: Remove global nextMountainIndex from Config**

In `Config` interface (line ~157), remove `nextMountainIndex?: number`. The per-workspace `WorkspaceSettings.nextMountainIndex` (line 126) stays.

- [ ] **Step 6: Build to verify type errors propagate**

Run: `npx tsc --noEmit 2>&1 | head -50`
Expected: Many type errors in sessions.ts, index.ts, hooks.ts, etc. — this is correct. The errors show us every file that needs updating.

- [ ] **Step 7: Commit**
```bash
git add server/types.ts
git commit -m "refactor: update session types — agent|terminal, workspacePath, worktreePath, cwd"
```

---

### Task 2: Update Session Registry + Persistence Migration

**Goal:** Update `sessions.ts` to use new types and add v2→v3 migration for session persistence.

**Files:**
- Modify: `server/sessions.ts`

- [ ] **Step 1: Update SerializedPtySession (v3 format)**

Replace the interface (lines 15-33):
```typescript
interface SerializedPtySession {
  id: string;
  type: SessionType;
  agent: AgentType;
  workspacePath: string;
  worktreePath: string | null;
  cwd: string;
  repoName: string;
  branchName: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  useTmux: boolean;
  tmuxSessionName: string;
  customCommand: string | null;
  yolo?: boolean;
  claudeArgs?: string[];
}

interface PendingSessionsFile {
  version: number;  // now 3
  timestamp: string;
  sessions: SerializedPtySession[];
}
```

Remove: `root`, `repoPath`, `worktreeName`.

- [ ] **Step 2: Update create() function**

In `create()` (line 115), the `...rest` spread from `CreateParams` will now include `workspacePath`, `worktreePath`, `cwd` instead of `repoPath`, `root`, `worktreeName`. No changes to the function body needed — it passes `rest` through to `createPtySession()`.

Update `CreateParams` type to match new `CreatePtyParams` (which derives from the updated types). Verify `CreatePtyParams` in `pty-handler.ts` also uses the new field names.

- [ ] **Step 3: Update list() function**

In `list()` (line 176), update the `SessionSummary` mapping:
```typescript
function list(): SessionSummary[] {
  return Array.from(sessions.values())
    .map((s): SessionSummary => ({
      id: s.id,
      type: s.type,
      agent: s.agent,
      mode: s.mode,
      workspacePath: s.workspacePath,
      worktreePath: s.worktreePath,
      cwd: s.cwd,
      repoName: s.repoName,
      branchName: s.branchName,
      displayName: s.displayName,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      idle: s.idle,
      customCommand: s.customCommand,
      useTmux: s.useTmux,
      tmuxSessionName: s.tmuxSessionName,
      status: s.status,
      needsBranchRename: s.needsBranchRename,
      agentState: s.agentState,
      currentActivity: s.currentActivity,
    }))
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
}
```

- [ ] **Step 4: Remove findRepoSession()**

Delete `findRepoSession()` (lines 265-267) and remove it from the exports object (line ~510). Search for callers — `index.ts` uses it in the old `POST /sessions` endpoint which is being rewritten.

- [ ] **Step 5: Update serializeAll()**

In `serializeAll()` (line 277), update the serialized fields:
```typescript
const serialized: SerializedPtySession = {
  id: s.id,
  type: s.type,
  agent: s.agent,
  workspacePath: s.workspacePath,
  worktreePath: s.worktreePath,
  cwd: s.cwd,
  repoName: s.repoName,
  branchName: s.branchName,
  displayName: s.displayName,
  createdAt: s.createdAt,
  lastActivity: s.lastActivity,
  useTmux: s.useTmux,
  tmuxSessionName: s.tmuxSessionName || '',
  customCommand: s.customCommand,
  yolo: s.yolo,
  claudeArgs: s.claudeArgs,
};
```

Set `version: 3` in the written file.

- [ ] **Step 6: Add v2→v3 migration in restoreFromDisk()**

At the top of `restoreFromDisk()` (line ~318), after parsing the JSON, add migration logic:
```typescript
// v2 → v3 migration
if (pending.version <= 2) {
  for (const s of pending.sessions) {
    const legacy = s as SerializedPtySession & { repoPath?: string; root?: string; worktreeName?: string };
    if (!('cwd' in s) && legacy.repoPath) {
      (s as any).cwd = legacy.repoPath;
    }
    if (!('workspacePath' in s)) {
      // Derive workspacePath: find configured workspace that contains this cwd
      const configuredWorkspaces = config.workspaces ?? [];
      const cwd = (s as any).cwd ?? legacy.repoPath ?? '';
      (s as any).workspacePath = configuredWorkspaces.find(w => cwd === w || cwd.startsWith(w + '/')) ?? cwd;
    }
    if (!('worktreePath' in s)) {
      const cwd = (s as any).cwd ?? '';
      const workspacePath = (s as any).workspacePath ?? '';
      // If cwd differs from workspacePath, it's a worktree
      (s as any).worktreePath = cwd !== workspacePath ? cwd : null;
    }
    // Map old types to new
    if ((s as any).type === 'repo' || (s as any).type === 'worktree') {
      (s as any).type = 'agent';
    }
    // Clean up legacy fields
    delete legacy.repoPath;
    delete legacy.root;
    delete legacy.worktreeName;
  }
}
```

Then update the rest of `restoreFromDisk()` to use `s.cwd` instead of `s.repoPath` and `s.workspacePath`/`s.worktreePath` instead of `s.root`.

- [ ] **Step 7: Update pty-handler.ts CreatePtyParams**

Check `server/pty-handler.ts` for `CreatePtyParams`. Update it to use `workspacePath`, `worktreePath`, `cwd` instead of `repoPath`, `root`, `worktreeName`.

- [ ] **Step 8: Build to check progress**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: Fewer errors — sessions.ts and types.ts should compile. Remaining errors in index.ts, hooks.ts, frontend.

- [ ] **Step 9: Commit**
```bash
git add server/sessions.ts server/pty-handler.ts
git commit -m "refactor: update session registry — new fields, v2→v3 migration, remove findRepoSession"
```

---

### Task 3: Add Collision-Retry to Worktree Endpoint

**Goal:** Fix the original bug — mountain name collision. Unify counter to per-workspace only.

**Files:**
- Modify: `server/workspaces.ts`

- [ ] **Step 1: Add collision-retry loop**

In `POST /workspaces/worktree` (workspaces.ts:582-597), replace the current single-attempt mountain name selection with a retry loop:

```typescript
} else {
  // Create a new branch using the next mountain name — with collision retry
  const baseIndex = settings.nextMountainIndex ?? 0;
  let found = false;

  for (let attempt = 0; attempt < MOUNTAIN_NAMES.length; attempt++) {
    const candidateIndex = (baseIndex + attempt) % MOUNTAIN_NAMES.length;
    const candidateName = MOUNTAIN_NAMES[candidateIndex] ?? 'everest';
    const candidateBranch = (settings.branchPrefix ?? '') + candidateName;
    const candidatePath = path.join(resolved, '.worktrees', candidateName);

    // Check if branch or directory already exists
    const branchExists = await exec('git', ['rev-parse', '--verify', candidateBranch], { cwd: resolved }).then(() => true, () => false);
    const dirExists = fs.existsSync(candidatePath);

    if (!branchExists && !dirExists) {
      mountainName = candidateName;
      branchName = candidateBranch;
      nextMountainIndex = candidateIndex + 1;
      found = true;
      break;
    }
  }

  if (!found) {
    res.status(409).json({ error: 'All mountain names are taken for this workspace. Delete some worktrees first.' });
    return;
  }

  // Detect base branch
  let baseBranch = settings.defaultBranch;
  if (!baseBranch) {
    const detected = await detectGitRepo(resolved);
    baseBranch = detected.defaultBranch ?? 'main';
  }

  gitArgs = ['worktree', 'add', '-b', branchName, path.join(resolved, '.worktrees', mountainName), baseBranch];
}
```

- [ ] **Step 2: Move stale branch detection from index.ts**

Add a helper function near the top of the `POST /workspaces/worktree` handler (or as a local function) that handles stale branch detection for existing worktrees. This moves the logic from `server/index.ts` lines 896-914.

This applies when `existingBranch` is provided and the worktree already exists — but this is the `branch` parameter path, not the mountain name path. The stale detection is actually part of the "resume existing worktree" flow, which happens at session creation time. On reflection, stale branch detection for *existing* worktrees stays as session-level concern (it's about whether to `--continue`). What moves here is the mountain name uniqueness, which is now handled by the collision-retry loop above.

Update: skip stale branch detection move — it's already handled correctly. The collision-retry is the fix.

- [ ] **Step 3: Build to verify**

Run: `npx tsc --noEmit 2>&1 | grep workspaces`
Expected: workspaces.ts compiles clean.

- [ ] **Step 4: Commit**
```bash
git add server/workspaces.ts
git commit -m "fix: add mountain name collision-retry to worktree creation endpoint"
```

---

### Task 4: Rewrite POST /sessions (Unified, Simplified)

**Goal:** Replace the 200-line monster with a ~50-line endpoint. Delete `/sessions/repo` and `/sessions/terminal`.

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Rewrite POST /sessions**

Replace the entire `POST /sessions` handler (lines 810-1110) with:

```typescript
app.post('/sessions', requireAuth, async (req, res) => {
  const {
    workspacePath, worktreePath, type = 'agent', agent, yolo, useTmux,
    claudeArgs, cols, rows, needsBranchRename, branchRenamePrompt,
    initialPrompt, continue: explicitContinue, ticketContext,
  } = req.body as {
    workspacePath?: string;
    worktreePath?: string | null;
    type?: 'agent' | 'terminal';
    agent?: AgentType;
    yolo?: boolean;
    useTmux?: boolean;
    claudeArgs?: string[];
    cols?: number;
    rows?: number;
    needsBranchRename?: boolean;
    branchRenamePrompt?: string;
    initialPrompt?: string;
    continue?: boolean;
    ticketContext?: { ticketId: string; title: string; description?: string; url: string; source: 'github' | 'jira'; repoPath: string; repoName: string };
  };

  if (!workspacePath) {
    res.status(400).json({ error: 'workspacePath is required' });
    return;
  }

  // Validate workspacePath is a configured workspace
  const configuredWorkspaces = config.workspaces ?? [];
  if (!configuredWorkspaces.includes(workspacePath)) {
    res.status(400).json({ error: 'workspacePath is not a configured workspace' });
    return;
  }

  const cwd = worktreePath ?? workspacePath;

  // Validate cwd directory exists
  if (!fs.existsSync(cwd)) {
    res.status(400).json({ error: `Directory does not exist: ${cwd}` });
    return;
  }

  const safeCols = typeof cols === 'number' && Number.isFinite(cols) && cols >= 1 && cols <= 500 ? Math.round(cols) : undefined;
  const safeRows = typeof rows === 'number' && Number.isFinite(rows) && rows >= 1 && rows <= 200 ? Math.round(rows) : undefined;

  const name = workspacePath.split('/').filter(Boolean).pop() || 'session';

  if (type === 'terminal') {
    // Terminal session — bare shell
    const shell = process.env.SHELL || '/bin/sh';
    const displayName = sessions.nextTerminalName();
    const session = sessions.create({
      type: 'terminal',
      agent: 'claude' as AgentType,
      repoName: name,
      workspacePath,
      worktreePath: worktreePath ?? null,
      cwd,
      displayName,
      branchName: '',
      command: shell,
      args: [],
      ...(safeCols != null && { cols: safeCols }),
      ...(safeRows != null && { rows: safeRows }),
    });
    res.status(201).json(session);
    return;
  }

  // Agent session
  const resolved = resolveSessionSettings(config, workspacePath, { agent, yolo, useTmux, claudeArgs });
  const resolvedAgent = resolved.agent;

  const baseArgs = [
    ...(resolved.claudeArgs),
    ...(resolved.yolo ? AGENT_YOLO_ARGS[resolvedAgent] : []),
  ];

  // Determine --continue behavior
  let useContinue = false;
  if (explicitContinue !== undefined) {
    useContinue = explicitContinue;
  } else if (needsBranchRename) {
    useContinue = false;  // brand new worktree
  } else {
    useContinue = fs.existsSync(path.join(cwd, '.claude'));
  }

  const args = useContinue
    ? [...AGENT_CONTINUE_ARGS[resolvedAgent], ...baseArgs]
    : [...baseArgs];

  // Handle ticket context / initial prompt
  let computedInitialPrompt: string | undefined = initialPrompt;
  if (ticketContext) {
    // ... ticket validation and prompt template (keep existing logic)
  }

  const displayName = sessions.nextAgentName();
  const session = sessions.create({
    type: 'agent',
    agent: resolvedAgent,
    repoName: name,
    workspacePath,
    worktreePath: worktreePath ?? null,
    cwd,
    branchName: '',  // populated by branch watcher
    displayName,
    args,
    configPath: CONFIG_PATH,
    useTmux: resolved.useTmux,
    yolo: resolved.yolo,
    claudeArgs: resolved.claudeArgs,
    ...(safeCols != null && { cols: safeCols }),
    ...(safeRows != null && { rows: safeRows }),
    needsBranchRename: needsBranchRename ?? false,
    branchRenamePrompt: branchRenamePrompt ?? '',
    ...(computedInitialPrompt != null && { initialPrompt: computedInitialPrompt }),
  });

  // Write worktree metadata if in a worktree
  if (worktreePath) {
    writeMeta(CONFIG_PATH, {
      worktreePath: cwd,
      displayName,
      lastActivity: new Date().toISOString(),
      branchName: '',
    });
  }

  if (ticketContext) {
    transitionOnSessionCreate(ticketContext).catch((err: unknown) => {
      console.error('[index] transition on session create failed:', err);
    });
  }

  res.status(201).json(session);
});
```

- [ ] **Step 2: Delete POST /sessions/repo endpoint**

Remove the entire `app.post('/sessions/repo', ...)` handler (lines ~1115-1175).

- [ ] **Step 3: Delete POST /sessions/terminal endpoint**

Remove the entire `app.post('/sessions/terminal', ...)` handler (lines ~1180-1210).

- [ ] **Step 4: Update GET /sessions branch enrichment**

In `GET /sessions` (line ~583), change the type check:
```typescript
// Before
if (s.type !== 'repo' && s.type !== 'worktree') return;

// After
if (s.type !== 'agent') return;
```

And the cwd resolution:
```typescript
// Before
const cwd = s.type === 'repo' ? s.repoPath : s.cwd;

// After — cwd is always correct now
const sessionCwd = s.cwd;
```

- [ ] **Step 5: Remove global nextMountainIndex usage**

Delete any remaining references to `config.nextMountainIndex` in index.ts. The worktree endpoint in workspaces.ts owns mountain names exclusively.

- [ ] **Step 6: Remove isBranchStale import if unused**

Check if `isBranchStale` is still needed in index.ts after removing worktree creation. If only used in the deleted code, remove the import.

- [ ] **Step 7: Remove WORKTREE_DIRS/ensureGitignore usage from POST /sessions**

These were only needed for inline worktree creation. Verify they're still used elsewhere in index.ts (they might be used in `GET /worktrees`). If not, remove the imports.

- [ ] **Step 8: Build to verify**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: index.ts compiles. Frontend still has errors (expected — not updated yet).

- [ ] **Step 9: Commit**
```bash
git add server/index.ts
git commit -m "refactor: unified POST /sessions — zero git awareness, delete /repo and /terminal endpoints"
```

---

### Task 5: Update Frontend Types and API Client

**Goal:** Update frontend to match new server contracts.

**Files:**
- Modify: `frontend/src/lib/types.ts`
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Update frontend SessionSummary**

In `frontend/src/lib/types.ts` (lines 11-27):
```typescript
export interface SessionSummary {
  id: string;
  type: 'agent' | 'terminal';
  agent: AgentType;
  mode?: 'pty' | undefined;
  repoName: string;
  workspacePath: string;
  worktreePath: string | null;
  cwd: string;
  branchName: string;
  displayName: string;
  createdAt: string;
  lastActivity: string;
  idle: boolean;
  useTmux?: boolean | undefined;
  status?: 'active' | 'disconnected' | undefined;
  agentState?: AgentState | undefined;
}
```

Remove: `repoPath`, `worktreeName`.

- [ ] **Step 2: Update createSession() in api.ts**

Update the function signature (lines 172-205):
```typescript
export async function createSession(body: {
  workspacePath: string;
  worktreePath?: string | null;
  type?: 'agent' | 'terminal';
  agent?: string;
  yolo?: boolean;
  useTmux?: boolean;
  claudeArgs?: string[];
  continue?: boolean;
  cols?: number;
  rows?: number;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
  initialPrompt?: string;
  ticketContext?: { ... };
}): Promise<SessionSummary> {
  // body unchanged — POST /sessions
}
```

Remove `repoPath`, `repoName` params. Add `workspacePath`, `worktreePath`, `type`.

- [ ] **Step 3: Delete createRepoSession()**

Remove the entire function (lines 207-228). All callers will be updated in Task 6.

- [ ] **Step 4: Delete createTerminalSession()**

Remove the entire function (lines 230-237). All callers will be updated in Task 6.

- [ ] **Step 5: Commit**
```bash
git add frontend/src/lib/types.ts frontend/src/lib/api.ts
git commit -m "refactor: update frontend types and API — unified createSession, remove createRepoSession/createTerminalSession"
```

---

### Task 6: Update Frontend Components

**Goal:** Update all frontend components to use new session fields and unified API.

**Files:**
- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/components/Sidebar.svelte`
- Modify: `frontend/src/components/WorkspaceItem.svelte`
- Modify: `frontend/src/components/dialogs/CustomizeSessionDialog.svelte`
- Modify: `frontend/src/lib/state/sessions.svelte.ts`

- [ ] **Step 1: Update App.svelte imports**

Remove `createRepoSession`, `createTerminalSession` imports (line 11). Keep `createSession`, `createWorktree`.

- [ ] **Step 2: Update handleQuickAgent()**

In `handleQuickAgent()` (line ~394):
```typescript
async function handleQuickAgent() {
  if (!activeWorkspace) return;
  const { cols, rows } = estimateTerminalDimensions();
  try {
    const session = await createSession({
      workspacePath: activeWorkspace.path,
      worktreePath: activeSession?.worktreePath ?? null,
      type: 'agent',
      agent: configState.defaultAgent,
      yolo: configState.defaultYolo,
      useTmux: configState.launchInTmux,
      cols,
      rows,
    });
    // ... rest unchanged
  }
}
```

- [ ] **Step 3: Update handleQuickTerminal()**

In `handleQuickTerminal()` (line ~426):
```typescript
async function handleQuickTerminal() {
  if (!activeWorkspace) return;
  try {
    const session = await createSession({
      workspacePath: activeWorkspace.path,
      worktreePath: activeSession?.worktreePath ?? null,
      type: 'terminal',
    });
    // ... rest unchanged
  }
}
```

- [ ] **Step 4: Update handleNewWorktree()**

In `handleNewWorktree()` (line ~454):
```typescript
const session = await createSession({
  workspacePath: workspace.path,
  worktreePath: worktreePath,
  type: 'agent',
  needsBranchRename: true,
});
```

Update the catch block to log the error instead of silently opening dialog:
```typescript
} catch (e) {
  console.error('Failed to create worktree session:', e);
  // Show error inline or via toast — NOT CustomizeSessionDialog
}
```

- [ ] **Step 5: Update handleFixConflicts() and handleOpenPrSession()**

Replace `createSession({ repoPath, worktreePath, branchName, ... })` calls with:
```typescript
const session = await createSession({
  workspacePath: workspacePath,
  worktreePath: worktreePath,
  type: 'agent',
  // ... other fields
});
```

- [ ] **Step 6: Update handleCustomize()**

In `CustomizeSessionDialog.svelte` `handleSubmit()` (line 55-91):
```typescript
const session = await createSession({
  workspacePath: workspacePath,
  worktreePath: null,  // customize creates repo-root sessions
  type: 'agent',
  agent: selectedAgent,
  yolo: yoloMode,
  continue: continueExisting,
  useTmux,
  claudeArgs: claudeArgs.length > 0 ? claudeArgs : undefined,
  cols,
  rows,
});
```

Import `createSession` instead of `createRepoSession`.

- [ ] **Step 7: Update Sidebar groupedByPath**

In `Sidebar.svelte` (lines 234 and 273), change the grouping key:
```typescript
{@const groupedByPath = (() => {
  const groups = new Map<string, typeof activeSessions>();
  groups.set(workspace.path, []);
  for (const s of activeSessions) {
    const groupKey = s.worktreePath ?? s.workspacePath;
    const existing = groups.get(groupKey);
    if (existing) existing.push(s);
    else groups.set(groupKey, [s]);
  }
  return groups;
})()}
```

- [ ] **Step 8: Update WorkspaceItem groupDisplayName()**

In `WorkspaceItem.svelte` (lines 80-95):
```typescript
function groupDisplayName(groupPath: string, sessions: SessionSummary[]): string {
  const isRepoRoot = groupPath === workspace.path;
  if (isRepoRoot) {
    // Repo root sessions — check for user rename
    const agentSession = sessions.find(s => s.worktreePath === null && s.type === 'agent');
    if (agentSession) {
      const wasRenamed = agentSession.displayName && agentSession.displayName !== agentSession.repoName;
      return wasRenamed ? agentSession.displayName : 'default';
    }
    return 'default';
  }
  // Worktree sessions — use branch name
  const branch = sessions.find(s => s.branchName)?.branchName;
  return branch || sessions[0]?.cwd.split('/').pop() || sessions[0]?.repoName || 'unknown';
}
```

- [ ] **Step 9: Update getSessionsForWorkspace()**

In `sessions.svelte.ts` (line 97-101):
```typescript
export function getSessionsForWorkspace(workspacePath: string): SessionSummary[] {
  return sessions.filter(s => s.workspacePath === workspacePath);
}
```

- [ ] **Step 10: Update any remaining repoPath references in App.svelte**

Search for `repoPath` in App.svelte and replace with appropriate new field (`cwd`, `workspacePath`, or `worktreePath`). Key spots:
- `activeSession.repoPath` → `activeSession.cwd`
- Session workspace matching → `activeSession.workspacePath`

- [ ] **Step 11: Build frontend**

Run: `npm run build 2>&1 | tail -20`
Expected: Frontend builds successfully.

- [ ] **Step 12: Commit**
```bash
git add frontend/
git commit -m "refactor: update frontend components — unified createSession, explicit workspacePath/worktreePath grouping"
```

---

### Task 7: Update Hooks and Remaining Server References

**Goal:** Update hooks.ts and any other server files that reference old field names.

**Files:**
- Modify: `server/hooks.ts`
- Modify: `server/index.ts` (remaining refs)

- [ ] **Step 1: Update hooks.ts repoPath references**

In `hooks.ts` line ~111:
```typescript
// Before
writeMeta(deps.configPath, { worktreePath: session.repoPath, displayName, lastActivity, branchName });

// After
writeMeta(deps.configPath, { worktreePath: session.cwd, displayName, lastActivity, branchName });
```

Also update session.type references if they check for `'repo'` or `'worktree'`.

- [ ] **Step 2: Search for remaining repoPath/worktreeName references**

Run: `grep -rn 'repoPath\|worktreeName\|\.root' server/ --include='*.ts' | grep -v node_modules | grep -v '.d.ts'`

Fix any remaining references.

- [ ] **Step 3: Full build**

Run: `npm run build 2>&1 | tail -20`
Expected: Everything compiles.

- [ ] **Step 4: Commit**
```bash
git add server/
git commit -m "refactor: update hooks and remaining server refs — repoPath→cwd rename complete"
```

---

### Task 8: Update and Add Tests

**Goal:** Update existing tests for new types and add tests for collision-retry and v2→v3 migration.

**Files:**
- Modify: `test/sessions.test.ts`
- Modify: `test/worktrees.test.ts`

- [ ] **Step 1: Update sessions.test.ts — fix all type references**

Replace all `repoPath` with `cwd`, `type: 'worktree'` with `type: 'agent'`, `type: 'repo'` with `type: 'agent'`, add `workspacePath` and `worktreePath` to create() calls. Remove `findRepoSession()` tests.

- [ ] **Step 2: Add v2→v3 migration tests**

Add to `test/sessions.test.ts` in the `session persistence` describe block:
```typescript
it('migrates v2 format with type:repo to v3 with type:agent and worktreePath:null', async () => {
  // Write a v2 pending-sessions.json with type:'repo', repoPath, root
  // Call restoreFromDisk()
  // Verify: type='agent', workspacePath derived, worktreePath=null, cwd=old repoPath
});

it('migrates v2 format with type:worktree to v3 with type:agent and worktreePath set', async () => {
  // Write a v2 file with type:'worktree', repoPath pointing to worktree dir
  // Call restoreFromDisk()
  // Verify: type='agent', workspacePath derived from parent, worktreePath=repoPath, cwd=repoPath
});

it('migrates v2 format with type:terminal to v3 with type:terminal', async () => {
  // Write a v2 file with type:'terminal'
  // Call restoreFromDisk()
  // Verify: type='terminal', worktreePath=null
});
```

- [ ] **Step 3: Add collision-retry tests to worktrees.test.ts**

Add a new describe block:
```typescript
describe('mountain name collision retry', () => {
  it('skips to next name when branch already exists', () => {
    // Mock exec to fail on 'everest' (branch exists), succeed on 'kilimanjaro'
    // Verify worktree created with 'kilimanjaro'
  });

  it('skips to next name when directory already exists', () => {
    // Create .worktrees/everest directory
    // Verify worktree created with 'kilimanjaro'
  });

  it('returns 409 when all mountain names are taken', () => {
    // Mock all 30 names as existing
    // Verify 409 response
  });

  it('increments nextMountainIndex to first free slot', () => {
    // Mock everest and kilimanjaro as taken
    // Verify nextMountainIndex set to 3 (denali's index + 1)
  });
});
```

- [ ] **Step 4: Add unified POST /sessions tests**

Add tests verifying:
- `POST /sessions` with `worktreePath: null` creates agent in repo root
- `POST /sessions` with `type: 'terminal'` creates terminal session
- `POST /sessions` with `worktreePath` set creates agent in worktree
- `POST /sessions` without `workspacePath` returns 400
- `POST /sessions` with non-existent `cwd` returns 400
- `POST /sessions` auto-detects `--continue` from `.claude/` directory

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**
```bash
git add test/
git commit -m "test: update session tests for new types, add collision-retry and v2→v3 migration tests"
```

---

### Task 9: Update Documentation

**Goal:** Update ARCHITECTURE.md, FRONTEND.md, and DESIGN.md to reflect new API contracts.

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/FRONTEND.md`
- Modify: `docs/DESIGN.md`

- [ ] **Step 1: Update ARCHITECTURE.md REST API table**

Replace the session endpoints:
```markdown
| `POST` | `/sessions` | Create session (agent or terminal, in workspace root or worktree) |
```
Remove `/sessions/repo` and `/sessions/terminal` rows. Update the description for `POST /sessions`.

- [ ] **Step 2: Update DESIGN.md Session Types section**

Rewrite the Session Types section to reflect the new model:
- Sessions are `'agent' | 'terminal'`
- Sessions have `workspacePath` + nullable `worktreePath`
- No more `'repo' | 'worktree'` distinction

- [ ] **Step 3: Update FRONTEND.md Key Patterns**

Update the tab bar and session creation API patterns to reference the unified `createSession()`.

- [ ] **Step 4: Commit**
```bash
git add docs/
git commit -m "docs: update architecture, design, and frontend docs for session/worktree separation"
```

---

## Outcomes & Retrospective

_Filled by /harness:complete when work is done._

**What worked:**
- Parallel agent dispatch for independent tasks (2+3, 7+8+9) cut wall-clock time significantly
- Types-first approach meant downstream tasks had clear compilation errors guiding them
- Net code deletion (-146 lines) confirms this was a simplification, not an expansion

**What didn't:**
- Parallel agents on Tasks 2 and 4 touched overlapping files (index.ts), requiring a merge fixup pass
- The review flagged startsWith→=== as a regression, but it was intentional — the reviewer lacked design context

**Learnings to codify:**
- When two counters track the same resource (global vs per-workspace mountain index), they WILL desync — always unify to one source of truth
- Session creation endpoints should be process-type-agnostic — the "what" (agent/terminal) and "where" (workspace/worktree) are orthogonal
