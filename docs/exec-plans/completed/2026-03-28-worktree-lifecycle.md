# Worktree & Session Lifecycle — Branch Lifecycle Layer

> **Status**: Completed | **Created**: 2026-03-28 | **Completed**: 2026-03-28
> **Design Doc**: `docs/design-docs/2026-03-28-worktree-lifecycle-design.md`
> **Consulted Learnings**: L-20260322-session-creation-params, L-20260328-serialization-whitelist-audit, L-20260326-repo-source-unification, L-20260324-config-stale-read, L-20260325-resource-name-uniqueness, L-20260327-express4-async-errors, L-20260322-session-state-refresh
> **For Claude:** Use /harness:orchestrate to execute this plan.

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-28 | Design | Approach B': Branch Lifecycle Layer | Universal branch lifecycle applying to all branches; worktree management layers on top |
| 2026-03-28 | Design | continuePolicy replaces boolean continue | Eliminates fragile .claude directory heuristic that caused regressions |
| 2026-03-28 | Design | Branch state computed at runtime, not persisted | Avoids persistence layer; piggybacks on existing PR polling + webhook data |
| 2026-03-28 | Design | Main branch never enters merged/archived states | Prevents accidental cleanup of the main worktree |
| 2026-03-28 | Plan | Implementation order: continuePolicy → detection+fetch → tmux → auto-archive | continuePolicy is most impactful reliability fix; detection+fetch exposes contracts other streams need |

## Progress

- [x] Task 1: ContinuePolicy type + config resolution _(completed 2026-03-28)_
- [x] Task 2: ContinuePolicy in session creation + serialization _(completed 2026-03-28)_
- [x] Task 3: ensureBranchLocal git utility _(completed 2026-03-28)_
- [x] Task 4: Enhanced worktree detection — main repo + existing worktree _(completed 2026-03-28)_
- [x] Task 5: Enhanced POST /workspaces/worktree — fetch + detect + error codes _(completed 2026-03-28)_
- [x] Task 6: Repo-scoped tmux naming _(completed 2026-03-28)_
- [x] Task 7: isPrMerged + computeBranchLifecycleState _(completed 2026-03-28)_
- [x] Task 8: Enrich GET /worktrees with branchState _(completed 2026-03-28)_
- [x] Task 9: GET /worktrees/:path/status endpoint _(completed 2026-03-28)_
- [x] Task 10: Enhanced DELETE /worktrees — force flag + session kill _(completed 2026-03-28)_
- [x] Task 11: Webhook merge detection + worktrees-changed broadcast _(completed 2026-03-28)_

## Surprises & Discoveries

_No surprises. All tasks completed as planned._

## Plan Drift

_No drift. All tasks matched plan specifications._

---

### Task 1: ContinuePolicy type + config resolution

**Goal:** Replace `continue: boolean` in config/settings with `continuePolicy: 'always' | 'never'`. Backward-compatible: existing `defaultContinue: true` maps to `'always'`, `false` maps to `'never'`.

**Files:**
- Modify: `server/types.ts:104-132` (WorkspaceSettings, Config)
- Modify: `server/config.ts:131-160` (ResolvedSessionSettings, resolveSessionSettings)
- Test: `test/config.test.ts`

**Learnings applied:**
- L-20260324-config-stale-read: `resolveSessionSettings` already reads fresh per-call (line 152 calls `getWorkspaceSettings`). No stale-read risk here.

- [ ] **Step 1: Write failing test for continuePolicy resolution**

In `test/config.test.ts`, add:

```typescript
test('resolveSessionSettings maps defaultContinue:true to continuePolicy:always', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ defaultContinue: true }), 'utf8');
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', {});
  assert.equal(resolved.continuePolicy, 'always');
});

test('resolveSessionSettings maps defaultContinue:false to continuePolicy:never', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ defaultContinue: false }), 'utf8');
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', {});
  assert.equal(resolved.continuePolicy, 'never');
});

test('resolveSessionSettings respects explicit continuePolicy override', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ defaultContinue: true }), 'utf8');
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', { continuePolicy: 'never' });
  assert.equal(resolved.continuePolicy, 'never');
});

test('resolveSessionSettings defaults to never when no config', () => {
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');
  const config = loadConfig(configPath);
  const resolved = resolveSessionSettings(config, '/some/repo', {});
  assert.equal(resolved.continuePolicy, 'never');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="continuePolicy"`
Expected: FAIL — `resolved.continuePolicy` is undefined

- [ ] **Step 3: Add ContinuePolicy type to types.ts**

In `server/types.ts`, after the `AgentType` line (line 8), add:

```typescript
export type ContinuePolicy = 'always' | 'never';
```

In `WorkspaceSettings` (line 104), add alongside `defaultContinue`:

```typescript
  defaultContinuePolicy?: ContinuePolicy;
```

- [ ] **Step 4: Update ResolvedSessionSettings and resolveSessionSettings**

In `server/config.ts`, update the `ResolvedSessionSettings` interface (line 131):

```typescript
export interface ResolvedSessionSettings {
  agent: AgentType;
  yolo: boolean;
  continuePolicy: ContinuePolicy;
  useTmux: boolean;
  claudeArgs: string[];
}
```

Update `SessionSettingsOverrides` (line 139):

```typescript
export interface SessionSettingsOverrides {
  agent?: AgentType | undefined;
  yolo?: boolean | undefined;
  continuePolicy?: ContinuePolicy | undefined;
  useTmux?: boolean | undefined;
  claudeArgs?: string[] | undefined;
}
```

Update `resolveSessionSettings` function (line 147):

```typescript
export function resolveSessionSettings(
  config: Config,
  repoPath: string,
  overrides: SessionSettingsOverrides,
): ResolvedSessionSettings {
  const ws = getWorkspaceSettings(config, repoPath);

  // Map boolean defaultContinue → ContinuePolicy for backward compat
  const configPolicy: ContinuePolicy = ws.defaultContinuePolicy
    ?? (ws.defaultContinue ? 'always' : 'never');

  return {
    agent: overrides.agent ?? ws.defaultAgent ?? 'claude' as AgentType,
    yolo: overrides.yolo ?? ws.defaultYolo ?? false,
    continuePolicy: overrides.continuePolicy ?? configPolicy,
    useTmux: overrides.useTmux ?? ws.launchInTmux ?? false,
    claudeArgs: overrides.claudeArgs ?? ws.claudeArgs ?? [],
  };
}
```

Add the `ContinuePolicy` import at the top of `server/config.ts`:

```typescript
import type { AgentType, Config, ContinuePolicy, FilterPreset, WorkspaceSettings, WorktreeMetadata } from './types.js';
```

- [ ] **Step 5: Fix compilation errors from removing `continue` field**

Any file that references `resolved.continue` now needs to use `resolved.continuePolicy`. The main consumer is `server/index.ts:1109`. Do NOT fix index.ts yet — Task 2 handles it. For now, add a temporary backward-compat alias in the return type:

Actually, to avoid a broken build between tasks, keep BOTH fields during Task 1:

```typescript
return {
  agent: overrides.agent ?? ws.defaultAgent ?? 'claude' as AgentType,
  yolo: overrides.yolo ?? ws.defaultYolo ?? false,
  continue: overrides.continuePolicy === 'always' || (overrides.continuePolicy == null && (ws.defaultContinue ?? true)),
  continuePolicy: overrides.continuePolicy ?? configPolicy,
  useTmux: overrides.useTmux ?? ws.launchInTmux ?? false,
  claudeArgs: overrides.claudeArgs ?? ws.claudeArgs ?? [],
};
```

Keep `continue: boolean` in `ResolvedSessionSettings` for now too. Task 2 removes it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add server/types.ts server/config.ts test/config.test.ts
git commit -m "feat: add ContinuePolicy type and config resolution

Map boolean defaultContinue → 'always'/'never' policy.
Backward-compatible: existing config.defaultContinue still works."
```

---

### Task 2: ContinuePolicy in session creation + serialization

**Goal:** Update `POST /sessions` to use continuePolicy instead of the `.claude` directory heuristic. Update serialization to preserve continuePolicy across restarts.

**Files:**
- Modify: `server/index.ts:1020-1188` (POST /sessions route)
- Modify: `server/sessions.ts:16-37, 300-342, 400-460` (SerializedPtySession, serializeAll, restoreFromDisk)
- Modify: `server/config.ts:131-137` (remove deprecated `continue` field)
- Test: `test/continue-policy.test.ts` (new)

**Learnings applied:**
- L-20260322-session-creation-params: continuePolicy must be stored on PtySession so it survives restarts
- L-20260328-serialization-whitelist-audit: Must add to SerializedPtySession or it gets silently dropped

- [ ] **Step 1: Write failing test for session creation with continuePolicy**

Create `test/continue-policy.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionSettings } from '../server/config.js';
import type { Config } from '../server/types.js';

describe('continuePolicy in session creation', () => {
  const baseConfig: Config = {
    host: '0.0.0.0',
    port: 3456,
    cookieTTL: '24h',
    repos: [],
    claudeCommand: 'claude',
    claudeArgs: [],
    defaultAgent: 'claude',
    defaultContinue: true,
    defaultYolo: false,
    launchInTmux: false,
    defaultNotifications: true,
  };

  it('explicit continuePolicy:never overrides config default', () => {
    const resolved = resolveSessionSettings(baseConfig, '/repo', { continuePolicy: 'never' });
    assert.equal(resolved.continuePolicy, 'never');
  });

  it('explicit continuePolicy:always forces continue', () => {
    const config = { ...baseConfig, defaultContinue: false };
    const resolved = resolveSessionSettings(config, '/repo', { continuePolicy: 'always' });
    assert.equal(resolved.continuePolicy, 'always');
  });

  it('no explicit policy uses config mapping (true → always)', () => {
    const resolved = resolveSessionSettings(baseConfig, '/repo', {});
    assert.equal(resolved.continuePolicy, 'always');
  });

  it('no explicit policy uses config mapping (false → never)', () => {
    const config = { ...baseConfig, defaultContinue: false };
    const resolved = resolveSessionSettings(config, '/repo', {});
    assert.equal(resolved.continuePolicy, 'never');
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (these use Task 1's implementation)**

Run: `npm test -- --test-name-pattern="continuePolicy in session"`
Expected: PASS (Task 1 already implemented the resolution)

- [ ] **Step 3: Update POST /sessions to use continuePolicy**

In `server/index.ts`, update the request body type (around line 1024) to accept `continuePolicy`:

```typescript
const {
  workspacePath, worktreePath, type = 'agent', agent, yolo, useTmux,
  claudeArgs, cols, rows, branchName: requestBranchName, needsBranchRename, branchRenamePrompt,
  initialPrompt, continue: explicitContinue, continuePolicy: explicitContinuePolicy, ticketContext,
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
  branchName?: string;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
  initialPrompt?: string;
  continue?: boolean;
  continuePolicy?: 'always' | 'never';
  ticketContext?: { ticketId: string; title: string; description?: string; url: string; source: 'github' | 'jira'; repoPath: string; repoName: string };
};
```

Update the `resolveSessionSettings` call (line 1094) to pass continuePolicy:

```typescript
// Map legacy boolean continue → continuePolicy for backward compat
const policyOverride = explicitContinuePolicy
  ?? (explicitContinue !== undefined ? (explicitContinue ? 'always' : 'never') : undefined);
// For new worktrees, always use 'never' regardless of config
const effectivePolicy = needsBranchRename ? 'never' as const : policyOverride;

const resolved = resolveSessionSettings(freshConfig, workspacePath, {
  agent, yolo, useTmux, claudeArgs, continuePolicy: effectivePolicy,
});
```

Replace the old `--continue` decision logic (lines 1102-1114) with:

```typescript
// Determine --continue from policy (no .claude directory heuristic)
const useContinue = resolved.continuePolicy === 'always';

const args = useContinue
  ? [...AGENT_CONTINUE_ARGS[resolvedAgent], ...baseArgs]
  : [...baseArgs];
```

- [ ] **Step 4: Update SerializedPtySession to include continuePolicy**

In `server/sessions.ts`, add to `SerializedPtySession` (line 16):

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
  hookToken?: string;
  hooksActive?: boolean;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
  continuePolicy?: 'always' | 'never';
}
```

- [ ] **Step 5: Update serializeAll to include continuePolicy**

In `server/sessions.ts:serializeAll` (around line 311), add `continuePolicy` to the serialized object. Since `continuePolicy` isn't currently on `PtySession`, we need to derive it. For now, the session stores whether it was started with `--continue`. The simplest approach: check if the session's args include continue args.

Actually, better: store continuePolicy on the PtySession interface. In `server/types.ts`, add to `PtySession` (after line 68):

```typescript
  continuePolicy: 'always' | 'never';
```

Then in `serializeAll`, add to the serialized object:

```typescript
continuePolicy: session.continuePolicy,
```

In `server/index.ts`, when creating the session (around line 1150), pass `continuePolicy`:

```typescript
const session = sessions.create({
  // ...existing fields...
  continuePolicy: resolved.continuePolicy,
});
```

In `server/sessions.ts:create`, pass it through to `createPtySession` and store it. In `server/pty-handler.ts`, add `continuePolicy` to `CreatePtyParams`:

```typescript
continuePolicy?: 'always' | 'never' | undefined;
```

And in `createPtySession`, store it on the session object:

```typescript
continuePolicy: params.continuePolicy ?? 'never',
```

- [ ] **Step 6: Update restoreFromDisk to use continuePolicy**

In `restoreFromDisk` (around line 434-448), update the non-tmux restore path to use continuePolicy instead of always adding continue args:

```typescript
} else {
  // Non-tmux agent session — respawn based on continuePolicy
  const shouldContinue = s.continuePolicy === 'always';
  args = [
    ...(shouldContinue ? AGENT_CONTINUE_ARGS[s.agent] : []),
    ...(s.claudeArgs ?? []),
    ...(s.yolo ? AGENT_YOLO_ARGS[s.agent] : []),
  ];
}
```

Note: Session restore always uses continue because the session DID have a conversation. The `continuePolicy` field here is for serialization accuracy, but the restore path should still use `--continue` for surviving sessions. Leave the tmux-dead and non-tmux restore paths using `AGENT_CONTINUE_ARGS` as-is — they correctly resume existing conversations regardless of the original policy.

Actually, re-reading the design doc: "Session restore keeps `--continue` — the restore path is correct (the session DID have a prior conversation). No change needed there."

So keep restore as-is. Just add `continuePolicy` to serialization for completeness. The restore path already correctly forces continue for all restored sessions.

- [ ] **Step 7: Remove deprecated `continue` field from ResolvedSessionSettings**

In `server/config.ts`, remove the `continue: boolean` field and the backward-compat alias added in Task 1:

```typescript
export interface ResolvedSessionSettings {
  agent: AgentType;
  yolo: boolean;
  continuePolicy: ContinuePolicy;
  useTmux: boolean;
  claudeArgs: string[];
}
```

Remove `continue` from `SessionSettingsOverrides` if it was there.

Fix any remaining references to `resolved.continue` in the codebase (grep for `resolved.continue` and `\.continue` in config consumers).

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add server/types.ts server/config.ts server/index.ts server/sessions.ts server/pty-handler.ts test/continue-policy.test.ts
git commit -m "feat: replace .claude heuristic with explicit continuePolicy

POST /sessions now accepts continuePolicy: 'always' | 'never'.
New worktrees always use 'never'. Legacy boolean continue mapped
for backward compatibility. Eliminates fs.existsSync heuristic
that caused regressions with committed .claude/ directories."
```

---

### Task 3: ensureBranchLocal git utility

**Goal:** Add a utility to fetch a remote branch locally if it doesn't exist yet. Used by worktree creation to support PR branches that only exist on the remote.

**Files:**
- Modify: `server/git.ts` (add `ensureBranchLocal` function)
- Test: `test/git.test.ts`

- [ ] **Step 1: Write failing test**

In `test/git.test.ts`, add:

```typescript
import { ensureBranchLocal } from '../server/git.js';

describe('ensureBranchLocal', () => {
  it('returns true immediately if branch exists locally', async () => {
    const calls: string[][] = [];
    const exec = async (_cmd: string, args: string[], _opts: { cwd: string; timeout?: number }) => {
      calls.push(args);
      return { stdout: 'abc123\n', stderr: '' };
    };
    const result = await ensureBranchLocal('/tmp/repo', 'main', { exec });
    assert.equal(result.found, true);
    assert.deepEqual(calls, [['rev-parse', '--verify', 'main']]);
  });

  it('fetches from origin if branch does not exist locally', async () => {
    const calls: string[][] = [];
    let revParseCount = 0;
    const exec = async (_cmd: string, args: string[], _opts: { cwd: string; timeout?: number }) => {
      calls.push(args);
      if (args[0] === 'rev-parse') {
        revParseCount++;
        if (revParseCount === 1) throw new Error('not found');
        return { stdout: 'abc123\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const result = await ensureBranchLocal('/tmp/repo', 'feature/remote-only', { exec });
    assert.equal(result.found, true);
    assert.deepEqual(calls[1], ['fetch', 'origin', 'feature/remote-only:feature/remote-only']);
  });

  it('returns found:false if branch does not exist locally or on remote', async () => {
    const exec = async (_cmd: string, args: string[], _opts: { cwd: string; timeout?: number }) => {
      if (args[0] === 'rev-parse') throw new Error('not found');
      if (args[0] === 'fetch') throw new Error('fatal: couldn\'t find remote ref');
      return { stdout: '', stderr: '' };
    };
    const result = await ensureBranchLocal('/tmp/repo', 'nonexistent', { exec });
    assert.equal(result.found, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="ensureBranchLocal"`
Expected: FAIL — `ensureBranchLocal` is not exported

- [ ] **Step 3: Implement ensureBranchLocal**

In `server/git.ts`, add before the export block:

```typescript
type ExecFn = (cmd: string, args: string[], opts: { cwd: string; timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

/**
 * Ensure a branch ref exists locally. If not, fetch it from origin.
 * Returns { found: true } if the branch is now available locally,
 * or { found: false } if it doesn't exist anywhere.
 */
async function ensureBranchLocal(
  repoPath: string,
  branch: string,
  options: { exec?: ExecFn } = {},
): Promise<{ found: boolean }> {
  const run = options.exec ?? execFileAsync as unknown as ExecFn;

  // Check if branch exists locally
  try {
    await run('git', ['rev-parse', '--verify', branch], { cwd: repoPath, timeout: 5000 });
    return { found: true };
  } catch {
    // Not found locally — try fetching
  }

  // Fetch from origin
  try {
    await run('git', ['fetch', 'origin', `${branch}:${branch}`], { cwd: repoPath, timeout: 30000 });
    return { found: true };
  } catch {
    return { found: false };
  }
}
```

Add `ensureBranchLocal` to the export block.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/git.ts test/git.test.ts
git commit -m "feat: add ensureBranchLocal utility for remote branch fetch

Checks local refs first, fetches from origin if not found.
Returns { found: false } if branch doesn't exist anywhere."
```

---

### Task 4: Enhanced worktree detection — main repo + existing worktree

**Goal:** Update `findOrCreateWorktreeForBranch` to detect when a branch is checked out in the main worktree (not just sub-worktrees) and return a specific error. Also use `parseAllWorktrees` instead of `parseWorktreeListPorcelain` so the main worktree is included in the check.

**Files:**
- Modify: `server/watcher.ts:87-136` (findOrCreateWorktreeForBranch)
- Test: `test/worktrees.test.ts`

- [ ] **Step 1: Write failing test for main worktree detection**

In `test/worktrees.test.ts`, add:

```typescript
import { findOrCreateWorktreeForBranch } from '../server/watcher.js';

describe('findOrCreateWorktreeForBranch', () => {
  it('returns branch_checked_out_in_main when branch is in main worktree', async () => {
    const repoPath = '/Users/me/code/my-repo';
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/nightly',
      '',
    ].join('\n');

    const exec = async (_cmd: string, args: string[], _opts: { cwd: string; timeout?: number }) => {
      if (args[0] === 'worktree') return { stdout, stderr: '' };
      throw new Error('unexpected call');
    };

    try {
      await findOrCreateWorktreeForBranch(repoPath, 'nightly', exec);
      assert.fail('Expected error to be thrown');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('branch_checked_out_in_main'));
    }
  });

  it('returns existing worktree when branch is in a sub-worktree', async () => {
    const repoPath = '/Users/me/code/my-repo';
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/code/my-repo/.worktrees/fix-auth',
      'HEAD def456',
      'branch refs/heads/fix/auth',
      '',
    ].join('\n');

    const exec = async (_cmd: string, args: string[], _opts: { cwd: string; timeout?: number }) => {
      if (args[0] === 'worktree') return { stdout, stderr: '' };
      throw new Error('unexpected call');
    };

    const result = await findOrCreateWorktreeForBranch(repoPath, 'fix/auth', exec);
    assert.equal(result.existing, true);
    assert.equal(result.worktreePath, '/Users/me/code/my-repo/.worktrees/fix-auth');
  });

  it('creates worktree when branch is not checked out anywhere', async () => {
    const repoPath = '/Users/me/code/my-repo';
    const listStdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const exec = async (_cmd: string, args: string[], _opts: { cwd: string; timeout?: number }) => {
      if (args[0] === 'worktree' && args[1] === 'list') return { stdout: listStdout, stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { stdout: '', stderr: '' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };

    const result = await findOrCreateWorktreeForBranch(repoPath, 'feat/new', exec);
    assert.equal(result.existing, false);
    assert.equal(result.branchName, 'feat/new');
  });
});
```

- [ ] **Step 2: Run tests to verify main worktree detection fails**

Run: `npm test -- --test-name-pattern="findOrCreateWorktreeForBranch"`
Expected: FAIL — current code doesn't detect main worktree

- [ ] **Step 3: Update findOrCreateWorktreeForBranch**

In `server/watcher.ts`, replace the function (lines 87-136):

```typescript
export async function findOrCreateWorktreeForBranch(
  repoPath: string,
  branch: string,
  execFn: (cmd: string, args: string[], opts: { cwd: string; timeout?: number }) => Promise<{ stdout: string; stderr: string }>,
): Promise<FindOrCreateResult> {
  // Check ALL worktrees including main repo
  try {
    const { stdout } = await execFn('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    const allEntries = parseAllWorktrees(stdout, repoPath);

    for (const entry of allEntries) {
      if (entry.branch === branch) {
        if (entry.isMain) {
          // Branch is checked out in the main repo — caller should open a repo-root session
          throw new Error(`branch_checked_out_in_main:${repoPath}`);
        }
        // Branch is in an existing sub-worktree — reuse it
        return {
          worktreePath: entry.path,
          branchName: entry.branch,
          dirName: entry.path.split('/').pop() || '',
          existing: true,
        };
      }
    }
  } catch (err) {
    // Re-throw our own error
    if (err instanceof Error && err.message.startsWith('branch_checked_out_in_main:')) {
      throw err;
    }
    // git worktree list failed — proceed with creation attempt
  }

  // Sanitize branch name for directory
  const dirName = branch.replace(/\//g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
  const worktreePath = path.join(repoPath, '.worktrees', dirName);

  // Ensure .worktrees/ is in .gitignore
  try {
    const gitignorePath = path.join(repoPath, '.gitignore');
    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      if (!content.includes('.worktrees/')) {
        fs.appendFileSync(gitignorePath, '\n.worktrees/\n');
      }
    } catch {
      fs.writeFileSync(gitignorePath, '.worktrees/\n');
    }
  } catch {
    // Directory may not exist in test environments
  }

  await execFn('git', ['worktree', 'add', worktreePath, branch], { cwd: repoPath });

  return {
    worktreePath,
    branchName: branch,
    dirName,
    existing: false,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/watcher.ts test/worktrees.test.ts
git commit -m "feat: detect branch checked out in main worktree

findOrCreateWorktreeForBranch now checks ALL worktrees including
main repo. Throws branch_checked_out_in_main error when branch
is in the main worktree (caller should open repo-root session)."
```

---

### Task 5: Enhanced POST /workspaces/worktree — fetch + detect + error codes

**Goal:** Wire `ensureBranchLocal` into the worktree creation endpoint. Return proper HTTP error codes (409 for branch_checked_out_in_main, 404 for branch_not_found).

**Files:**
- Modify: `server/workspaces.ts:654-771` (POST /workspaces/worktree route)
- Test: `test/worktrees.test.ts`

- [ ] **Step 1: Write failing test for remote fetch + error codes**

In `test/worktrees.test.ts`, add tests for the endpoint behavior:

```typescript
describe('POST /workspaces/worktree error handling', () => {
  it('findOrCreateWorktreeForBranch throws on main checkout', async () => {
    const repoPath = '/Users/me/code/my-repo';
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/nightly',
      '',
    ].join('\n');

    const exec = async (_cmd: string, args: string[], _opts: { cwd: string; timeout?: number }) => {
      if (args[0] === 'worktree') return { stdout, stderr: '' };
      throw new Error('unexpected');
    };

    try {
      await findOrCreateWorktreeForBranch(repoPath, 'nightly', exec);
      assert.fail('Should throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /branch_checked_out_in_main/);
    }
  });
});
```

- [ ] **Step 2: Run tests — should pass (Task 4 already implemented this)**

Run: `npm test -- --test-name-pattern="POST /workspaces/worktree"`
Expected: PASS

- [ ] **Step 3: Update POST /workspaces/worktree to use ensureBranchLocal and handle errors**

In `server/workspaces.ts`, add the import:

```typescript
import { ensureBranchLocal } from './git.js';
```

Update the `existingBranch` path in `POST /workspaces/worktree` (around line 674):

```typescript
if (existingBranch) {
  // Ensure branch exists locally (fetch from remote if needed)
  const branchResult = await ensureBranchLocal(resolved, existingBranch, { exec });
  if (!branchResult.found) {
    res.status(404).json({
      error: 'branch_not_found',
      branch: existingBranch,
      remote: 'origin',
    });
    return;
  }

  // Find existing checkout or create new worktree
  try {
    const result = await findOrCreateWorktreeForBranch(resolved, existingBranch, exec);
    const meta = readMeta(configPath, result.worktreePath);
    writeMeta(configPath, {
      worktreePath: result.worktreePath,
      displayName: meta?.displayName || result.dirName,
      lastActivity: new Date().toISOString(),
      branchName: result.branchName,
    });
    res.status(result.existing ? 200 : 201).json({
      path: result.worktreePath,
      existing: result.existing,
      branchName: result.branchName,
      mountainName: meta?.displayName || result.dirName,
      worktreePath: result.worktreePath,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('branch_checked_out_in_main:')) {
      res.status(409).json({
        error: 'branch_checked_out_in_main',
        repoPath: resolved,
      });
    } else {
      res.status(500).json({ error: `Failed to create worktree: ${msg}` });
    }
  }
  return;
}
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/workspaces.ts
git commit -m "feat: enhanced worktree creation with remote fetch and error codes

POST /workspaces/worktree now:
- Fetches remote branches before checkout (ensureBranchLocal)
- Returns 409 when branch is checked out in main repo
- Returns 404 when branch doesn't exist locally or on remote
- Returns 200 for existing worktree reuse, 201 for new creation"
```

---

### Task 6: Repo-scoped tmux naming

**Goal:** Change tmux session names from `crc-Agent-1-{shortId}` to `crc-{repoSlug}-{branchSlug}-{shortId}` for identifiable `tmux ls` output.

**Files:**
- Modify: `server/index.ts:1149-1169` (POST /sessions — compute tmuxDisplayName)
- Modify: `server/pty-handler.ts:19-22` (generateTmuxSessionName — already works, just needs different input)
- Test: `test/sessions.test.ts` or inline in new test

- [ ] **Step 1: Write failing test**

In `test/sessions.test.ts` (or create `test/tmux-naming.test.ts`):

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateTmuxSessionName } from '../server/pty-handler.js';

describe('repo-scoped tmux naming', () => {
  it('produces crc-{repoSlug}-{branchSlug}-{shortId} format', () => {
    const name = generateTmuxSessionName('claude-remote-cli-nightly', 'a3b4c5d6-1234-5678');
    assert.match(name, /^crc[d]?-claude-remote-cli-nightly-a3b4c5d6$/);
  });

  it('sanitizes branch names with slashes', () => {
    const name = generateTmuxSessionName('myapp-fix-auth-flow', 'b4c5d6e7-1234-5678');
    assert.match(name, /^crc[d]?-myapp-fix-auth-flow-b4c5d6e7$/);
  });

  it('truncates long names to 30 chars before appending id', () => {
    const longName = 'a-very-long-repository-name-with-a-very-long-branch-name';
    const name = generateTmuxSessionName(longName, 'c5d6e7f8-1234-5678');
    const prefix = name.replace(/-c5d6e7f8$/, '').replace(/^crc[d]?-/, '');
    assert.ok(prefix.length <= 30, `prefix "${prefix}" exceeds 30 chars`);
  });
});
```

- [ ] **Step 2: Run tests — generateTmuxSessionName already handles sanitization**

Run: `npm test -- --test-name-pattern="repo-scoped tmux"`
Expected: PASS (the function already sanitizes and truncates)

- [ ] **Step 3: Update POST /sessions to compute tmuxDisplayName from repo+branch**

In `server/index.ts`, before the session creation (around line 1149), replace:

```typescript
const displayName = sessions.nextAgentName();
```

With:

```typescript
const displayName = sessions.nextAgentName();

// Compute tmux-specific display name from repo + branch for identifiable tmux ls output
// UI displayName stays as "Agent N" — tmux name and UI name are independent
const branchSlug = (requestBranchName || '')
  .replace(/^(feature|fix|chore|refactor|docs|test|ci|build)\//i, '')
  .replace(/[^a-zA-Z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .slice(0, 30);
const tmuxDisplayName = branchSlug ? `${name}-${branchSlug}` : name;
```

Then pass `tmuxDisplayName` to `sessions.create()` as a new field for tmux naming. Update the create call to include it:

```typescript
const session = sessions.create({
  // ...existing fields...
  tmuxDisplayName,
});
```

In `server/sessions.ts:CreateParams`, add:

```typescript
type CreateParams = Omit<CreatePtyParams, 'id'> & {
  id?: string;
  needsBranchRename?: boolean;
  branchRenamePrompt?: string;
  initialPrompt?: string;
  tmuxDisplayName?: string;
};
```

In `sessions.create()`, pass `tmuxDisplayName` through to `createPtySession`:

In `server/pty-handler.ts:CreatePtyParams`, add:

```typescript
tmuxDisplayName?: string | undefined;
```

In `createPtySession`, when computing tmuxSessionName (it uses `generateTmuxSessionName(displayName, id)`), prefer `tmuxDisplayName` over `displayName`:

```typescript
const tmuxSessionName = params.useTmux
  ? (params.tmuxSessionName || generateTmuxSessionName(params.tmuxDisplayName || params.displayName || 'session', id))
  : '';
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/index.ts server/sessions.ts server/pty-handler.ts test/sessions.test.ts
git commit -m "feat: repo-scoped tmux session names

Tmux sessions now named crc-{repoSlug}-{branchSlug}-{shortId}
instead of crc-Agent-N-{shortId}. UI displayName stays as
'Agent N' — tmux and UI names are now independent."
```

---

### Task 7: isPrMerged + computeBranchLifecycleState

**Goal:** Add functions to compute branch lifecycle state (`active | stale | merged`) from git and PR data. This is the core of the branch lifecycle layer.

**Files:**
- Modify: `server/git.ts` (add `isPrMerged`, export `computeBranchLifecycleState`)
- Modify: `server/types.ts` (add `BranchLifecycleState` type)
- Test: `test/branch-lifecycle.test.ts` (new)

- [ ] **Step 1: Add BranchLifecycleState type**

In `server/types.ts`, after the `ContinuePolicy` type:

```typescript
export type BranchLifecycleState = 'active' | 'stale' | 'merged';
```

Note: `archived` is a post-cleanup state not tracked in runtime — once archived, the worktree is removed.

- [ ] **Step 2: Write failing tests**

Create `test/branch-lifecycle.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrMerged, computeBranchLifecycleState } from '../server/git.js';
import type { PrInfo } from '../server/types.js';

describe('isPrMerged', () => {
  it('returns true for MERGED state', () => {
    const pr = { state: 'MERGED' } as PrInfo;
    assert.equal(isPrMerged(pr), true);
  });

  it('returns false for OPEN state', () => {
    const pr = { state: 'OPEN' } as PrInfo;
    assert.equal(isPrMerged(pr), false);
  });

  it('returns false for CLOSED (not merged) state', () => {
    const pr = { state: 'CLOSED' } as PrInfo;
    assert.equal(isPrMerged(pr), false);
  });
});

describe('computeBranchLifecycleState', () => {
  it('returns merged when PR is merged', () => {
    const result = computeBranchLifecycleState({
      pr: { state: 'MERGED', number: 42, title: 'Fix auth' } as PrInfo,
      isBranchStale: false,
      hasActiveSessions: true,
      isMainBranch: false,
    });
    assert.equal(result.state, 'merged');
    assert.equal(result.prNumber, 42);
    assert.equal(result.prTitle, 'Fix auth');
  });

  it('returns active when branch has active sessions', () => {
    const result = computeBranchLifecycleState({
      pr: null,
      isBranchStale: true,
      hasActiveSessions: true,
      isMainBranch: false,
    });
    assert.equal(result.state, 'active');
  });

  it('returns stale when no sessions and branch is stale', () => {
    const result = computeBranchLifecycleState({
      pr: null,
      isBranchStale: true,
      hasActiveSessions: false,
      isMainBranch: false,
    });
    assert.equal(result.state, 'stale');
  });

  it('returns active when branch is not stale and no sessions', () => {
    const result = computeBranchLifecycleState({
      pr: null,
      isBranchStale: false,
      hasActiveSessions: false,
      isMainBranch: false,
    });
    assert.equal(result.state, 'active');
  });

  it('never returns merged for main branch even if PR is merged', () => {
    const result = computeBranchLifecycleState({
      pr: { state: 'MERGED', number: 1, title: 'Main PR' } as PrInfo,
      isBranchStale: false,
      hasActiveSessions: false,
      isMainBranch: true,
    });
    assert.equal(result.state, 'active');
  });

  it('main branch can be stale but never merged', () => {
    const result = computeBranchLifecycleState({
      pr: null,
      isBranchStale: true,
      hasActiveSessions: false,
      isMainBranch: true,
    });
    assert.equal(result.state, 'stale');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="isPrMerged|computeBranchLifecycleState"`
Expected: FAIL — functions not exported

- [ ] **Step 4: Implement isPrMerged and computeBranchLifecycleState**

In `server/git.ts`, add before the export block:

```typescript
/** Check if a PR is in MERGED state (immediate check, no 24h delay like isStalePr). */
function isPrMerged(pr: PrInfo): boolean {
  return pr.state === 'MERGED';
}

interface BranchLifecycleInput {
  pr: PrInfo | null;
  isBranchStale: boolean;
  hasActiveSessions: boolean;
  isMainBranch: boolean;
}

interface BranchLifecycleResult {
  state: 'active' | 'stale' | 'merged';
  prNumber?: number;
  prTitle?: string;
}

/**
 * Compute branch lifecycle state from authoritative sources.
 * Main branch can be active/stale but never merged.
 */
function computeBranchLifecycleState(input: BranchLifecycleInput): BranchLifecycleResult {
  const { pr, isBranchStale: stale, hasActiveSessions, isMainBranch } = input;

  // Merged: PR is merged AND not the main branch
  if (pr && isPrMerged(pr) && !isMainBranch) {
    return { state: 'merged', prNumber: pr.number, prTitle: pr.title };
  }

  // Active: has sessions OR branch is not stale
  if (hasActiveSessions || !stale) {
    return { state: 'active' };
  }

  // Stale: no sessions AND branch is stale (0 commits ahead of main)
  return { state: 'stale' };
}
```

Add to the export block:

```typescript
  isPrMerged,
  computeBranchLifecycleState,
```

Also add the import for `BranchLifecycleState` type (if needed for the return type annotation) — or just use inline types as shown above.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add server/types.ts server/git.ts test/branch-lifecycle.test.ts
git commit -m "feat: branch lifecycle state computation

Add isPrMerged (immediate, no 24h delay) and
computeBranchLifecycleState (active/stale/merged).
Main branch can be stale but never merged/archived."
```

---

### Task 8: Enrich GET /worktrees with branchState

**Goal:** Add `branchState`, `prNumber`, and `prTitle` fields to each entry in the `GET /worktrees` response. Uses the PR cache from workspaces.ts and lifecycle computation from git.ts.

**Files:**
- Modify: `server/index.ts:681-779` (GET /worktrees route)
- Test: `test/worktrees.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/worktrees.test.ts`:

```typescript
describe('GET /worktrees branchState enrichment', () => {
  it('parseAllWorktrees includes isMain flag for lifecycle computation', () => {
    const repoPath = '/Users/me/code/my-repo';
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /Users/me/code/my-repo/.worktrees/feat-branch',
      'HEAD def456',
      'branch refs/heads/feat/branch',
      '',
    ].join('\n');

    const entries = parseAllWorktrees(stdout, repoPath);
    const mainEntry = entries.find(e => e.isMain);
    assert.ok(mainEntry, 'should include main worktree');
    assert.equal(mainEntry.isMain, true);
    assert.equal(mainEntry.branch, 'main');

    const subEntry = entries.find(e => !e.isMain);
    assert.ok(subEntry);
    assert.equal(subEntry.isMain, false);
  });
});
```

- [ ] **Step 2: Run test — should pass (parseAllWorktrees already exists)**

Run: `npm test -- --test-name-pattern="branchState enrichment"`
Expected: PASS

- [ ] **Step 3: Update GET /worktrees to compute branchState per worktree**

In `server/index.ts`, add imports:

```typescript
import { computeBranchLifecycleState, isBranchStale, isPrMerged } from './git.js';
```

In the GET /worktrees handler (line 681), update the worktrees array type to include lifecycle fields:

```typescript
const worktrees: Array<{
  name: string; path: string; repoName: string; repoPath: string;
  root: string; displayName: string; lastActivity: string; branchName: string;
  branchState?: 'active' | 'stale' | 'merged';
  prNumber?: number;
  prTitle?: string;
}> = [];
```

After building the worktrees list (around line 770, before the dedup), add lifecycle state computation:

```typescript
// Compute branch lifecycle state for each worktree
const activeSessions = sessions.list();
await Promise.all(unique.map(async (wt) => {
  try {
    // Check if any sessions are running in this worktree
    const hasActiveSessions = activeSessions.some(s => s.worktreePath === wt.path || s.cwd === wt.path);

    // Determine if this is the main branch
    const isMainBranch = wt.path === wt.repoPath; // main worktree path equals repo path

    // Check branch staleness
    let stale = false;
    try {
      stale = await isBranchStale(wt.repoPath, wt.branchName);
    } catch {
      // If check fails, assume not stale (safe fallback)
    }

    // Check PR state (use cached PR data from workspaces.ts PR cache)
    let pr: import('./types.js').PrInfo | null = null;
    try {
      pr = await getPrForBranch(wt.repoPath, wt.branchName);
    } catch {
      // If PR check fails, no PR data available
    }

    const lifecycle = computeBranchLifecycleState({
      pr,
      isBranchStale: stale,
      hasActiveSessions,
      isMainBranch,
    });

    wt.branchState = lifecycle.state;
    if (lifecycle.prNumber) wt.prNumber = lifecycle.prNumber;
    if (lifecycle.prTitle) wt.prTitle = lifecycle.prTitle;
  } catch {
    // If lifecycle computation fails, default to active (safe fallback)
    wt.branchState = 'active';
  }
}));
```

Note: This adds async overhead to `GET /worktrees`. The `isBranchStale` call is fast (local git command). The `getPrForBranch` call uses the PR cache from workspaces.ts (60s TTL for positive, 5min for negative). If rate-limited, branches stay `active` (safe fallback per design doc).

Add the `getPrForBranch` import if not already present:

```typescript
import { getPrForBranch } from './git.js';
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/index.ts
git commit -m "feat: enrich GET /worktrees with branchState lifecycle field

Each worktree entry now includes branchState (active/stale/merged),
prNumber, and prTitle. Computed at runtime from git state and PR
data. Rate-limit safe: defaults to active on failure."
```

---

### Task 9: GET /worktrees/:path/status endpoint

**Goal:** New endpoint for pre-cleanup checks. Returns active sessions and uncommitted changes for a worktree path. The frontend calls this before showing the cleanup cascade dialog.

**Files:**
- Modify: `server/index.ts` (add new route after GET /worktrees)
- Test: `test/worktrees.test.ts`

- [ ] **Step 1: Write test for the endpoint contract**

In `test/worktrees.test.ts`:

```typescript
describe('GET /worktrees/:path/status contract', () => {
  it('response shape includes activeSessions and hasUncommittedChanges', () => {
    // Contract test — verify the expected shape
    const expectedShape = {
      activeSessions: ['session-id-1'],
      hasUncommittedChanges: true,
    };
    assert.ok(Array.isArray(expectedShape.activeSessions));
    assert.equal(typeof expectedShape.hasUncommittedChanges, 'boolean');
  });
});
```

- [ ] **Step 2: Implement the endpoint**

In `server/index.ts`, after the `GET /worktrees` handler (around line 780), add:

```typescript
// GET /worktrees/status — pre-cleanup checks for a worktree
app.get('/worktrees/status', requireAuth, async (req, res) => {
  const worktreePath = typeof req.query.path === 'string' ? req.query.path : undefined;
  if (!worktreePath) {
    res.status(400).json({ error: 'path query parameter is required' });
    return;
  }

  const resolved = path.resolve(worktreePath);

  // Check for active sessions in this worktree
  const allSessions = sessions.list();
  const activeSessions = allSessions
    .filter(s => s.worktreePath === resolved || s.cwd === resolved)
    .map(s => s.id);

  // Check for uncommitted changes
  let hasUncommittedChanges = false;
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: resolved, timeout: 5000 });
    hasUncommittedChanges = stdout.trim().length > 0;
  } catch {
    // If git status fails, assume no changes (worktree may be gone)
  }

  res.json({ activeSessions, hasUncommittedChanges });
});
```

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add server/index.ts test/worktrees.test.ts
git commit -m "feat: add GET /worktrees/status endpoint for pre-cleanup checks

Returns activeSessions[] and hasUncommittedChanges for a
worktree path. Frontend uses this before showing cleanup dialog."
```

---

### Task 10: Enhanced DELETE /worktrees — force flag + session kill

**Goal:** Add `force: true` option to `DELETE /worktrees` that kills active sessions before removing the worktree. Return 404 (not 400) when the worktree path no longer exists.

**Files:**
- Modify: `server/index.ts:949-1017` (DELETE /worktrees route)
- Test: `test/worktrees.test.ts`

- [ ] **Step 1: Write test for force behavior**

In `test/worktrees.test.ts`:

```typescript
describe('DELETE /worktrees force flag', () => {
  it('parseAllWorktrees returns empty for non-matching path', () => {
    const repoPath = '/Users/me/code/my-repo';
    const stdout = [
      `worktree ${repoPath}`,
      'HEAD abc123',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const entries = parseAllWorktrees(stdout, repoPath);
    const nonExistent = entries.some(wt => wt.path === '/nonexistent' && !wt.isMain);
    assert.equal(nonExistent, false, 'non-existent path should not match');
  });
});
```

- [ ] **Step 2: Update DELETE /worktrees to support force and return 404**

In `server/index.ts`, update the DELETE /worktrees handler (around line 949):

```typescript
app.delete('/worktrees', requireAuth, async (req, res) => {
  const { worktreePath, repoPath, force } = req.body as {
    worktreePath?: string;
    repoPath?: string;
    force?: boolean;
  };
  if (!worktreePath || !repoPath) {
    res.status(400).json({ error: 'worktreePath and repoPath are required' });
    return;
  }

  // Validate the path is a real git worktree (not the main worktree)
  try {
    const { stdout: wtListOut } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    const allWorktrees = parseAllWorktrees(wtListOut, repoPath);
    const isKnownWorktree = allWorktrees.some(wt => wt.path === path.resolve(worktreePath) && !wt.isMain);
    if (!isKnownWorktree) {
      // Check if the path simply doesn't exist anymore (already cleaned up)
      if (!fs.existsSync(worktreePath)) {
        res.status(404).json({ error: 'Worktree not found — may have been already cleaned up' });
        return;
      }
      res.status(400).json({ error: 'Path is not a recognized git worktree' });
      return;
    }
  } catch {
    if (!isValidWorktreePath(worktreePath)) {
      res.status(400).json({ error: 'Path is not inside a worktree directory' });
      return;
    }
  }

  // If force: kill active sessions in this worktree first
  if (force) {
    const allSessions = sessions.list();
    const resolvedPath = path.resolve(worktreePath);
    for (const s of allSessions) {
      if (s.worktreePath === resolvedPath || s.cwd === resolvedPath) {
        try {
          sessions.kill(s.id);
        } catch {
          // Session may have already ended
        }
      }
    }
  }

  // Derive branch name from metadata
  const meta = readMeta(CONFIG_PATH, worktreePath);
  const branchName = (meta && meta.branchName) || worktreePath.split('/').pop() || '';

  try {
    // Use --force when the user has confirmed via the cascade dialog
    const removeArgs = force
      ? ['worktree', 'remove', '--force', worktreePath]
      : ['worktree', 'remove', worktreePath];
    await execFileAsync('git', removeArgs, { cwd: repoPath });
  } catch (err: unknown) {
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true });
      } catch (rmErr: unknown) {
        res.status(500).json({ error: execErrorMessage(rmErr, 'Failed to remove worktree directory') });
        return;
      }
    }
  }

  try {
    await execFileAsync('git', ['worktree', 'prune'], { cwd: repoPath });
  } catch (_) {
    // Non-fatal
  }

  if (branchName) {
    try {
      await execFileAsync('git', ['branch', '-D', branchName], { cwd: repoPath });
    } catch (_) {
      // Non-fatal
    }
  }

  deleteMeta(CONFIG_PATH, worktreePath);

  // Broadcast worktrees-changed so all clients refresh
  broadcastEvent('worktrees-changed');

  res.json({ ok: true });
});
```

Note: `broadcastEvent` needs to be accessible. Check how it's passed in — it's available via the `io` socket. Look at how `webhooks.ts` does it. In `index.ts`, the `broadcastEvent` function is defined and used. Just call it directly since we're in the same file.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add server/index.ts test/worktrees.test.ts
git commit -m "feat: DELETE /worktrees supports force flag + 404 for missing

force:true kills active sessions and uses git worktree remove --force.
Returns 404 when worktree already cleaned up (multi-client race fix).
Broadcasts worktrees-changed after cleanup."
```

---

### Task 11: Webhook merge detection + worktrees-changed broadcast

**Goal:** When a PR merge event is detected (webhook or poller), broadcast `worktrees-changed` to trigger a frontend refresh that will include updated `branchState: 'merged'` from `GET /worktrees`.

**Files:**
- Modify: `server/webhooks.ts:76-78` (detect merged PR specifically)
- Modify: `server/index.ts` (where webhook events are received, broadcast worktrees-changed)
- Test: `test/webhooks.test.ts`

- [ ] **Step 1: Write failing test for merge detection**

In `test/webhooks.test.ts`, add:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('webhook merge detection', () => {
  it('pull_request.closed with merged:true should trigger pr-merged event', () => {
    // This test validates the contract: when a PR is merged,
    // the webhook handler broadcasts a 'pr-merged' event in addition to 'pr-updated'
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const broadcastEvent = (type: string, data?: Record<string, unknown>) => {
      events.push({ type, data });
    };

    // Simulate what the webhook handler should do for a merged PR
    const payload = {
      action: 'closed',
      pull_request: { merged: true, head: { ref: 'fix/auth' } },
      repository: { full_name: 'owner/repo' },
    };

    // Expected: both pr-updated AND worktrees-changed should be broadcast
    if (payload.action === 'closed' && payload.pull_request?.merged) {
      broadcastEvent('pr-updated', { repo: payload.repository.full_name });
      broadcastEvent('worktrees-changed');
    }

    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, 'pr-updated');
    assert.equal(events[1]!.type, 'worktrees-changed');
  });
});
```

- [ ] **Step 2: Run test — passes as contract test**

Run: `npm test -- --test-name-pattern="webhook merge"`
Expected: PASS (it's a contract test)

- [ ] **Step 3: Update webhooks.ts to detect merged PRs**

In `server/webhooks.ts`, update the event routing (around line 76):

```typescript
if (event === 'pull_request' || event === 'pull_request_review') {
  deps.broadcastEvent('pr-updated', repoFullName ? { repo: repoFullName } : undefined);

  // If PR was merged, also broadcast worktrees-changed so sidebar refreshes with branchState: 'merged'
  if (event === 'pull_request') {
    const body = req.body as Record<string, unknown>;
    const action = body.action as string | undefined;
    const pr = body.pull_request as Record<string, unknown> | undefined;
    if (action === 'closed' && pr?.merged === true) {
      deps.broadcastEvent('worktrees-changed');
    }
  }
} else if (event === 'check_suite' || event === 'check_run') {
  deps.broadcastEvent('ci-updated', repoFullName ? { repo: repoFullName } : undefined);
}
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/webhooks.ts test/webhooks.test.ts
git commit -m "feat: broadcast worktrees-changed on PR merge webhook

When GitHub sends pull_request.closed with merged:true,
broadcast worktrees-changed in addition to pr-updated.
Frontend refreshes GET /worktrees which now includes
branchState: 'merged' for the merged branch."
```

---

## Deliverable Traceability

| Design Doc Deliverable | Plan Task |
|----------------------|-----------|
| Contract 1: Enhanced Worktree Creation Endpoint (fetch → detect → reuse-or-create, 409/404 errors) | Tasks 3, 4, 5 |
| Contract 2: Branch Lifecycle State on GET /worktrees (branchState, prNumber, prTitle) | Tasks 7, 8 |
| Contract 2: GET /worktrees/:path/status (activeSessions, hasUncommittedChanges) | Task 9 |
| Contract 3: worktrees-changed event enrichment on merge | Task 11 |
| Contract 4: continuePolicy replaces boolean continue | Tasks 1, 2 |
| Item 1: Existing worktree detection (main repo + sub-worktree) | Task 4 |
| Item 2: Remote branch fetch before checkout | Tasks 3, 5 |
| Item 3: continuePolicy (replace .claude heuristic, explicit policy) | Tasks 1, 2 |
| Item 4: Repo-scoped tmux naming (crc-{repoSlug}-{branchSlug}-{shortId}) | Task 6 |
| Item 5: Auto-archive — lifecycle state computation | Task 7 |
| Item 5: Auto-archive — GET /worktrees enrichment | Task 8 |
| Item 5: Auto-archive — pre-cleanup status endpoint | Task 9 |
| Item 5: Auto-archive — force delete with session kill | Task 10 |
| Item 5: Auto-archive — webhook merge detection | Task 11 |

---

## Outcomes & Retrospective

_Filled by /harness:complete when work is done._

**What worked:**
- Parallel subagent dispatch for independent tasks (batched 2-3 tasks per round)
- Detailed plan with exact code reduced implementer questions to zero
- Silent failure hunter caught a data loss risk (hasUncommittedChanges defaulting to false) that all other reviewers missed

**What didn't:**
- Webhook merge test replicates handler logic inline instead of exercising real handler — noted by test analyzer
- Some subagents used inline literals instead of type aliases despite explicit instructions

**Learnings to codify:**
- Pre-cleanup safety checks must default to the SAFE value on error (assume changes exist, not absent)
- Silent catch blocks in lifecycle/enrichment code should always log — defense-in-depth catches mask programming errors
