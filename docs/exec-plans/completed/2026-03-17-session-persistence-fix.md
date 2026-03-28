# Session Persistence Fix Implementation Plan

> **Status**: Active | **Created**: 2026-03-17 | **Last Updated**: 2026-03-17
> **Bug Analysis**: `docs/bug-analyses/2026-03-17-session-persistence-across-updates-bug-analysis.md`
> **For Claude:** Use /harness:orchestrate to execute this plan.

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-17 | Design | Fix existing serialize/restore instead of full session-metadata decoupling | The serialize/restore mechanism is 90% correct; fixing the 3 specific bugs is simpler and lower-risk than redesigning the session lifecycle |
| 2026-03-17 | Design | Add `tmuxSessionName` pass-through on restore | Without it, orphan cleanup kills restored tmux sessions |
| 2026-03-17 | Design | Add `serializeAll` to `gracefulShutdown` | Both update paths (HTTP and CLI) need serialization before shutdown |
| 2026-03-17 | Design | Add a `restoring` flag to prevent PTY exit from deleting restored sessions immediately | Restored sessions whose PTYs exit quickly should remain in the session list as "disconnected" rather than vanishing |

## Progress

- [x] Task 1: Fix tmux session name propagation during restore
- [x] Task 2: Add `serializeAll` to graceful shutdown
- [x] Task 3: Protect restored sessions from immediate deletion on PTY exit
- [x] Task 4: Integration: wire everything together and verify

## Surprises & Discoveries

_None yet — updated during execution by /harness:orchestrate._

## Plan Drift

_None yet — updated when tasks deviate from plan during execution._

---

### Task 1: Fix tmux session name propagation during restore

**Goal:** Restored tmux sessions must have their `tmuxSessionName` set so orphan cleanup doesn't kill them.

**Files:**
- Modify: `server/sessions.ts` (restoreFromDisk and create functions)
- Modify: `test/sessions.test.ts`

- [ ] **Step 1: Write failing test — restored tmux sessions preserve tmuxSessionName**

Add to the `session persistence` describe block in `test/sessions.test.ts`:

```ts
it('restoreFromDisk preserves tmuxSessionName for tmux sessions', async () => {
  const configDir = createTmpDir();

  // Write a pending file with a tmux session
  const pending = {
    version: 1,
    timestamp: new Date().toISOString(),
    sessions: [{
      id: 'tmux-test-id',
      type: 'worktree' as const,
      agent: 'claude' as const,
      root: '',
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreeName: 'my-wt',
      branchName: 'my-branch',
      displayName: 'my-session',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      useTmux: true,
      tmuxSessionName: 'crc-my-session-tmux-tes',
      customCommand: null,
      cwd: '/tmp',
    }],
  };
  fs.writeFileSync(path.join(configDir, 'pending-sessions.json'), JSON.stringify(pending));

  const restored = await restoreFromDisk(configDir);
  assert.strictEqual(restored, 1);

  const session = sessions.get('tmux-test-id');
  assert.ok(session, 'restored session should exist');
  assert.strictEqual(session.tmuxSessionName, 'crc-my-session-tmux-tes', 'tmuxSessionName should be preserved from serialized data');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/sessions.test.js`
Expected: FAIL — restored session has `tmuxSessionName === ''` because `useTmux: false` in restore.

- [ ] **Step 3: Implement fix — pass tmuxSessionName through CreateParams during restore**

In `server/sessions.ts`, modify `CreateParams` to accept an optional `tmuxSessionName`:

```ts
type CreateParams = {
  // ... existing fields ...
  tmuxSessionName?: string;
};
```

In the `create` function (line ~126), change tmuxSessionName assignment to prefer the provided value:

```ts
const tmuxSessionName = paramTmuxSessionName || (useTmux ? generateTmuxSessionName(displayName || repoName || 'session', id) : '');
```

Where `paramTmuxSessionName` is destructured from the params (rename the param to avoid conflict with the local variable).

In `restoreFromDisk`, pass the serialized `tmuxSessionName` through:

```ts
const createParams: CreateParams = {
  id: s.id,
  type: s.type,
  agent: s.agent,
  repoName: s.repoName,
  repoPath: s.repoPath,
  cwd: s.cwd,
  root: s.root,
  worktreeName: s.worktreeName,
  branchName: s.branchName,
  displayName: s.displayName,
  args,
  useTmux: false,
  tmuxSessionName: s.tmuxSessionName, // preserve the original tmux name
};
```

- [ ] **Step 4: Run tests to verify it passes**

Run: `npm run build && node --test dist/test/sessions.test.js`
Expected: All tests PASS, including the new one.

- [ ] **Step 5: Commit**

```bash
git add server/sessions.ts test/sessions.test.ts
git commit -m "fix: preserve tmuxSessionName during session restore"
```

---

### Task 2: Add `serializeAll` to graceful shutdown

**Goal:** Sessions are serialized to disk before the process exits, regardless of how the exit is triggered (SIGTERM, SIGINT, or update handler). This also fixes the CLI `update` command path (`bin/claude-remote-cli.ts:87-96`) which does `service.uninstall()` + `service.install()`, sending SIGTERM to the running process — once `gracefulShutdown` calls `serializeAll`, the CLI path is covered automatically.

**Files:**
- Modify: `server/index.ts` (gracefulShutdown function)
- Note: `bin/claude-remote-cli.ts` — CLI update triggers SIGTERM → fixed indirectly via this task
- Modify: `test/sessions.test.ts`

- [ ] **Step 1: Write component test — serializeAll captures state before kill**

This test validates the component behavior needed by the gracefulShutdown integration (serialize → kill sequence). The integration itself is in index.ts and verified via Task 4.

```ts
it('serializeAll captures session state before kill', () => {
  const configDir = createTmpDir();

  const s = sessions.create({
    repoName: 'test-repo',
    repoPath: '/tmp',
    command: '/bin/cat',
    args: [],
    displayName: 'before-kill',
  });

  const session = sessions.get(s.id);
  assert.ok(session);
  session.scrollback.push('important output');

  serializeAll(configDir);

  // Kill after serialize (mimics gracefulShutdown sequence)
  sessions.kill(s.id);

  // Verify data is on disk
  const pendingPath = path.join(configDir, 'pending-sessions.json');
  assert.ok(fs.existsSync(pendingPath));
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
  assert.strictEqual(pending.sessions.length, 1);
  assert.strictEqual(pending.sessions[0].displayName, 'before-kill');
});
```

- [ ] **Step 2: Run test**

Run: `npm run build && node --test dist/test/sessions.test.js`
Expected: PASS — serializeAll is synchronous and captures state before kill.

- [ ] **Step 3: Implement — add serializeAll to gracefulShutdown**

In `server/index.ts`, modify the `gracefulShutdown` function:

```ts
function gracefulShutdown() {
  server.close();
  // Serialize sessions to disk BEFORE killing them
  const configDir = path.dirname(CONFIG_PATH);
  serializeAll(configDir);
  // Kill all active sessions (PTY + tmux)
  for (const s of sessions.list()) {
    try { sessions.kill(s.id); } catch { /* already exiting */ }
  }
  // Brief delay to let async tmux kill-session calls fire
  setTimeout(() => process.exit(0), 200);
}
```

- [ ] **Step 4: Build to verify no type errors**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts test/sessions.test.ts
git commit -m "fix: serialize sessions before graceful shutdown"
```

---

### Task 3: Protect restored sessions from immediate deletion on PTY exit

**Goal:** When a restored session's PTY exits quickly (e.g., `claude --continue` fails), the session should remain in the registry with a "disconnected" state rather than being deleted. The frontend already shows sessions from the list; keeping them there ensures they remain visible.

**Files:**
- Modify: `server/types.ts` (add `status` field to Session)
- Modify: `server/sessions.ts` (exit handler, list, create)
- Modify: `test/sessions.test.ts`
- Modify: `frontend/src/lib/types.ts` (add `status` field to SessionSummary)

- [ ] **Step 1: Write failing test — restored session stays in list after PTY exit**

```ts
it('restored session remains in list after PTY exits (disconnected state)', async () => {
  const configDir = createTmpDir();

  // Serialize a session with /bin/false as the command (exits immediately)
  const pending = {
    version: 1,
    timestamp: new Date().toISOString(),
    sessions: [{
      id: 'restore-exit-test',
      type: 'worktree' as const,
      agent: 'claude' as const,
      root: '',
      repoName: 'test-repo',
      repoPath: '/tmp',
      worktreeName: 'my-wt',
      branchName: 'my-branch',
      displayName: 'restored-session',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      useTmux: false,
      tmuxSessionName: '',
      customCommand: '/bin/false',
      cwd: '/tmp',
    }],
  };
  fs.writeFileSync(path.join(configDir, 'pending-sessions.json'), JSON.stringify(pending));

  await restoreFromDisk(configDir);

  // Wait for PTY to exit
  await new Promise(resolve => setTimeout(resolve, 500));

  // Session should still be in the list
  const list = sessions.list();
  const found = list.find(s => s.id === 'restore-exit-test');
  assert.ok(found, 'restored session should remain in list after PTY exit');
  assert.strictEqual(found.status, 'disconnected');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/sessions.test.js`
Expected: FAIL — session is deleted from map when PTY exits.

- [ ] **Step 3: Add `status` field to Session type**

In `server/types.ts`, add to Session interface:

```ts
export type SessionStatus = 'active' | 'disconnected';

export interface Session {
  // ... existing fields ...
  status: SessionStatus;
}
```

- [ ] **Step 4: Add `status` field to session creation and list output**

In `server/sessions.ts`:

1. In `create()`, add `status: 'active'` to the session object (line ~148).
2. In `list()`, include `status` in the mapped output.
3. In `CreateResult` type, add `status` field.
4. In `SessionSummary` type (line ~13), add `status`.

- [ ] **Step 5: Mark restored sessions and protect them in exit handler**

In `server/sessions.ts`:

1. Add a `restored` field to Session (internal only, not serialized). Also add `restored` to the `Omit<>` exclusion in `SessionSummary` so it doesn't leak into the API:
   ```ts
   type SessionSummary = Omit<Session, 'pty' | 'scrollback' | 'onPtyReplacedCallbacks' | 'restored'>;
   ```

2. In `create()`, set `restored: false` by default. Add `restored` to `CreateParams`.

3. In `restoreFromDisk`, pass `restored: true` when calling create.

4. In the PTY exit handler (the `proc.onExit` callback), check if the session is restored:
   ```ts
   proc.onExit(() => {
     // ... existing retry logic ...

     if (session.restored) {
       // Don't delete — mark as disconnected
       session.status = 'disconnected';
       session.restored = false; // clear so user-initiated kills can delete normally
       if (idleTimer) clearTimeout(idleTimer);
       if (metaFlushTimer) clearTimeout(metaFlushTimer);
       return;
     }

     // ... existing delete logic ...
   });
   ```

5. Clear `restored` after PTY has been running for >3 seconds (same heuristic as continue-retry). In `attachHandlers`, after the `spawnTime` declaration:
   ```ts
   const restoredClearTimer = session.restored ? setTimeout(() => { session.restored = false; }, 3000) : null;
   ```
   Clear this timer in the exit handler if it fires before 3s.

**Known limitation:** Disconnected sessions cannot currently be removed from the UI until the server restarts. This is acceptable for the initial fix; a follow-up can add a DELETE endpoint for disconnected sessions.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run build && node --test dist/test/sessions.test.js`
Expected: All tests PASS.

- [ ] **Step 7: Update frontend SessionSummary type**

In `frontend/src/lib/types.ts`, add:

```ts
export interface SessionSummary {
  // ... existing fields ...
  status?: 'active' | 'disconnected';
}
```

- [ ] **Step 8: Build to verify no type errors (server + frontend)**

Run: `npm run build`
Expected: PASS — both tsc and svelte-check pass.

- [ ] **Step 9: Commit**

```bash
git add server/types.ts server/sessions.ts test/sessions.test.ts frontend/src/lib/types.ts
git commit -m "fix: keep restored sessions in list as 'disconnected' after PTY exit"
```

---

### Task 4: Integration — wire everything together and verify

**Goal:** Validate the full serialize → shutdown → restart → restore flow works correctly end-to-end.

**Files:**
- Modify: `test/sessions.test.ts`

- [ ] **Step 1: Write integration test — full serialize-restore round trip preserves tmux names and session status**

```ts
it('full serialize-restore round trip preserves all session fields including tmuxSessionName', async () => {
  const configDir = createTmpDir();

  // Create sessions of different types
  const repo = sessions.create({
    type: 'repo',
    repoName: 'my-repo',
    repoPath: '/tmp/repo',
    command: '/bin/cat',
    args: [],
    displayName: 'My Repo',
  });

  const terminal = sessions.create({
    type: 'terminal',
    repoPath: '/tmp',
    command: '/bin/sh',
    args: [],
    displayName: 'Terminal 1',
  });

  // Serialize all
  serializeAll(configDir);

  // Kill originals
  sessions.kill(repo.id);
  sessions.kill(terminal.id);
  assert.strictEqual(sessions.list().length, 0);

  // Also inject a tmux-style session into the pending file to test tmuxSessionName round-trip
  const pendingPath = path.join(configDir, 'pending-sessions.json');
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
  pending.sessions.push({
    id: 'tmux-roundtrip-id',
    type: 'worktree',
    agent: 'claude',
    root: '',
    repoName: 'tmux-repo',
    repoPath: '/tmp/tmux',
    worktreeName: 'tmux-wt',
    branchName: 'feat/tmux',
    displayName: 'Tmux Session',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    useTmux: true,
    tmuxSessionName: 'crc-tmux-session-tmux-rou',
    customCommand: null,
    cwd: '/tmp/tmux',
  });
  fs.writeFileSync(pendingPath, JSON.stringify(pending));

  // Restore
  const restored = await restoreFromDisk(configDir);
  assert.strictEqual(restored, 3);

  // Verify all sessions exist
  const list = sessions.list();
  assert.strictEqual(list.length, 3);

  const restoredRepo = list.find(s => s.id === repo.id);
  assert.ok(restoredRepo);
  assert.strictEqual(restoredRepo.type, 'repo');
  assert.strictEqual(restoredRepo.displayName, 'My Repo');

  const restoredTerminal = list.find(s => s.id === terminal.id);
  assert.ok(restoredTerminal);
  assert.strictEqual(restoredTerminal.type, 'terminal');
  assert.strictEqual(restoredTerminal.displayName, 'Terminal 1');

  // Verify tmux session name survived the round trip
  const restoredTmux = sessions.get('tmux-roundtrip-id');
  assert.ok(restoredTmux);
  assert.strictEqual(restoredTmux.tmuxSessionName, 'crc-tmux-session-tmux-rou');
  assert.strictEqual(restoredTmux.displayName, 'Tmux Session');
});
```

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests PASS (including svelte-check).

- [ ] **Step 3: Commit**

```bash
git add test/sessions.test.ts
git commit -m "test: add integration test for full session persistence round trip"
```

---

## Outcomes & Retrospective

**What worked:**
- Targeted fixes to 3 specific bugs rather than redesigning session lifecycle
- TDD approach — each fix verified with focused tests
- Parallel execution of Tasks 1 and 2 (independent changes)

**What didn't:**
- Task 3 agent left type errors that needed manual cleanup
- Integration test initially failed because it created a tmux session without a surviving tmux process, causing the restored PTY to exit immediately → disconnected state

**Learnings to codify:**
- Restored sessions need `restored` flag cleared after healthy PTY runs for >3s (same heuristic as continue-retry)
- Disconnected sessions can pile up — future work needed for cleanup UI
