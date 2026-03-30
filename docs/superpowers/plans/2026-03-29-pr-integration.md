# Intent-Based PR Picker & Role-Aware Actions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add role-aware PR actions and a unified intent-based picker modal that resolves items (PRs, branches, issues) into contextual session actions.

**Architecture:** Extend `pr-state.ts` with `role` field so `derivePrAction` returns different actions for authors vs reviewers. Introduce `SessionIntent` abstraction that wraps `derivePrAction` for PRs and handles branches/issues directly. Build `OpenPicker` modal on existing `Spotlight.svelte` infrastructure with 4 tabs (all/prs/branches/issues).

**Tech Stack:** TypeScript, Svelte 5 (runes), TanStack Query, existing API endpoints (`/api/dashboard`, `/api/branches`, `/api/github/issues`)

**Design Doc:** `docs/design-docs/2026-03-28-pr-integration-design.md`

---

### Task 1: Fix Branch Picker CSS Bug

**Root cause identified:** `PrTopBar.svelte:370` sets `overflow: hidden` on `.pr-top-bar`, which clips `BranchSwitcher`'s absolutely-positioned `.branch-dropdown` (z-index 200). The dropdown renders but is invisible because its parent's parent clips it.

**Files:**
- Modify: `frontend/src/components/PrTopBar.svelte:370`

- [ ] **Step 1: Fix the overflow clipping**

In `frontend/src/components/PrTopBar.svelte`, change the `.pr-top-bar` CSS:

```css
/* Before */
overflow: hidden;

/* After */
overflow: visible;
```

The `overflow: hidden` was originally added to prevent long branch names from expanding the bar. The bar's flex layout with `min-width: 0` on `.bar-left` already handles truncation, so `overflow: hidden` is redundant and causes the dropdown clipping bug.

- [ ] **Step 2: Verify the bar still truncates long branch names**

Run: `npm run build`

Check that the build succeeds. The visual verification (dropdown opens, long names truncate) requires runtime testing.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PrTopBar.svelte
git commit -m "fix: branch picker dropdown clipped by overflow:hidden on PrTopBar"
```

---

### Task 2: Add Role-Aware Actions to pr-state.ts (Tests First)

**Files:**
- Modify: `frontend/src/lib/pr-state.ts`
- Modify: `test/pr-state.test.ts`

The design doc specifies this role-action matrix:

| PR State | Author Action | Reviewer Action |
|----------|--------------|-----------------|
| Open, all clear | Merge (green) | Review (blue) |
| Open, conflicts | Fix Conflicts (red) | Fix Conflicts (red) |
| Open, CI failing | Fix Errors (red) | CI Failing (muted, disabled) |
| Open, CI pending | Checks Running (yellow) | Checks Running (yellow) |
| Open, unresolved comments | Resolve Comments (accent) + Review (muted) | Review (blue) + Resolve Comments (accent) |
| Draft | Ready for Review (muted) | (hidden — none) |
| Merged/Closed | Archive (muted) | Archive (muted) |

- [ ] **Step 1: Write failing tests for role-aware behavior**

Add these tests to `test/pr-state.test.ts`, inside the existing `describe('derivePrAction')` block:

```typescript
  // ── Role-aware tests ──

  it('returns merge-pr for author when open + all clear', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 5, ciFailing: 0, ciPending: 0, ciTotal: 5,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 0,
      role: 'author',
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'merge-pr');
    assert.equal(action.color, 'success');
    assert.equal(action.label, 'Merge');
  });

  it('returns review-pr with info color for reviewer when open + all clear', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 5, ciFailing: 0, ciPending: 0, ciTotal: 5,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 0,
      role: 'reviewer',
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'review-pr');
    assert.equal(action.color, 'info');
    assert.equal(action.label, 'Review');
  });

  it('returns muted checks-running for reviewer when CI failing', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 3, ciFailing: 2, ciPending: 0, ciTotal: 5,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 0,
      role: 'reviewer',
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'checks-running');
    assert.equal(action.color, 'muted');
    assert.equal(action.label, 'CI Failing');
  });

  it('returns none for reviewer on draft PR', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'DRAFT',
      ciPassing: 0, ciFailing: 0, ciPending: 0, ciTotal: 0,
      mergeable: null, unresolvedCommentCount: 0,
      role: 'reviewer',
    };
    const action = derivePrAction(input);
    assert.equal(action.type, 'none');
  });

  it('defaults to author behavior when role omitted', () => {
    const input: PrStateInput = {
      commitsAhead: 1,
      prState: 'OPEN',
      ciPassing: 5, ciFailing: 0, ciPending: 0, ciTotal: 5,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 0,
    };
    const action = derivePrAction(input);
    // Without role, defaults to author → merge-pr
    assert.equal(action.type, 'merge-pr');
  });
```

Also add a test for `deriveSecondaryAction` with roles:

```typescript
describe('deriveSecondaryAction', () => {
  it('returns review-pr secondary for author with unresolved comments', () => {
    const input: PrStateInput = {
      commitsAhead: 1, prState: 'OPEN',
      ciPassing: 5, ciFailing: 0, ciPending: 0, ciTotal: 5,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 3,
      role: 'author',
    };
    const primary = derivePrAction(input);
    assert.equal(primary.type, 'resolve-comments');
    const secondary = deriveSecondaryAction(primary, input);
    assert.ok(secondary);
    assert.equal(secondary!.type, 'review-pr');
    assert.equal(secondary!.color, 'muted');
  });

  it('returns resolve-comments secondary for reviewer with unresolved comments', () => {
    const input: PrStateInput = {
      commitsAhead: 1, prState: 'OPEN',
      ciPassing: 5, ciFailing: 0, ciPending: 0, ciTotal: 5,
      mergeable: 'MERGEABLE', unresolvedCommentCount: 3,
      role: 'reviewer',
    };
    const primary = derivePrAction(input);
    assert.equal(primary.type, 'review-pr');
    assert.equal(primary.color, 'info');
    const secondary = deriveSecondaryAction(primary, input);
    assert.ok(secondary);
    assert.equal(secondary!.type, 'resolve-comments');
    assert.equal(secondary!.color, 'accent');
  });
});
```

Also update `getStatusCssVar` test to include `info`:

```typescript
  it('maps all colors correctly', () => {
    // ... existing assertions ...
    assert.equal(getStatusCssVar('info'), 'var(--status-info)');
  });
```

And add `getActionPrompt` test for `merge-pr`:

```typescript
  it('returns null for merge-pr (GitHub link action)', () => {
    assert.equal(
      getActionPrompt({ type: 'merge-pr', color: 'success', label: 'Merge' }, { branchName: 'main' }),
      null,
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `tsc -p tsconfig.test.json && node --test --test-force-exit dist/test/pr-state.test.js`

Expected: FAIL — `merge-pr` not in PrActionType, `info` not in StatusColor, `role` not on PrStateInput.

- [ ] **Step 3: Implement role-aware pr-state.ts**

In `frontend/src/lib/pr-state.ts`:

1. Add `'merge-pr'` to `PrActionType`:
```typescript
export type PrActionType =
  | 'none'
  | 'create-pr'
  | 'ready-for-review'
  | 'review-pr'
  | 'merge-pr'          // NEW
  | 'fix-errors'
  | 'fix-conflicts'
  | 'resolve-comments'
  | 'checks-running'
  | 'archive-merged'
  | 'archive-closed';
```

2. Add `'info'` to `StatusColor`:
```typescript
export type StatusColor =
  | 'accent'
  | 'success'
  | 'error'
  | 'warning'
  | 'info'             // NEW
  | 'merged'
  | 'muted'
  | 'none';
```

3. Add optional `role` to `PrStateInput`:
```typescript
export interface PrStateInput {
  commitsAhead: number;
  prState: 'OPEN' | 'CLOSED' | 'MERGED' | 'DRAFT' | null;
  ciPassing: number;
  ciFailing: number;
  ciPending: number;
  ciTotal: number;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  unresolvedCommentCount: number;
  role?: 'author' | 'reviewer';  // NEW — defaults to 'author'
}
```

4. Update `derivePrAction` body:
```typescript
export function derivePrAction(input: PrStateInput): PrAction {
  const { commitsAhead, prState, ciFailing, ciPending, ciTotal, mergeable, unresolvedCommentCount } = input;
  const role = input.role ?? 'author';

  // No commits ahead of base — nothing to do
  if (commitsAhead <= 0 && prState === null) {
    return { type: 'none', color: 'none', label: '' };
  }

  // No PR exists but there are commits — offer to create
  if (prState === null) {
    return { type: 'create-pr', color: 'accent', label: 'Create PR' };
  }

  // PR is a draft — author can mark ready, reviewer sees nothing
  if (prState === 'DRAFT') {
    if (role === 'reviewer') {
      return { type: 'none', color: 'none', label: '' };
    }
    return { type: 'ready-for-review', color: 'muted', label: 'Ready for Review' };
  }

  // PR is merged — offer cleanup
  if (prState === 'MERGED') {
    return { type: 'archive-merged', color: 'merged', label: 'Archive' };
  }

  // PR is closed (not merged) — offer cleanup
  if (prState === 'CLOSED') {
    return { type: 'archive-closed', color: 'muted', label: 'Archive' };
  }

  // PR is open — check for conflicts first
  if (prState === 'OPEN') {
    // Merge conflicts take priority for everyone
    if (mergeable === 'CONFLICTING') {
      return { type: 'fix-conflicts', color: 'error', label: 'Fix Conflicts' };
    }

    // CI checks are failing
    if (ciFailing > 0) {
      // Reviewer can't fix CI — show muted waiting state
      if (role === 'reviewer') {
        return { type: 'checks-running', color: 'muted', label: 'CI Failing' };
      }
      return {
        type: 'fix-errors',
        color: 'error',
        label: `Fix Errors ${ciFailing}/${ciTotal}`,
      };
    }

    // CI checks are still running (some pending, none failing)
    if (ciPending > 0) {
      return { type: 'checks-running', color: 'warning', label: 'Checks Running...' };
    }

    // Unresolved review comments — role determines primary action
    if (unresolvedCommentCount > 0) {
      if (role === 'reviewer') {
        // Reviewer's primary action is to review
        return { type: 'review-pr', color: 'info', label: 'Review' };
      }
      return {
        type: 'resolve-comments',
        color: 'accent',
        label: `Resolve Comments (${unresolvedCommentCount})`,
      };
    }

    // All clear — role determines action
    if (role === 'reviewer') {
      return { type: 'review-pr', color: 'info', label: 'Review' };
    }
    return { type: 'merge-pr', color: 'success', label: 'Merge' };
  }

  // Fallback — should not reach here
  return { type: 'none', color: 'none', label: '' };
}
```

5. Update `deriveSecondaryAction`:
```typescript
export function deriveSecondaryAction(primary: PrAction, input: PrStateInput): PrAction | null {
  const role = input.role ?? 'author';
  if (primary.type === 'resolve-comments') {
    return { type: 'review-pr', color: 'muted', label: 'Review PR' };
  }
  // Reviewer seeing review-pr as primary + unresolved comments → resolve as secondary
  if (primary.type === 'review-pr' && role === 'reviewer' && input.unresolvedCommentCount > 0) {
    return {
      type: 'resolve-comments',
      color: 'accent',
      label: `Resolve Comments (${input.unresolvedCommentCount})`,
    };
  }
  return null;
}
```

6. Add `merge-pr` to `getActionPrompt` (returns null — it's a GitHub link action, not a Claude prompt):
```typescript
    case 'merge-pr':
      return null; // Merge is a GitHub link action, not a Claude prompt
```

7. Add `info` to `getStatusCssVar`:
```typescript
    case 'info': return 'var(--status-info)';
```

8. Update header comment to reflect role awareness:
```typescript
/**
 * PR Top Bar State Machine
 *
 * Pure function that derives the action button state from branch/PR/CI data.
 * Role-aware: authors see merge/fix actions, reviewers see review actions.
 *
 *   INPUT                                AUTHOR ACTION          REVIEWER ACTION
 *   ────────────────────────────────────────────────────────────────────────────
 *   No commits ahead                     (none)                 (none)
 *   Commits ahead, no PR                 [Create PR]            [Create PR]
 *   PR Draft                             [Ready for Review]     (hidden)
 *   PR Open + CONFLICTING                [Fix Conflicts]        [Fix Conflicts]
 *   PR Open + CI failing                 [Fix Errors N/M]       [CI Failing] (muted)
 *   PR Open + CI pending                 [Checks Running...]    [Checks Running...]
 *   PR Open + unresolved comments        [Resolve (N)] + Review [Review] + Resolve (N)
 *   PR Open + all clear                  [Merge]                [Review]
 *   PR Merged                            [Archive]              [Archive]
 *   PR Closed                            [Archive]              [Archive]
 */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `tsc -p tsconfig.test.json && node --test --test-force-exit dist/test/pr-state.test.js`

Expected: ALL PASS (existing tests default to author role).

- [ ] **Step 5: Build to verify frontend compiles**

Run: `npm run build`

Expected: Build succeeds (all existing callers pass PrStateInput without `role` — the field is optional).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/pr-state.ts test/pr-state.test.ts
git commit -m "feat: role-aware PR state machine — authors see merge, reviewers see review"
```

---

### Task 3: Implement SessionIntent Type and Resolver (Tests First)

**Files:**
- Create: `frontend/src/lib/session-intent.ts`
- Create: `test/session-intent.test.ts`

- [ ] **Step 1: Write failing tests for resolveIntent**

Create `test/session-intent.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntent } from '../frontend/src/lib/session-intent.js';
import type { PickerItem, SessionIntent } from '../frontend/src/lib/session-intent.js';
import type { PullRequest, SessionSummary, WorktreeInfo } from '../frontend/src/lib/types.js';

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'Test PR',
    url: 'https://github.com/test/repo/pull/1',
    headRefName: 'feat/test',
    baseRefName: 'main',
    state: 'OPEN',
    author: 'user',
    role: 'author',
    updatedAt: '2026-03-29T00:00:00Z',
    additions: 10,
    deletions: 5,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    ciStatus: 'SUCCESS',
    isDraft: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    type: 'agent',
    agent: 'claude',
    repoName: 'repo',
    repoPath: '/path/to/repo',
    worktreePath: '/path/to/worktree',
    cwd: '/path/to/worktree',
    branchName: 'feat/test',
    displayName: 'test session',
    createdAt: '2026-03-29T00:00:00Z',
    lastActivity: '2026-03-29T00:00:00Z',
    idle: false,
    ...overrides,
  };
}

function makeWorktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    name: 'everest',
    path: '/path/to/worktree',
    repoName: 'repo',
    repoPath: '/path/to/repo',
    displayName: 'everest',
    lastActivity: '2026-03-29T00:00:00Z',
    branchName: 'feat/test',
    ...overrides,
  };
}

describe('resolveIntent', () => {
  it('returns review-pr intent for reviewer on open PR', () => {
    const item: PickerItem = { kind: 'pr', pr: makePr({ role: 'reviewer', state: 'OPEN' }) };
    const intents = resolveIntent(item, 'reviewer', [], []);
    assert.ok(intents.length >= 1);
    assert.equal(intents[0]!.type, 'review-pr');
    assert.equal(intents[0]!.color, 'info');
    assert.ok(intents[0]!.prompt); // review prompt should exist
  });

  it('returns merge-pr intent for author on open mergeable PR', () => {
    const item: PickerItem = { kind: 'pr', pr: makePr({ role: 'author', mergeable: 'MERGEABLE' }) };
    const intents = resolveIntent(item, 'author', [], []);
    assert.ok(intents.length >= 1);
    assert.equal(intents[0]!.type, 'merge-pr');
    assert.equal(intents[0]!.color, 'success');
    assert.equal(intents[0]!.prompt, null); // merge is a GitHub link
  });

  it('returns resume-session when matching session exists', () => {
    const pr = makePr({ headRefName: 'feat/test' });
    const session = makeSession({ branchName: 'feat/test' });
    const item: PickerItem = { kind: 'pr', pr };
    const intents = resolveIntent(item, 'author', [session], []);
    // resume-session should appear in the intents
    const resume = intents.find(i => i.type === 'resume-session');
    assert.ok(resume);
    assert.equal(resume!.existingSessionId, 'sess-1');
  });

  it('returns open-branch for branch without session', () => {
    const item: PickerItem = {
      kind: 'branch',
      name: 'feat/new',
      ahead: 3,
      behind: 0,
      prNumber: null,
      repoPath: '/path/to/repo',
    };
    const intents = resolveIntent(item, 'author', [], []);
    assert.ok(intents.length >= 1);
    assert.equal(intents[0]!.type, 'open-branch');
    assert.ok(intents[0]!.prompt);
  });

  it('returns resume-session for branch with existing session', () => {
    const session = makeSession({ branchName: 'feat/existing' });
    const item: PickerItem = {
      kind: 'branch',
      name: 'feat/existing',
      ahead: 1,
      behind: 0,
      prNumber: null,
      repoPath: '/path/to/repo',
    };
    const intents = resolveIntent(item, 'author', [session], []);
    assert.equal(intents[0]!.type, 'resume-session');
    assert.equal(intents[0]!.existingSessionId, 'sess-1');
  });

  it('returns start-from-issue for GitHub issue', () => {
    const item: PickerItem = {
      kind: 'issue',
      issue: {
        number: 45,
        title: 'Mobile virtual keyboard covers input',
        url: 'https://github.com/test/repo/issues/45',
        state: 'OPEN',
        labels: [{ name: 'bug', color: 'ff0000' }],
        assignees: [{ login: 'user' }],
        createdAt: '2026-03-29T00:00:00Z',
        updatedAt: '2026-03-29T00:00:00Z',
        repoName: 'repo',
        repoPath: '/path/to/repo',
      },
    };
    const intents = resolveIntent(item, 'author', [], []);
    assert.ok(intents.length >= 1);
    assert.equal(intents[0]!.type, 'start-from-issue');
    assert.ok(intents[0]!.prompt);
    assert.ok(intents[0]!.prompt!.includes('#45'));
    assert.ok(intents[0]!.prompt!.includes('Mobile virtual keyboard covers input'));
  });

  it('returns archive for merged PR', () => {
    const item: PickerItem = { kind: 'pr', pr: makePr({ state: 'MERGED' }) };
    const intents = resolveIntent(item, 'author', [], []);
    assert.equal(intents[0]!.type, 'archive');
  });

  it('returns fix-conflicts for PR with conflicts', () => {
    const item: PickerItem = { kind: 'pr', pr: makePr({ mergeable: 'CONFLICTING' }) };
    const intents = resolveIntent(item, 'author', [], []);
    assert.equal(intents[0]!.type, 'fix-conflicts');
    assert.equal(intents[0]!.color, 'error');
  });

  it('always returns at least one intent', () => {
    const item: PickerItem = { kind: 'pr', pr: makePr() };
    const intents = resolveIntent(item, 'author', [], []);
    assert.ok(intents.length >= 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `tsc -p tsconfig.test.json && node --test --test-force-exit dist/test/session-intent.test.js`

Expected: FAIL — module `session-intent.js` does not exist.

- [ ] **Step 3: Implement session-intent.ts**

Create `frontend/src/lib/session-intent.ts`:

```typescript
import type { PullRequest, SessionSummary, WorktreeInfo, GitHubIssue } from './types.js';
import { derivePrAction, getActionPrompt } from './pr-state.js';
import type { StatusColor, PrStateInput } from './pr-state.js';

export type SessionIntentType =
  | 'review-pr'
  | 'fix-conflicts'
  | 'fix-errors'
  | 'resolve-comments'
  | 'merge-pr'
  | 'create-pr'
  | 'open-branch'
  | 'start-from-issue'
  | 'resume-session'
  | 'archive';

export interface SessionIntent {
  type: SessionIntentType;
  label: string;
  color: StatusColor;
  prompt: string | null;
  existingSessionId?: string;
  existingWorktreePath?: string;
}

export type PickerItem =
  | { kind: 'pr'; pr: PullRequest }
  | { kind: 'branch'; name: string; ahead: number; behind: number; prNumber: number | null; repoPath: string }
  | { kind: 'issue'; issue: GitHubIssue };

/**
 * Resolve the available actions for a picker item based on role and existing state.
 * Returns at least one intent. First is primary, rest are secondary.
 */
export function resolveIntent(
  item: PickerItem,
  role: 'author' | 'reviewer',
  sessions: SessionSummary[],
  worktrees: WorktreeInfo[],
): SessionIntent[] {
  switch (item.kind) {
    case 'pr':
      return resolvePrIntent(item.pr, role, sessions, worktrees);
    case 'branch':
      return resolveBranchIntent(item, sessions, worktrees);
    case 'issue':
      return resolveIssueIntent(item.issue, sessions);
  }
}

function resolvePrIntent(
  pr: PullRequest,
  role: 'author' | 'reviewer',
  sessions: SessionSummary[],
  _worktrees: WorktreeInfo[],
): SessionIntent[] {
  const intents: SessionIntent[] = [];

  // Check for existing session on this PR's branch
  const existingSession = sessions.find(s => s.branchName === pr.headRefName);

  // Build PrStateInput from PullRequest data
  const prStateInput: PrStateInput = {
    commitsAhead: 1,
    prState: pr.isDraft ? 'DRAFT' : pr.state,
    ciPassing: pr.ciStatus === 'SUCCESS' ? 1 : 0,
    ciFailing: (pr.ciStatus === 'FAILURE' || pr.ciStatus === 'ERROR') ? 1 : 0,
    ciPending: pr.ciStatus === 'PENDING' ? 1 : 0,
    ciTotal: pr.ciStatus ? 1 : 0,
    mergeable: pr.mergeable,
    unresolvedCommentCount: pr.reviewDecision === 'CHANGES_REQUESTED' ? 1 : 0,
    role,
  };

  const prAction = derivePrAction(prStateInput);
  const actionCtx = {
    branchName: pr.headRefName,
    baseBranch: pr.baseRefName,
    prNumber: pr.number,
    unresolvedCommentCount: prStateInput.unresolvedCommentCount,
  };
  const prompt = getActionPrompt(prAction, actionCtx);

  // Map PrAction to SessionIntent
  const intentType = mapPrActionToIntent(prAction.type);
  intents.push({
    type: intentType,
    label: prAction.label,
    color: prAction.color,
    prompt,
    existingSessionId: existingSession?.id,
    existingWorktreePath: existingSession?.worktreePath ?? undefined,
  });

  // Add resume-session if session exists and primary isn't already resume
  if (existingSession && intentType !== 'resume-session') {
    intents.push({
      type: 'resume-session',
      label: 'Resume',
      color: 'muted',
      prompt: null,
      existingSessionId: existingSession.id,
      existingWorktreePath: existingSession.worktreePath ?? undefined,
    });
  }

  return intents;
}

function mapPrActionToIntent(actionType: string): SessionIntentType {
  switch (actionType) {
    case 'review-pr': return 'review-pr';
    case 'merge-pr': return 'merge-pr';
    case 'fix-conflicts': return 'fix-conflicts';
    case 'fix-errors': return 'fix-errors';
    case 'resolve-comments': return 'resolve-comments';
    case 'create-pr': return 'create-pr';
    case 'archive-merged':
    case 'archive-closed': return 'archive';
    default: return 'open-branch';
  }
}

function resolveBranchIntent(
  item: { kind: 'branch'; name: string; ahead: number; behind: number; prNumber: number | null; repoPath: string },
  sessions: SessionSummary[],
  worktrees: WorktreeInfo[],
): SessionIntent[] {
  const existingSession = sessions.find(s => s.branchName === item.name);
  const existingWorktree = worktrees.find(w => w.branchName === item.name);

  if (existingSession) {
    return [{
      type: 'resume-session',
      label: 'Resume',
      color: 'accent',
      prompt: null,
      existingSessionId: existingSession.id,
      existingWorktreePath: existingSession.worktreePath ?? undefined,
    }];
  }

  return [{
    type: 'open-branch',
    label: 'Open',
    color: 'accent',
    prompt: `Continue working on branch "${item.name}".`,
    existingWorktreePath: existingWorktree?.path,
  }];
}

function resolveIssueIntent(
  issue: GitHubIssue,
  sessions: SessionSummary[],
): SessionIntent[] {
  // Check if a session already exists for a branch matching this issue
  const issueBranchPattern = `issue-${issue.number}`;
  const existingSession = sessions.find(s => s.branchName.includes(issueBranchPattern));

  if (existingSession) {
    return [
      {
        type: 'resume-session',
        label: 'Resume',
        color: 'accent',
        prompt: null,
        existingSessionId: existingSession.id,
        existingWorktreePath: existingSession.worktreePath ?? undefined,
      },
      {
        type: 'start-from-issue',
        label: 'Start New',
        color: 'muted',
        prompt: buildIssuePrompt(issue),
      },
    ];
  }

  return [{
    type: 'start-from-issue',
    label: 'Start',
    color: 'accent',
    prompt: buildIssuePrompt(issue),
  }];
}

function buildIssuePrompt(issue: GitHubIssue): string {
  const labels = issue.labels.map(l => l.name).join(', ');
  return `Work on issue #${issue.number}: ${issue.title}\n\nLabels: ${labels}`;
}

/**
 * Derive a branch name from a GitHub issue.
 * Format: {type}/issue-{number}-{slug}
 * Type is derived from labels: bug → fix, enhancement/feature → feat, default → feat
 * Slug is first 5 words of title, lowercased and hyphenated.
 */
export function issueToBranchName(issue: GitHubIssue): string {
  const labelNames = issue.labels.map(l => l.name.toLowerCase());
  const type = labelNames.includes('bug') ? 'fix' : 'feat';
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .slice(0, 5)
    .join('-');
  return `${type}/issue-${issue.number}-${slug}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `tsc -p tsconfig.test.json && node --test --test-force-exit dist/test/session-intent.test.js`

Expected: ALL PASS.

- [ ] **Step 5: Build**

Run: `npm run build`

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/session-intent.ts test/session-intent.test.ts
git commit -m "feat: SessionIntent type and resolveIntent resolver for PRs, branches, and issues"
```

---

### Task 4: Fix Dashboard Row Actions (RepoDashboard + OrgDashboard + App.svelte)

**Files:**
- Modify: `frontend/src/components/RepoDashboard.svelte`
- Modify: `frontend/src/components/OrgDashboard.svelte`
- Modify: `frontend/src/App.svelte`

- [ ] **Step 1: Fix RepoDashboard.svelte prActionForRow to pass role and CI data**

In `frontend/src/components/RepoDashboard.svelte`, update the `prActionForRow` function. Note: `PullRequest.state` never contains `'DRAFT'` — draft status is encoded in `isDraft: boolean`. The old code never checked `isDraft`, so draft PRs were treated as `'OPEN'` and never got the `ready-for-review` action.

```typescript
  function prActionForRow(pr: PullRequest) {
    const prState = pr.isDraft ? 'DRAFT' : pr.state === 'OPEN' ? 'OPEN' : pr.state === 'MERGED' ? 'MERGED' : 'CLOSED';
    return derivePrAction({
      commitsAhead: 1,
      prState,
      ciPassing: pr.ciStatus === 'SUCCESS' ? 1 : 0,
      ciFailing: (pr.ciStatus === 'FAILURE' || pr.ciStatus === 'ERROR') ? 1 : 0,
      ciPending: pr.ciStatus === 'PENDING' ? 1 : 0,
      ciTotal: pr.ciStatus ? 1 : 0,
      mergeable: (pr.mergeable as 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null) ?? null,
      unresolvedCommentCount: pr.reviewDecision === 'CHANGES_REQUESTED' ? 1 : 0,
      role: pr.role,
    });
  }
```

- [ ] **Step 2: Update RepoDashboard prActionPills to handle merge-pr and review-pr correctly**

In the `prActionPills` snippet, replace the hardcoded merge/conflicts logic with action-driven rendering:

```svelte
{#snippet prActionPills(pr: PullRequest, action: ReturnType<typeof prActionForRow>)}
  <button
    class="pr-session-btn"
    title="Open session on this branch"
    onclick={() => onOpenPrSession(pr)}
  >+</button>
  {#if action.type === 'merge-pr'}
    <TuiButton
      variant="success"
      size="sm"
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      title="Ready to merge on GitHub"
    >
      {action.label}
    </TuiButton>
  {:else if action.type !== 'none' && action.label}
    <TuiButton
      variant={action.color === 'success' ? 'success' : action.color === 'error' ? 'danger' : action.color === 'info' ? 'info' : action.color === 'accent' ? 'primary' : 'ghost'}
      size="sm"
      title={action.label}
      disabled={action.type === 'checks-running'}
      onclick={() => onPrAction(pr)}
    >
      {action.label}
    </TuiButton>
  {/if}
{/snippet}
```

- [ ] **Step 3: Apply same fix to OrgDashboard.svelte prActionForRow**

In `frontend/src/components/OrgDashboard.svelte`, update `prActionForRow` identically:

```typescript
  function prActionForRow(pr: PullRequest) {
    const prState = pr.isDraft ? 'DRAFT' : pr.state === 'OPEN' ? 'OPEN' : pr.state === 'MERGED' ? 'MERGED' : 'CLOSED';
    return derivePrAction({
      commitsAhead: 1,
      prState,
      ciPassing: pr.ciStatus === 'SUCCESS' ? 1 : 0,
      ciFailing: (pr.ciStatus === 'FAILURE' || pr.ciStatus === 'ERROR') ? 1 : 0,
      ciPending: pr.ciStatus === 'PENDING' ? 1 : 0,
      ciTotal: pr.ciStatus ? 1 : 0,
      mergeable: (pr.mergeable as 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null) ?? null,
      unresolvedCommentCount: pr.reviewDecision === 'CHANGES_REQUESTED' ? 1 : 0,
      role: pr.role,
    });
  }
```

- [ ] **Step 4: Fix App.svelte handlePrAction to pass role**

In `frontend/src/App.svelte`, update `handlePrAction`:

```typescript
  function handlePrAction(pr: PullRequest) {
    const prState = pr.state === 'OPEN' ? 'OPEN' : pr.state === 'MERGED' ? 'MERGED' : 'CLOSED';
    const action = derivePrAction({
      commitsAhead: 1,
      prState,
      ciPassing: pr.ciStatus === 'SUCCESS' ? 1 : 0,
      ciFailing: (pr.ciStatus === 'FAILURE' || pr.ciStatus === 'ERROR') ? 1 : 0,
      ciPending: pr.ciStatus === 'PENDING' ? 1 : 0,
      ciTotal: pr.ciStatus ? 1 : 0,
      mergeable: (pr.mergeable as 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null) ?? null,
      unresolvedCommentCount: pr.reviewDecision === 'CHANGES_REQUESTED' ? 1 : 0,
      role: pr.role,
    });
    const prompt = getActionPrompt(action, {
      branchName: pr.headRefName,
      baseBranch: pr.baseRefName,
      prNumber: pr.number,
    });
    if (prompt) {
      handleOpenPrBranch(pr, prompt);
    }
  }
```

- [ ] **Step 5: Check TuiButton supports `info` variant**

Read `frontend/src/components/TuiButton.svelte` and verify it has an `info` variant. If not, add it:

```css
/* In TuiButton.svelte <style> */
.tui-button--info {
  border-color: var(--status-info);
  color: var(--status-info);
}

.tui-button--info:hover:not(:disabled) {
  background: color-mix(in srgb, var(--status-info) 10%, transparent);
}
```

And add `'info'` to the variant prop type.

- [ ] **Step 6: Build and verify**

Run: `npm run build`

Expected: Build succeeds with no new errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/RepoDashboard.svelte frontend/src/components/OrgDashboard.svelte frontend/src/App.svelte frontend/src/components/TuiButton.svelte
git commit -m "fix: dashboard rows now pass role and CI data to derivePrAction — reviewers see Review CTA"
```

---

### Task 5: Build OpenPicker Component

**Files:**
- Create: `frontend/src/components/OpenPicker.svelte`
- Create: `frontend/src/components/PickerResultRow.svelte`

This is the largest task. The OpenPicker is a tabbed modal (all/prs/branches/issues) that resolves items into SessionIntents. It uses TanStack Query to read cached data and the `resolveIntent` function for action buttons.

- [ ] **Step 1: Create PickerResultRow.svelte**

Create `frontend/src/components/PickerResultRow.svelte`:

```svelte
<script lang="ts">
  import type { SessionIntent } from '../lib/session-intent.js';
  import type { StatusColor } from '../lib/pr-state.js';
  import StatusDot from './StatusDot.svelte';
  import TuiButton from './TuiButton.svelte';
  import type { PrDotStatus } from '../lib/pr-status.js';

  let {
    label,
    sublabel = '',
    dotStatus,
    intents,
    focused = false,
    onSelectIntent,
    onRowClick,
  }: {
    label: string;
    sublabel?: string;
    dotStatus?: PrDotStatus;
    intents: SessionIntent[];
    focused?: boolean;
    onSelectIntent: (intent: SessionIntent) => void;
    onRowClick?: () => void;
  } = $props();

  function colorToVariant(color: StatusColor): 'primary' | 'ghost' | 'danger' | 'success' | 'info' {
    if (color === 'success') return 'success';
    if (color === 'error') return 'danger';
    if (color === 'info') return 'info';
    if (color === 'accent') return 'primary';
    return 'ghost';
  }

  let primary = $derived(intents[0]);
  let secondary = $derived(intents.slice(1));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="picker-row"
  class:focused
  role="option"
  aria-selected={focused}
  onclick={() => {
    if (primary) onSelectIntent(primary);
    else onRowClick?.();
  }}
>
  <div class="row-left">
    {#if dotStatus}
      <StatusDot status={dotStatus} size={7} />
    {:else}
      <span class="row-icon">▸</span>
    {/if}
    <div class="row-text">
      <span class="row-label">{label}</span>
      {#if sublabel}
        <span class="row-sublabel">{sublabel}</span>
      {/if}
    </div>
  </div>
  <div class="row-actions">
    {#each secondary as intent}
      <TuiButton
        variant={colorToVariant(intent.color)}
        size="sm"
        onclick={(e) => { e.stopPropagation(); onSelectIntent(intent); }}
      >
        {intent.label}
      </TuiButton>
    {/each}
    {#if primary}
      <TuiButton
        variant={colorToVariant(primary.color)}
        size="sm"
        disabled={primary.type === 'merge-pr'}
        href={primary.type === 'merge-pr' ? undefined : undefined}
        onclick={(e) => { e.stopPropagation(); onSelectIntent(primary); }}
      >
        {primary.label}
      </TuiButton>
    {/if}
  </div>
</div>

<style>
  .picker-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    min-height: 44px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    transition: background 0.08s;
    gap: 8px;
  }

  .picker-row:hover,
  .picker-row.focused {
    background: var(--surface-hover);
    color: var(--text);
  }

  .row-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .row-icon {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.6;
  }

  .row-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .row-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-sublabel {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.5;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  @media (max-width: 600px) {
    .picker-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }

    .row-actions {
      align-self: flex-end;
    }
  }
</style>
```

- [ ] **Step 2: Create OpenPicker.svelte**

Create `frontend/src/components/OpenPicker.svelte`. This is a long file — the full implementation follows. It uses TanStack Query to read cached data (same query keys as existing components), has 4 tabs, search filtering, keyboard navigation, and renders `PickerResultRow` for each result.

```svelte
<script lang="ts">
  import { useQueryClient, createQuery } from '@tanstack/svelte-query';
  import type {
    PullRequest, OrgPrsResponse, GitHubIssue, GitHubIssuesResponse,
    SessionSummary, WorktreeInfo, BranchInfo,
  } from '../lib/types.js';
  import { fetchBranches } from '../lib/api.js';
  import { resolveIntent, issueToBranchName } from '../lib/session-intent.js';
  import type { SessionIntent, PickerItem } from '../lib/session-intent.js';
  import { derivePrDotStatus } from '../lib/pr-status.js';
  import PickerResultRow from './PickerResultRow.svelte';
  import TuiInput from './TuiInput.svelte';
  import StatusDot from './StatusDot.svelte';

  let {
    open = false,
    repoPath,
    sessions,
    worktrees,
    onClose,
    onSelectIntent,
  }: {
    open: boolean;
    repoPath: string;
    sessions: SessionSummary[];
    worktrees: WorktreeInfo[];
    onClose: () => void;
    onSelectIntent: (intent: SessionIntent, item: PickerItem) => void;
  } = $props();

  type TabId = 'all' | 'prs' | 'branches' | 'issues';

  let activeTab = $state<TabId>('all');
  let query = $state('');
  let focusedIndex = $state(0);
  let inputWrapperEl = $state<HTMLDivElement | undefined>(undefined);

  const queryClient = useQueryClient();

  // Data sources — read from TanStack Query cache + fetch branches on demand
  let cachedPrs = $derived<PullRequest[]>(
    queryClient.getQueryData<OrgPrsResponse>(['org-prs'])?.prs ?? []
  );

  let cachedIssues = $derived<GitHubIssue[]>(
    queryClient.getQueryData<GitHubIssuesResponse>(['github-issues'])?.issues ?? []
  );

  const branchQuery = createQuery<BranchInfo[]>(() => ({
    queryKey: ['branches', repoPath],
    queryFn: () => fetchBranches(repoPath),
    staleTime: 30_000,
    enabled: open && !!repoPath,
  }));

  let branches = $derived(branchQuery.data ?? []);

  // Filter by search query
  let q = $derived(query.toLowerCase().trim());

  let filteredPrs = $derived(
    q ? cachedPrs.filter(pr =>
      pr.title.toLowerCase().includes(q) ||
      String(pr.number).includes(q) ||
      pr.headRefName.toLowerCase().includes(q)
    ) : cachedPrs
  );

  let filteredBranches = $derived(
    q ? branches.filter(b => b.name.toLowerCase().includes(q)) : branches
  );

  let filteredIssues = $derived(
    q ? cachedIssues.filter(i =>
      i.title.toLowerCase().includes(q) ||
      String(i.number).includes(q)
    ) : cachedIssues
  );

  // Group PRs by role
  let reviewPrs = $derived(filteredPrs.filter(pr => pr.role === 'reviewer' && pr.state === 'OPEN'));
  let authorPrs = $derived(filteredPrs.filter(pr => pr.role === 'author' || pr.state !== 'OPEN'));

  // Build picker items with intents
  interface PickerRow {
    item: PickerItem;
    intents: SessionIntent[];
    label: string;
    sublabel: string;
    dotStatus?: import('../lib/pr-status.js').PrDotStatus;
  }

  function prToRow(pr: PullRequest): PickerRow {
    const item: PickerItem = { kind: 'pr', pr };
    return {
      item,
      intents: resolveIntent(item, pr.role, sessions, worktrees),
      label: `#${pr.number} ${pr.title}`,
      sublabel: pr.repoName ?? pr.headRefName,
      dotStatus: derivePrDotStatus(pr),
    };
  }

  function branchToRow(branch: BranchInfo): PickerRow {
    const prForBranch = cachedPrs.find(pr => pr.headRefName === branch.name);
    const item: PickerItem = {
      kind: 'branch',
      name: branch.name,
      ahead: 0,
      behind: 0,
      prNumber: prForBranch?.number ?? null,
      repoPath,
    };
    return {
      item,
      intents: resolveIntent(item, 'author', sessions, worktrees),
      label: branch.name,
      sublabel: prForBranch ? `PR #${prForBranch.number}` : '',
    };
  }

  function issueToRow(issue: GitHubIssue): PickerRow {
    const item: PickerItem = { kind: 'issue', issue };
    return {
      item,
      intents: resolveIntent(item, 'author', sessions, []),
      label: `#${issue.number} ${issue.title}`,
      sublabel: issue.labels.map(l => l.name).join(', '),
    };
  }

  // Tab content
  interface ResultGroup {
    label: string;
    rows: PickerRow[];
  }

  let groups = $derived.by((): ResultGroup[] => {
    switch (activeTab) {
      case 'prs': {
        const groups: ResultGroup[] = [];
        if (reviewPrs.length > 0) groups.push({ label: 'needs your review', rows: reviewPrs.map(prToRow) });
        if (authorPrs.length > 0) groups.push({ label: 'your pull requests', rows: authorPrs.map(prToRow) });
        return groups;
      }
      case 'branches':
        return filteredBranches.length > 0
          ? [{ label: 'branches', rows: filteredBranches.map(branchToRow) }]
          : [];
      case 'issues': {
        const assigned = filteredIssues.filter(i => i.assignees.length > 0);
        const unassigned = filteredIssues.filter(i => i.assignees.length === 0);
        const groups: ResultGroup[] = [];
        if (assigned.length > 0) groups.push({ label: 'assigned to you', rows: assigned.map(issueToRow) });
        if (unassigned.length > 0) groups.push({ label: 'recent issues', rows: unassigned.map(issueToRow) });
        return groups;
      }
      case 'all': {
        const groups: ResultGroup[] = [];
        if (reviewPrs.length > 0) groups.push({ label: 'needs your review', rows: reviewPrs.slice(0, 3).map(prToRow) });
        if (authorPrs.length > 0) groups.push({ label: 'pull requests', rows: authorPrs.slice(0, 3).map(prToRow) });
        if (filteredBranches.length > 0) groups.push({ label: 'branches', rows: filteredBranches.slice(0, 5).map(branchToRow) });
        if (filteredIssues.length > 0) groups.push({ label: 'issues', rows: filteredIssues.slice(0, 3).map(issueToRow) });
        return groups;
      }
    }
  });

  let flatRows = $derived(groups.flatMap(g => g.rows));

  // Clamp focused index
  $effect(() => {
    if (focusedIndex >= flatRows.length) {
      focusedIndex = Math.max(0, flatRows.length - 1);
    }
  });

  // Reset state when opened
  $effect(() => {
    if (open) {
      query = '';
      activeTab = 'all';
      focusedIndex = 0;
      requestAnimationFrame(() => inputWrapperEl?.querySelector('input')?.focus());
    }
  });

  const tabs: { id: TabId; label: string }[] = [
    { id: 'all', label: 'all' },
    { id: 'prs', label: 'prs' },
    { id: 'branches', label: 'branches' },
    { id: 'issues', label: 'issues' },
  ];

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusedIndex = Math.min(focusedIndex + 1, flatRows.length - 1);
      scrollFocusedIntoView();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusedIndex = Math.max(focusedIndex - 1, 0);
      scrollFocusedIntoView();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const currentIdx = tabs.findIndex(t => t.id === activeTab);
      const nextIdx = e.shiftKey
        ? (currentIdx - 1 + tabs.length) % tabs.length
        : (currentIdx + 1) % tabs.length;
      activeTab = tabs[nextIdx]!.id;
      focusedIndex = 0;
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = flatRows[focusedIndex];
      if (row && row.intents[0]) {
        onSelectIntent(row.intents[0], row.item);
        onClose();
      }
      return;
    }
  }

  function scrollFocusedIntoView() {
    requestAnimationFrame(() => {
      document.querySelector('.picker-row.focused')?.scrollIntoView({ block: 'nearest' });
    });
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('picker-overlay')) {
      onClose();
    }
  }

  function handleIntentSelect(intent: SessionIntent, item: PickerItem) {
    onSelectIntent(intent, item);
    onClose();
  }

  // Empty/error state messages
  let emptyMessage = $derived.by((): string => {
    if (q) return `no results for '${q}'`;
    switch (activeTab) {
      case 'prs': return 'no open pull requests';
      case 'branches': return 'no branches found';
      case 'issues': return 'no open issues';
      case 'all': return 'no items found';
    }
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="picker-overlay" onclick={handleBackdropClick}>
    <div class="picker" role="dialog" aria-modal="true" aria-label="Open picker">
      <!-- Search -->
      <div class="picker-search" bind:this={inputWrapperEl}>
        <span class="picker-prompt">/</span>
        <TuiInput
          bind:value={query}
          placeholder="search..."
          onkeydown={handleKeydown}
          autocomplete="off"
          spellcheck={false}
        />
        <button class="picker-close-btn" onclick={onClose} aria-label="Close">esc</button>
      </div>

      <!-- Tabs -->
      <div class="picker-tabs" role="tablist">
        {#each tabs as tab}
          <button
            class="picker-tab"
            class:active={activeTab === tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onclick={() => { activeTab = tab.id; focusedIndex = 0; }}
          >
            {tab.label}
          </button>
        {/each}
      </div>

      <!-- Results -->
      <div class="picker-results" role="listbox">
        {#if flatRows.length === 0}
          <div class="picker-empty">{emptyMessage}</div>
        {:else}
          {#each groups as group}
            <div class="picker-category">{group.label}</div>
            {#each group.rows as row, i}
              {@const globalIndex = flatRows.indexOf(row)}
              <PickerResultRow
                label={row.label}
                sublabel={row.sublabel}
                dotStatus={row.dotStatus}
                intents={row.intents}
                focused={globalIndex === focusedIndex}
                onSelectIntent={(intent) => handleIntentSelect(intent, row.item)}
                onRowClick={() => {
                  if (row.intents[0]) handleIntentSelect(row.intents[0], row.item);
                }}
              />
            {/each}
          {/each}
        {/if}
      </div>

      <!-- Footer -->
      <div class="picker-footer">
        <span class="hint">↑↓ navigate</span>
        <span class="hint">tab switch tabs</span>
        <span class="hint">↵ select</span>
        <span class="hint">esc close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .picker-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 1000;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 15vh;
  }

  .picker {
    width: 100%;
    max-width: 600px;
    background: var(--surface);
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    max-height: 60vh;
  }

  .picker-search {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    gap: 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .picker-prompt {
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    color: var(--accent);
    flex-shrink: 0;
    user-select: none;
  }

  .picker-search :global(.tui-input-wrapper) {
    flex: 1;
  }

  .picker-search :global(.tui-input) {
    background: transparent;
    border: none;
    padding: 0;
  }

  .picker-search :global(.tui-input:focus) {
    border: none;
  }

  .picker-close-btn {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    background: none;
    border: 1px solid var(--border);
    padding: 2px 6px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .picker-close-btn:hover {
    border-color: var(--text-muted);
  }

  /* Tabs */
  .picker-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .picker-tab {
    padding: 8px 16px;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
  }

  .picker-tab:hover {
    color: var(--text);
  }

  .picker-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  /* Results */
  .picker-results {
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .picker-category {
    padding: 8px 16px 4px;
    font-size: var(--font-size-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.08em;
    user-select: none;
  }

  .picker-empty {
    padding: 24px 16px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    opacity: 0.6;
    text-align: center;
  }

  /* Footer */
  .picker-footer {
    display: flex;
    gap: 16px;
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .hint {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    opacity: 0.5;
  }

  /* Mobile — full-screen picker */
  @media (max-width: 600px) {
    .picker-overlay {
      padding-top: 0;
    }

    .picker {
      max-width: 100%;
      max-height: 100vh;
      height: 100vh;
      border: none;
    }

    .picker-close-btn {
      display: inline-flex;
    }
  }
</style>
```

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: Build succeeds. The component isn't wired up yet, so no runtime testing.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/OpenPicker.svelte frontend/src/components/PickerResultRow.svelte
git commit -m "feat: OpenPicker component — tabbed modal with intent-based PR/branch/issue picker"
```

---

### Task 6: Wire OpenPicker to App.svelte

**Files:**
- Modify: `frontend/src/App.svelte`

- [ ] **Step 1: Import and add OpenPicker state**

Add imports at the top of `App.svelte`:

```typescript
import OpenPicker from './components/OpenPicker.svelte';
import type { SessionIntent, PickerItem } from './lib/session-intent.js';
import { issueToBranchName } from './lib/session-intent.js';
```

Add state:

```typescript
let pickerOpen = $state(false);
```

- [ ] **Step 2: Add keyboard shortcut to open picker**

In the existing `handleKeyDown` or `onMount` section of App.svelte, add listener for `/` and `Cmd+K`:

```typescript
function handleGlobalKeydown(e: KeyboardEvent) {
  // Open picker with / or Cmd+K (when not in an input)
  if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && !isInputFocused()) {
    e.preventDefault();
    pickerOpen = true;
  }
}

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}
```

Register with `<svelte:window onkeydown={handleGlobalKeydown} />` if not already present.

- [ ] **Step 3: Add intent handler**

Add the handler function that processes selected intents:

```typescript
async function handlePickerIntent(intent: SessionIntent, item: PickerItem) {
  switch (intent.type) {
    case 'resume-session': {
      if (intent.existingSessionId) {
        sessionState.activeSessionId = intent.existingSessionId;
        closeSidebar();
      }
      break;
    }
    case 'review-pr':
    case 'fix-conflicts':
    case 'fix-errors':
    case 'resolve-comments':
    case 'create-pr': {
      if (item.kind === 'pr') {
        handleOpenPrBranch(item.pr, intent.prompt ?? undefined);
      }
      break;
    }
    case 'merge-pr': {
      if (item.kind === 'pr') {
        window.open(item.pr.url, '_blank');
      }
      break;
    }
    case 'open-branch': {
      if (item.kind === 'branch') {
        await handleOpenBranchSession(item.name, item.repoPath, intent.prompt ?? undefined);
      }
      break;
    }
    case 'start-from-issue': {
      if (item.kind === 'issue') {
        const branchName = issueToBranchName(item.issue);
        await handleOpenBranchSession(branchName, item.issue.repoPath, intent.prompt ?? undefined);
      }
      break;
    }
    case 'archive': {
      // Archive is handled by the delete worktree flow
      break;
    }
  }
}

async function handleOpenBranchSession(branchName: string, repoPath: string, prompt?: string) {
  try {
    const wt = await createWorktree(repoPath, branchName);
    const session = await createSession({
      repoPath,
      worktreePath: wt.worktreePath,
      type: 'agent',
      branchName: wt.branchName,
    });
    await refreshAll();
    sessionState.activeSessionId = session.id;
    ui.activeRepoPath = repoPath;
    initSessionNotification(session.id, configState.defaultNotifications);
    closeSidebar();

    if (prompt) {
      setTimeout(() => sendPtyData(prompt + '\r'), 1500);
    }
  } catch (e) {
    console.error('Failed to open branch session:', e);
  }
}
```

- [ ] **Step 4: Render OpenPicker in the template**

Add to App.svelte template, at the end (before closing div):

```svelte
<OpenPicker
  bind:open={pickerOpen}
  repoPath={ui.activeRepoPath ?? ''}
  sessions={sessionState.sessions}
  worktrees={sessionState.worktrees}
  onClose={() => pickerOpen = false}
  onSelectIntent={handlePickerIntent}
/>
```

- [ ] **Step 5: Build and verify**

Run: `npm run build`

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.svelte
git commit -m "feat: wire OpenPicker to App — / and Cmd+K open picker, intents resolve to sessions"
```

---

### Task 7: Mobile Responsive Pass

**Files:**
- Modify: `frontend/src/components/OpenPicker.svelte`
- Modify: `frontend/src/components/PickerResultRow.svelte`

- [ ] **Step 1: Verify mobile styles are in place**

The OpenPicker and PickerResultRow already have `@media (max-width: 600px)` blocks from Task 5. Verify:

- Picker goes full-screen (no overlay gap) — `padding-top: 0`, `height: 100vh`
- Actions stack below content — `flex-direction: column` on rows
- Touch targets >= 44px — `min-height: 44px` on rows
- Close button shows "close" text instead of "esc"

- [ ] **Step 2: Update close button for mobile**

In `OpenPicker.svelte`, make the close button text responsive:

```svelte
<button class="picker-close-btn" onclick={onClose} aria-label="Close">
  <span class="close-desktop">esc</span>
  <span class="close-mobile">close</span>
</button>
```

Add CSS:

```css
.close-mobile { display: none; }

@media (max-width: 600px) {
  .close-desktop { display: none; }
  .close-mobile { display: inline; }
}
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/OpenPicker.svelte frontend/src/components/PickerResultRow.svelte
git commit -m "feat: mobile responsive picker — full-screen, stacked actions, touch targets"
```

---

### Task 8: Final Build + Test Verification

- [ ] **Step 1: Run full test suite**

Run: `tsc -p tsconfig.test.json && node --test --test-force-exit dist/test/pr-state.test.js dist/test/session-intent.test.js`

Expected: ALL PASS.

- [ ] **Step 2: Run full build**

Run: `npm run build`

Expected: Build succeeds with no new errors beyond existing ones (shiki/diff2html type issues are pre-existing).

- [ ] **Step 3: Verify no regressions**

Spot-check:
- `PrTopBar.svelte` still works (derivePrAction with no role defaults to author)
- `RepoDashboard.svelte` now shows role-aware actions
- `Spotlight.svelte` is untouched (OpenPicker is a new component)

---

## Dependency Graph

```
Task 1 (CSS fix) ─────────────────── standalone
Task 2 (pr-state role) ──────┐
Task 3 (session-intent) ─────┤── Task 4 (dashboard fix) ── Task 5 (OpenPicker) ── Task 6 (wire) ── Task 7 (mobile) ── Task 8 (verify)
```

Tasks 1, 2, and 3 are independent and can be parallelized. Task 4 depends on 2+3. Tasks 5-7 are sequential. Task 8 is the final gate.
