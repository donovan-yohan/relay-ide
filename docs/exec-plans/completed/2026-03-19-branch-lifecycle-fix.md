# Branch Lifecycle Fix: Unique Names, Auto-Rename, Display Names

> **Status**: Complete | **Created**: 2026-03-19 | **Last Updated**: 2026-03-19
> **Bug Analysis**: `docs/bug-analyses/2026-03-19-pr-topbar-stale-merged-pr-bug-analysis.md`
> **For Claude:** Use /harness:orchestrate to execute this plan.

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-19 | Design | Generate unique temp branch on worktree reuse, then auto-rename on first message | Mountain names are for directories only — branches need to be unique per feature cycle |
| 2026-03-19 | Design | Derive display name from branch name via kebab-to-title-case | Simpler than asking Claude for a separate display name; branch name already captures intent |
| 2026-03-19 | Design | Filter merged/closed PRs at the `getPrForBranch` server level | Single fix point — both PrTopBar and any future consumers get clean data |
| 2026-03-19 | Design | Echo chars during rename buffer + write full prompt on Enter | Users must see what they type; the rename instruction is a one-time prefix that Claude processes |

## Progress

- [x] Task 1: Filter merged/closed PRs in `getPrForBranch`
- [x] Task 2: Add `branchToDisplayName` utility
- [x] Task 3: Generate unique temp branch on stale worktree reuse
- [x] Task 4: Fix first-message interception echo + resume path
- [x] Task 5: Wire display name into branch watcher + sidebar

## Surprises & Discoveries

_None yet — updated during execution by /harness:orchestrate._

## Plan Drift

_None yet — updated when tasks deviate from plan during execution._

---

## Task 1: Filter merged/closed PRs in `getPrForBranch`

**Why**: `gh pr view <branch>` returns the most recent PR regardless of state. The sidebar was patched but PrTopBar and future consumers still get stale data.

**Files**: `server/git.ts`, `test/git.test.ts` (if exists, else `test/pr-state.test.ts`)

### Steps

1. **Edit `server/git.ts` — `getPrForBranch` function (line ~297)**

   After parsing the PR data, filter out non-OPEN PRs:

   ```typescript
   // After line 310 (before the return statement at line 297-311)
   // Filter: only return OPEN PRs (gh pr view returns merged/closed PRs too)
   if (data.state !== 'OPEN') {
     return null;
   }
   ```

   Insert this check right after `const data = JSON.parse(stdout)` and before the `return { ... }` block.

2. **Edit `server/sessions.ts` line 376** — Remove the now-redundant `pr.state === 'OPEN'` check since the server function already filters:

   ```typescript
   // Before: if (pr && pr.state === 'OPEN') {
   // After:  if (pr) {
   ```

3. **Verify**: `npm run build && npm test` — PrTopBar and sidebar both get `null` for merged PRs.

---

## Task 2: Add `branchToDisplayName` utility

**Why**: Convert kebab-case branch names like `fix-mobile-scroll-bug` or `feature/add-auth` to human-readable display names like "Fix mobile scroll bug" or "Add auth".

**Files**: `server/git.ts`, `test/branch-rename.test.ts`

### Steps

1. **Add to `server/git.ts`** — new exported function:

   ```typescript
   /**
    * Convert a git branch name to a human-readable display name.
    * Examples:
    *   "fix-mobile-scroll-bug" → "Fix mobile scroll bug"
    *   "feature/add-auth"      → "Add auth"
    *   "fix/api-timeout"       → "Api timeout"
    */
   function branchToDisplayName(branch: string): string {
     // Strip common prefixes: feature/, fix/, chore/, etc.
     const stripped = branch.replace(/^(feature|fix|chore|refactor|docs|test|ci|build)\//i, '');
     // Replace hyphens and underscores with spaces, then title-case first word
     const words = stripped.replace(/[-_]/g, ' ').trim();
     if (!words) return branch;
     return words.charAt(0).toUpperCase() + words.slice(1);
   }
   ```

2. **Export it** — add `branchToDisplayName` to the export block at the bottom of `server/git.ts`.

3. **Add tests to `test/branch-rename.test.ts`**:

   ```typescript
   import { branchToDisplayName } from '../server/git.js';

   describe('branchToDisplayName', () => {
     test('converts kebab-case to sentence case', () => {
       assert.equal(branchToDisplayName('fix-mobile-scroll-bug'), 'Fix mobile scroll bug');
     });

     test('strips common branch prefixes', () => {
       assert.equal(branchToDisplayName('feature/add-auth'), 'Add auth');
       assert.equal(branchToDisplayName('fix/api-timeout'), 'Api timeout');
       assert.equal(branchToDisplayName('chore/update-deps'), 'Update deps');
     });

     test('handles simple names', () => {
       assert.equal(branchToDisplayName('lhotse'), 'Lhotse');
     });

     test('handles underscores', () => {
       assert.equal(branchToDisplayName('fix_the_thing'), 'Fix the thing');
     });
   });
   ```

4. **Verify**: `npm run build && npm test`

---

## Task 3: Generate unique temp branch on stale worktree reuse

**Why**: When a worktree like `.worktrees/lhotse` is reused after its PR was merged, the branch `lhotse` still has GitHub PR history. We need a fresh branch name so `gh pr view` returns nothing.

**Files**: `server/index.ts` (POST /sessions handler, lines 574-582), `server/git.ts`

### Steps

1. **Add helper to `server/git.ts`** — detect if a branch is stale (same commit as base branch):

   ```typescript
   async function isBranchStale(
     repoPath: string,
     branch: string,
     options: { exec?: ExecFileAsyncLike } = {},
   ): Promise<boolean> {
     const run: ExecFileAsyncLike = options.exec || execFileAsync as ExecFileAsyncLike;
     try {
       // Check if branch has 0 commits ahead of main/master
       for (const base of ['main', 'master']) {
         try {
           const { stdout } = await run(
             'git', ['rev-list', '--count', `${base}..${branch}`],
             { cwd: repoPath, timeout: 5000 },
           );
           const count = parseInt(stdout.trim(), 10);
           if (count === 0) return true;
           return false; // Found a valid base, branch has commits ahead
         } catch {
           continue; // This base branch doesn't exist, try next
         }
       }
       return false;
     } catch {
       return false;
     }
   }
   ```

   Export `isBranchStale` from the module.

2. **Edit `server/index.ts` — POST /sessions handler (lines 574-582)**

   When `worktreePath` is provided, check if the current branch is stale and auto-create a fresh one:

   ```typescript
   if (worktreePath) {
     // Check if the worktree's branch is stale (merged/at base) and needs a fresh name
     const currentBranchResult = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath }).catch(() => null);
     const currentBranch = currentBranchResult?.stdout.trim();

     if (currentBranch && !needsBranchRename) {
       const stale = await isBranchStale(worktreePath, currentBranch);
       if (stale) {
         // Generate unique temp branch: <mountain>-<short-timestamp>
         const mountainName = worktreePath.split('/').pop() || 'branch';
         const suffix = Date.now().toString(36).slice(-4);
         const tempBranch = `${mountainName}-${suffix}`;
         try {
           await execFileAsync('git', ['checkout', '-b', tempBranch], { cwd: worktreePath });
         } catch {
           // If checkout -b fails, try branch -m (already on the branch)
           await execFileAsync('git', ['branch', '-m', tempBranch], { cwd: worktreePath }).catch(() => {});
         }
         // Flag for auto-rename on first message
         isMountainName = true;
       }
     }

     const hasPriorSession = !needsBranchRename && !isMountainName && fs.existsSync(path.join(worktreePath, '.claude'));
     args = hasPriorSession ? [...AGENT_CONTINUE_ARGS[resolvedAgent], ...baseArgs] : [...baseArgs];
     cwd = worktreePath;
     sessionRepoPath = worktreePath;
     worktreeName = worktreePath.split('/').pop() || '';
   }
   ```

   **Note**: Import `isBranchStale` from `./git.js` at the top of index.ts.

3. **Verify**: `npm run build && npm test`

---

## Task 4: Fix first-message interception echo + resume path

**Why**: Two problems — (A) chars typed during rename buffering aren't echoed so user sees nothing, (B) resuming an existing worktree from sidebar doesn't set `needsBranchRename`.

**Files**: `server/ws.ts` (lines 172-193), `frontend/src/components/WorkspaceItem.svelte` (lines 120-125, 299-304)

### Steps

1. **Fix echo in `server/ws.ts` line 180** — write chars to PTY during buffering so the user sees their input:

   ```typescript
   // Before (line 176-181):
   if (enterIndex === -1) {
     (ptySession as any)._renameBuffer += str;
     return;
   }

   // After:
   if (enterIndex === -1) {
     (ptySession as any)._renameBuffer += str;
     ptySession.pty.write(str); // Echo to terminal so user sees what they type
     return;
   }
   ```

2. **Fix Enter handling in `server/ws.ts` line 183-188** — clear the echoed text before writing the full prompt:

   ```typescript
   // After "Enter detected" comment:
   const buffered: string = (ptySession as any)._renameBuffer;
   const beforeEnter = buffered + str.slice(0, enterIndex);
   const afterEnter = str.slice(enterIndex); // includes the \r

   // Clear the echoed input line before writing the full prompt
   // \x15 = Ctrl+U (kill line) — may not work in all TUIs
   // Use \r + spaces + \r as a more universal approach to overwrite the line
   const clearLine = '\r' + ' '.repeat(beforeEnter.length + 2) + '\r';
   ptySession.pty.write(clearLine);

   const renamePrompt = `Before doing anything else, rename the current git branch using \`git branch -m <new-name>\`. Choose a short, descriptive kebab-case branch name based on the task below.${ptySession.branchRenamePrompt ? ' User preferences: ' + ptySession.branchRenamePrompt : ''} Do not ask for confirmation — just rename and proceed.\n\n`;
   ptySession.pty.write(renamePrompt + beforeEnter + afterEnter);
   ```

3. **No frontend changes needed for resume path** — Task 3 already handles this server-side. When an existing worktree has a stale branch, `POST /sessions` detects it and sets `needsBranchRename` automatically, regardless of whether the frontend passes the flag.

4. **Verify**: `npm run build && npm test`

---

## Task 5: Wire display name into branch watcher + sidebar

**Why**: After Claude renames the branch, the display name should be human-readable, not the raw kebab-case branch name.

**Files**: `server/ws.ts` (startBranchWatcher, lines 36-46), `server/config.ts` or wherever `writeMeta` is called

### Steps

1. **Edit `server/ws.ts` — import `branchToDisplayName`** at the top:

   ```typescript
   import { branchToDisplayName } from './git.js';
   ```

2. **Edit `server/ws.ts` — `startBranchWatcher` (lines 36-46)** — use `branchToDisplayName` for display:

   ```typescript
   // Before (lines 38-39):
   session.branchName = currentBranch;
   session.displayName = currentBranch;

   // After:
   session.branchName = currentBranch;
   session.displayName = branchToDisplayName(currentBranch);
   ```

3. **Update the broadcast and writeMeta** on lines 40-46:

   ```typescript
   broadcastEvent('session-renamed', {
     sessionId: session.id,
     branchName: currentBranch,
     displayName: branchToDisplayName(currentBranch),
   });
   writeMeta(cfgPath, {
     worktreePath: session.repoPath,
     displayName: branchToDisplayName(currentBranch),
     lastActivity: new Date().toISOString(),
     branchName: currentBranch,
   });
   ```

4. **Verify**: `npm run build && npm test`

---

## Outcomes & Retrospective

_Filled by /harness:complete when work is done._

**What worked:**
-

**What didn't:**
-

**Learnings to codify:**
-
