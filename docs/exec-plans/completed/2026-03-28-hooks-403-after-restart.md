# Fix Hook 403 Errors After Restart + TMUX_PREFIX Test Regression

> **Status**: Completed | **Created**: 2026-03-28 | **Completed**: 2026-03-28
> **Bug Analysis**: `docs/bug-analyses/2026-03-28-hooks-403-after-restart-bug-analysis.md`
> **Consulted Learnings**: L-20260322-session-creation-params, L-20260328-serialization-whitelist-audit, L-20260328-surviving-process-stale-config, L-20260328-module-level-env-eval
> **For Claude:** Use /harness:orchestrate to execute this plan.

**Goal:** Fix hookToken/hooksActive lost during session serialization causing 403 errors on all hook calls after server restart, and fix TMUX_PREFIX module-level env evaluation that causes test failures when NO_PIN=1 is in the environment.

**Architecture:** Add hookToken/hooksActive to SerializedPtySession and plumb through serialize/restore. Convert TMUX_PREFIX from a module-level constant to a function. Audit all PtySession fields for serialization gaps.

**Tech Stack:** TypeScript, Node.js test runner, server/sessions.ts, server/pty-handler.ts

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-28 | Design | Serialize hookToken rather than regenerate on restore | Surviving tmux sessions hold the original token; server must accept it (L-20260328-surviving-process-stale-config) |
| 2026-03-28 | Design | Convert TMUX_PREFIX to function instead of clearing env in tests | Addresses root cause — module-level eval can't be overridden per-test (L-20260328-module-level-env-eval) |
| 2026-03-28 | Design | Audit all PtySession vs SerializedPtySession fields | Third occurrence of this bug class (L-20260328-serialization-whitelist-audit) |
| 2026-03-28 | Design | Add branchRenamePrompt and needsBranchRename to serialization | Found during audit — both affect restored session behavior |

## Progress

- [x] Task 1: Add hookToken/hooksActive to serialization _(completed 2026-03-28)_
- [x] Task 2: Plumb hookToken/hooksActive through restore path _(completed 2026-03-28)_
- [x] Task 3: Convert TMUX_PREFIX to function _(completed 2026-03-28)_
- [x] Task 4: Systemic audit — serialize remaining missing fields _(completed 2026-03-28)_
- [x] Task 5: Add round-trip tests for hookToken and all newly serialized fields _(completed 2026-03-28)_

## Surprises & Discoveries

| 2026-03-28 | Task 3 implementer missed env isolation on 2 remaining tests (sanitize + 30-char limit) | Fixed by controller — same pattern as other tests |

## Plan Drift

| Task | Plan Said | Actually Happened | Why |
|------|-----------|-------------------|-----|
| Task 3 | Fix 3 tests | Fixed 5 tests (3 planned + 2 pre-existing that hardcoded crc-) | Implementer flagged 2 additional tests with same env pollution pattern |

---

### Task 1: Add hookToken/hooksActive to serialization

**Files:**
- Modify: `server/sessions.ts:16-33` (SerializedPtySession interface)
- Modify: `server/sessions.ts:307-324` (serializeAll push block)

- [ ] **Step 1: Add hookToken and hooksActive to SerializedPtySession interface**

In `server/sessions.ts`, add two fields to the `SerializedPtySession` interface:

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
}
```

- [ ] **Step 2: Add hookToken and hooksActive to serializeAll push block**

In `server/sessions.ts` inside `serializeAll()`, add the two fields to the serialized object (after the `claudeArgs` line):

```typescript
    serializedPty.push({
      id: session.id,
      type: session.type,
      agent: session.agent,
      workspacePath: session.workspacePath,
      worktreePath: session.worktreePath,
      cwd: session.cwd,
      repoName: session.repoName,
      branchName: session.branchName,
      displayName: session.displayName,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      useTmux: session.useTmux,
      tmuxSessionName: session.tmuxSessionName || '',
      customCommand: session.customCommand,
      yolo: session.yolo,
      claudeArgs: session.claudeArgs,
      hookToken: session.hookToken,
      hooksActive: session.hooksActive,
    });
```

- [ ] **Step 3: Build to verify compilation**

Run: `npm run build`
Expected: Clean compilation with no errors.

- [ ] **Step 4: Commit**

```bash
git add server/sessions.ts
git commit -m "fix: add hookToken/hooksActive to SerializedPtySession and serializeAll"
```

---

### Task 2: Plumb hookToken/hooksActive through restore path

**Files:**
- Modify: `server/pty-handler.ts:62-85` (CreatePtyParams)
- Modify: `server/pty-handler.ts:127-142` (hook injection logic in createPtySession)
- Modify: `server/sessions.ts:444-460` (restoreFromDisk createParams)

- [ ] **Step 1: Add hookToken and hooksActive to CreatePtyParams**

In `server/pty-handler.ts`, add to the `CreatePtyParams` type:

```typescript
export type CreatePtyParams = {
  id: string;
  type?: SessionType | undefined;
  agent?: AgentType | undefined;
  repoName?: string | undefined;
  workspacePath: string;
  worktreePath?: string | null | undefined;
  cwd: string;
  branchName?: string | undefined;
  displayName?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  configPath?: string | undefined;
  useTmux?: boolean | undefined;
  tmuxSessionName?: string | undefined;
  initialScrollback?: string[] | undefined;
  restored?: boolean | undefined;
  port?: number | undefined;
  forceOutputParser?: boolean | undefined;
  yolo?: boolean | undefined;
  claudeArgs?: string[] | undefined;
  hookToken?: string | undefined;
  hooksActive?: boolean | undefined;
};
```

- [ ] **Step 2: Update createPtySession to use provided hookToken when available**

In `server/pty-handler.ts` inside `createPtySession()`, extract the new params and modify the hook injection logic. Replace the existing block (lines ~118-142):

```typescript
  const {
    id,
    type,
    agent = 'claude',
    repoName,
    workspacePath,
    worktreePath = null,
    cwd,
    branchName,
    displayName,
    command,
    args: rawArgs = [],
    cols = 80,
    rows = 24,
    configPath,
    useTmux: paramUseTmux,
    tmuxSessionName: paramTmuxSessionName,
    initialScrollback,
    restored: paramRestored,
    port,
    forceOutputParser,
    yolo: paramYolo,
    claudeArgs: paramClaudeArgs,
    hookToken: paramHookToken,
    hooksActive: paramHooksActive,
  } = params;
```

Then replace the hook injection block:

```typescript
  // Inject hooks settings when spawning a real claude agent (not custom command, not forceOutputParser)
  // For restored sessions, accept the previously-serialized token instead of generating a new one
  let hookToken = paramHookToken ?? '';
  let hooksActive = paramHooksActive ?? false;
  let settingsPath = '';
  const shouldInjectHooks = agent === 'claude' && !command && !forceOutputParser && port !== undefined;
  if (shouldInjectHooks && !hookToken) {
    hookToken = crypto.randomBytes(32).toString('hex');
    try {
      settingsPath = writeHooksSettingsFile(id, port, hookToken);
      args = ['--settings', settingsPath, ...args];
      hooksActive = true;
    } catch (err) {
      console.warn(`[pty-handler] Failed to generate hooks settings for session ${id}:`, err);
      hooksActive = false;
      hookToken = '';
    }
  }
```

The key change: `paramHookToken ?? ''` and `paramHooksActive ?? false` use the provided values, and the `shouldInjectHooks` block only runs when there's no existing token (i.e., fresh sessions, not restored ones).

- [ ] **Step 3: Pass hookToken/hooksActive from restoreFromDisk to create**

In `server/sessions.ts` inside `restoreFromDisk()`, add the two fields to `createParams`:

```typescript
      const createParams: CreateParams = {
        id: s.id,
        type: s.type,
        agent: s.agent,
        repoName: s.repoName,
        workspacePath: s.workspacePath,
        worktreePath: s.worktreePath,
        cwd: s.cwd,
        branchName: s.branchName,
        displayName: s.displayName,
        args,
        useTmux: false,
        tmuxSessionName: s.tmuxSessionName,
        restored: true,
        yolo: s.yolo ?? false,
        claudeArgs: s.claudeArgs ?? [],
        hookToken: s.hookToken,
        hooksActive: s.hooksActive,
      };
```

- [ ] **Step 4: Build to verify compilation**

Run: `npm run build`
Expected: Clean compilation with no errors.

- [ ] **Step 5: Run existing tests to check nothing breaks**

Run: `npm test`
Expected: All existing tests pass (except the known TMUX_PREFIX tests if NO_PIN=1 is set).

- [ ] **Step 6: Commit**

```bash
git add server/pty-handler.ts server/sessions.ts
git commit -m "fix: plumb hookToken/hooksActive through restore path

Restored tmux sessions now preserve the original hookToken so the
surviving Claude Code instance's hook calls are accepted instead of
returning 403."
```

---

### Task 3: Convert TMUX_PREFIX to function

**Files:**
- Modify: `server/pty-handler.ts:15-19` (TMUX_PREFIX declaration + generateTmuxSessionName)
- Modify: `server/index.ts:17` (import)
- Modify: `server/index.ts:1304` (orphan cleanup usage)
- Modify: `test/sessions.test.ts:7` (import)
- Modify: `test/sessions.test.ts:306-347` (TMUX_PREFIX tests)

- [ ] **Step 1: Convert TMUX_PREFIX constant to getTmuxPrefix function**

In `server/pty-handler.ts`, replace the constant and update `generateTmuxSessionName`:

Replace:
```typescript
export const TMUX_PREFIX = process.env.NO_PIN === '1' ? 'crcd-' : 'crc-';

export function generateTmuxSessionName(displayName: string, id: string): string {
  const sanitized = displayName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30);
  return `${TMUX_PREFIX}${sanitized}-${id.slice(0, 8)}`;
}
```

With:
```typescript
export function getTmuxPrefix(): string {
  return process.env.NO_PIN === '1' ? 'crcd-' : 'crc-';
}

export function generateTmuxSessionName(displayName: string, id: string): string {
  const sanitized = displayName.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30);
  return `${getTmuxPrefix()}${sanitized}-${id.slice(0, 8)}`;
}
```

- [ ] **Step 2: Update server/index.ts import and usage**

In `server/index.ts`, change the import:

Replace:
```typescript
import { TMUX_PREFIX } from './pty-handler.js';
```

With:
```typescript
import { getTmuxPrefix } from './pty-handler.js';
```

And update the orphan cleanup line (~line 1304):

Replace:
```typescript
    const orphanedSessions = stdout.trim().split('\n').filter(name => name.startsWith(TMUX_PREFIX) && !adoptedNames.has(name));
```

With:
```typescript
    const orphanedSessions = stdout.trim().split('\n').filter(name => name.startsWith(getTmuxPrefix()) && !adoptedNames.has(name));
```

- [ ] **Step 3: Update test imports and assertions**

In `test/sessions.test.ts`, update the import:

Replace:
```typescript
import { resolveTmuxSpawn, generateTmuxSessionName, TMUX_PREFIX } from '../server/pty-handler.js';
```

With:
```typescript
import { resolveTmuxSpawn, generateTmuxSessionName, getTmuxPrefix } from '../server/pty-handler.js';
```

Replace the two TMUX_PREFIX tests:

Replace the test `'prod TMUX_PREFIX (crc-) does not match dev prefix (crcd-)'`:
```typescript
  it('prod prefix (crc-) does not match dev prefix (crcd-)', () => {
    const prodPrefix = 'crc-';
    const devPrefix = 'crcd-';
    assert.ok(!devPrefix.startsWith(prodPrefix), `dev prefix '${devPrefix}' must not start with prod prefix '${prodPrefix}'`);
    assert.ok(!prodPrefix.startsWith(devPrefix), `prod prefix '${prodPrefix}' must not start with dev prefix '${devPrefix}'`);
  });
```

Replace the test `'TMUX_PREFIX is crc- in normal mode (no NO_PIN)'`:
```typescript
  it('getTmuxPrefix returns crc- when NO_PIN is not set', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      assert.strictEqual(getTmuxPrefix(), 'crc-');
    } finally {
      if (original !== undefined) process.env.NO_PIN = original;
    }
  });

  it('getTmuxPrefix returns crcd- when NO_PIN is 1', () => {
    const original = process.env.NO_PIN;
    process.env.NO_PIN = '1';
    try {
      assert.strictEqual(getTmuxPrefix(), 'crcd-');
    } finally {
      if (original !== undefined) {
        process.env.NO_PIN = original;
      } else {
        delete process.env.NO_PIN;
      }
    }
  });
```

Also update the `'generateTmuxSessionName has crc- prefix'` test to be environment-safe:
```typescript
  it('generateTmuxSessionName has correct prefix', () => {
    const original = process.env.NO_PIN;
    delete process.env.NO_PIN;
    try {
      const name = generateTmuxSessionName('my-session', 'abcdef1234567890');
      assert.ok(name.startsWith('crc-'), `expected crc- prefix, got: ${name}`);
    } finally {
      if (original !== undefined) process.env.NO_PIN = original;
    }
  });
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npm test`
Expected: All tests pass, including the TMUX_PREFIX tests regardless of NO_PIN environment.

- [ ] **Step 5: Commit**

```bash
git add server/pty-handler.ts server/index.ts test/sessions.test.ts
git commit -m "fix: convert TMUX_PREFIX to function for test isolation

Module-level constant evaluated at import time, leaking NO_PIN=1 from
the dev environment into tests. getTmuxPrefix() reads the env on each
call, making tests environment-independent."
```

---

### Task 4: Systemic audit — serialize remaining missing fields

**Files:**
- Modify: `server/sessions.ts:16-33` (SerializedPtySession interface)
- Modify: `server/sessions.ts:307-324` (serializeAll push block)
- Modify: `server/sessions.ts:444-460` (restoreFromDisk createParams)
- Modify: `server/sessions.ts:43-48` (CreateParams type)

Audit of PtySession fields against SerializedPtySession:

| PtySession Field | Serialized? | Action |
|-----------------|:-----------:|--------|
| pty | No | Transient (IPty handle) — skip |
| scrollback | Yes | Separate .buf file — already handled |
| onPtyReplacedCallbacks | No | Transient — skip |
| restored | No | Always starts false on restore — skip |
| outputParser | No | Not serializable (module) — skip |
| cleanedUp | No | Transient — skip |
| _lastHookTime | No | Transient — skip |
| _lastEmittedBackendState | No | Transient — skip |
| lastAttentionNotifiedAt | No | Transient — skip |
| currentActivity | No | Transient — skip |
| idle | No | Self-corrects via 5s timer — skip |
| initialPrompt | No | One-shot, consumed immediately — skip |
| mode | No | Always 'pty' — skip |
| **branchRenamePrompt** | **No** | **Add — custom prompt lost on restart** |
| **needsBranchRename** | **No** | **Add — pending rename lost on restart** |
| agentState | No | Resets to 'initializing' — acceptable for restored sessions |
| status | No | Restore path handles this (starts active, becomes disconnected on PTY exit) — skip |

- [ ] **Step 1: Add branchRenamePrompt and needsBranchRename to SerializedPtySession**

In `server/sessions.ts`, add to `SerializedPtySession`:

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
}
```

- [ ] **Step 2: Add fields to serializeAll push block**

After the `hooksActive` line in the serialized object:

```typescript
      hookToken: session.hookToken,
      hooksActive: session.hooksActive,
      needsBranchRename: session.needsBranchRename || undefined,
      branchRenamePrompt: session.branchRenamePrompt,
```

- [ ] **Step 3: Pass fields from restoreFromDisk to create**

In `server/sessions.ts` inside `restoreFromDisk()`, add to `createParams`:

```typescript
        hookToken: s.hookToken,
        hooksActive: s.hooksActive,
        needsBranchRename: s.needsBranchRename,
        branchRenamePrompt: s.branchRenamePrompt,
      };
```

Note: `needsBranchRename` and `branchRenamePrompt` are already on `CreateParams` (lines 43-48), so no changes to `CreateParams` are needed.

- [ ] **Step 4: Build to verify compilation**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 5: Commit**

```bash
git add server/sessions.ts
git commit -m "fix: serialize branchRenamePrompt and needsBranchRename

Systemic audit of PtySession vs SerializedPtySession found two more
fields that affect restored session behavior. This is the same
whitelist serialization gap pattern (third recurrence)."
```

---

### Task 5: Add round-trip tests for hookToken and all newly serialized fields

**Files:**
- Modify: `test/sessions.test.ts`

- [ ] **Step 1: Write failing test for hookToken round-trip**

Add to the `'session persistence'` describe block in `test/sessions.test.ts`:

```typescript
  it('serialize/restore preserves hookToken and hooksActive', async () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
    });

    // Manually set hookToken and hooksActive (simulating a session that had hooks injected)
    const session = sessions.get(s.id);
    assert.ok(session);
    (session as PtySession).hookToken = 'abc123deadbeef';
    (session as PtySession).hooksActive = true;

    serializeAll(configDir);

    // Verify hookToken is in the serialized JSON
    const pending = JSON.parse(fs.readFileSync(path.join(configDir, 'pending-sessions.json'), 'utf-8'));
    assert.strictEqual(pending.sessions[0].hookToken, 'abc123deadbeef');
    assert.strictEqual(pending.sessions[0].hooksActive, true);

    sessions.kill(s.id);

    await restoreFromDisk(configDir);
    const restored = sessions.get(s.id);
    assert.ok(restored);
    assert.strictEqual((restored as PtySession).hookToken, 'abc123deadbeef');
    assert.strictEqual((restored as PtySession).hooksActive, true);
  });
```

- [ ] **Step 2: Write failing test for needsBranchRename round-trip**

```typescript
  it('serialize/restore preserves needsBranchRename and branchRenamePrompt', async () => {
    const configDir = createTmpDir();

    const s = sessions.create({
      repoName: 'test-repo',
      workspacePath: '/tmp',
      worktreePath: null,
      cwd: '/tmp',
      command: '/bin/cat',
      args: [],
      needsBranchRename: true,
      branchRenamePrompt: 'Name this feature branch:',
    });

    const session = sessions.get(s.id);
    assert.ok(session);
    assert.strictEqual(session.needsBranchRename, true);

    serializeAll(configDir);
    sessions.kill(s.id);

    await restoreFromDisk(configDir);
    const restored = sessions.get(s.id);
    assert.ok(restored);
    assert.strictEqual(restored.needsBranchRename, true);
    assert.strictEqual((restored as PtySession).branchRenamePrompt, 'Name this feature branch:');
  });
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm test`
Expected: All tests pass (both new and existing).

- [ ] **Step 4: Commit**

```bash
git add test/sessions.test.ts
git commit -m "test: add round-trip tests for hookToken, hooksActive, needsBranchRename, branchRenamePrompt

Ensures the serialization gap that caused hook 403 errors after restart
cannot regress. Covers all fields added in this fix."
```

---

## Deliverable Traceability

| Design Doc Deliverable | Plan Task |
|----------------------|-----------|
| Add hookToken/hooksActive to SerializedPtySession | Task 1 |
| Update serializeAll() to persist hookToken/hooksActive | Task 1 |
| Update restoreFromDisk() to pass hookToken/hooksActive through | Task 2 |
| In createPtySession(), use provided hookToken instead of generating new one | Task 2 |
| Fix TMUX_PREFIX module-level evaluation | Task 3 |
| Audit ALL Session properties against SerializedPtySession | Task 4 |
| Round-trip test for hookToken surviving serialize/restore | Task 5 |
| TMUX_PREFIX tests isolate from environment | Task 3 |

---

## Outcomes & Retrospective

_Filled by /harness:complete when work is done._

**What worked:**
- Parallel dispatch of independent tasks (Task 1 + Task 3) saved time
- Bug analysis was thorough — all root causes correctly identified
- Existing test patterns (yolo/claudeArgs round-trip) made new tests trivial to write

**What didn't:**
- Initial implementation missed re-creating the hooks settings file for dead-tmux-restored sessions — silent failure hunter caught a critical gap that the plan didn't anticipate
- Two TMUX_PREFIX tests (sanitize, 30-char limit) were missed by the Task 3 implementer, requiring controller intervention

**Learnings to codify:**
- L-20260328-settings-file-recreation: When restoring a process with preserved credentials, the credential FILE must also be re-created — token preservation alone is insufficient
