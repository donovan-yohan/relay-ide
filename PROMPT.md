# Implementation: Worktree & Session Lifecycle

**Priority: WAVE 1 — Start first. All other streams depend on this.**

## Pre-flight Checks

```bash
# 1. Ensure we're on the right branch with a clean state
git status
git log --oneline -3

# 2. Pull latest nightly (this stream has NO upstream dependencies)
git fetch origin nightly
git rebase origin/nightly

# 3. Verify design doc exists
cat docs/design-docs/2026-03-28-worktree-lifecycle-design.md | head -5
```

No dependencies on other streams. This is the foundation.

## Design Doc

Read fully before starting: `docs/design-docs/2026-03-28-worktree-lifecycle-design.md`

## What This Stream PRODUCES (shared contracts)

Other streams block on these. Ship them first.

### Contract 1: Enhanced Worktree Creation Endpoint

```typescript
// POST /workspaces/worktree (existing endpoint, enhanced)
// Request
{ repoPath: string; branch: string; continuePolicy?: 'always' | 'never' }

// Success (200 existing, 201 created)
{ path: string; existing: boolean }

// Conflict — branch checked out in main repo (409)
{ error: 'branch_checked_out_in_main'; repoPath: string }

// Not found (404)
{ error: 'branch_not_found'; branch: string; remote: string }
```

Consumers: PR Integration picker, True Workspaces launch, Command Center "new-worktree" action.

### Contract 2: Branch Lifecycle State on GET /worktrees

```typescript
type BranchLifecycleState = 'active' | 'stale' | 'merged' | 'archived';

// Each entry in GET /worktrees response gets:
{ branchState: BranchLifecycleState; prNumber?: number; prTitle?: string }

// New endpoint:
// GET /worktrees/:path/status
{ activeSessions: string[]; hasUncommittedChanges: boolean }
```

### Contract 3: WebSocket Events

```typescript
// New event: session-branch-changed
{ sessionId: string; branch: string }

// Existing event enriched: worktrees-changed
// (triggers refresh, GET /worktrees now includes branchState)
```

### Contract 4: continuePolicy replaces boolean continue

```typescript
// In session creation request body and resolveSessionSettings:
continuePolicy: 'always' | 'never'  // replaces continue: boolean
```

## Implementation Order (from design doc)

1. **Item 3: continuePolicy** — Replace `.claude` heuristic with explicit policy. Most impactful reliability fix.
2. **Items 1+2: Worktree detection + remote fetch** — The enhanced POST endpoint. Ship the contract other streams need.
3. **Item 4: Tmux naming** — Self-contained string format change (`crc-{repoSlug}-{branchSlug}-{shortId}`)
4. **Item 5: Auto-archive** — Lifecycle state computation, cleanup prompts, cascade dialog. Builds on items 1-3.

## Process

1. Run `/harness:plan` referencing the design doc
2. Run `/harness:orchestrate` to execute
3. After items 1-3 land on nightly, notify other streams they can start
4. Run `/harness:complete` after item 5
