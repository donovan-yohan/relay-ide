# Implementation: Sidebar & Navigation UX

**Priority: WAVE 2 — Depends on Worktree Lifecycle items 1-2.**

## Pre-flight Checks

```bash
# 1. Current state
git status
git log --oneline -3

# 2. Pull latest nightly
git fetch origin nightly
git rebase origin/nightly

# 3. CRITICAL: Verify Worktree Lifecycle contracts have landed on nightly
#    Check for the enhanced worktree endpoint and branch watching
git log origin/nightly --oneline --grep="worktree" --grep="lifecycle" --grep="branch-changed" --all-match | head -5

# 4. Verify these specific things exist on nightly before starting:
#    a. session-branch-changed WebSocket event in server/ws.ts or server/watcher.ts
#    b. branchState field in GET /worktrees response
#    c. continuePolicy field in session creation
grep -r "session-branch-changed" server/ || echo "BLOCKER: session-branch-changed event not found"
grep -r "branchState" server/ || echo "BLOCKER: branchState not found in worktree response"

# 5. Design doc exists
cat docs/design-docs/2026-03-28-sidebar-ux-redesign-design.md | head -5
```

**If blockers found:** Wait for Worktree Lifecycle stream to merge items 1-2. Items 1 (double-click) and 3 (stale repo names) can start independently.

## Design Doc

Read fully: `docs/design-docs/2026-03-28-sidebar-ux-redesign-design.md`

## What This Stream CONSUMES

### From Worktree Lifecycle (must be on nightly):
- `session-branch-changed` WebSocket event → drives CipherText animation on branch name update (Item 2)
- `branchState: BranchLifecycleState` on GET /worktrees → feeds into attentionScore computation
- Enhanced `POST /workspaces/worktree` endpoint → not directly used, but the lifecycle state it enables is consumed

### From Command Center (NOT a blocker — additive):
- Action registration interface → sidebar actions register with ActionRegistry when it ships
- This stream does NOT wait for Command Center. Actions are registered as a follow-up.

## What This Stream PRODUCES

### Contract: Session Display State Chain

```typescript
type DisplayState = 'initializing' | 'running' | 'unseen-idle' | 'seen-idle'
  | 'permission' | 'needs-answer' | 'inactive' | 'error';

// WebSocket extension needed (produce from server):
// session-state-changed event adds permissionType
{ sessionId: string; state: BackendDisplayState; permissionType?: 'approval' | 'question' }

// Attention score function (frontend):
function computeAttentionScore(session: SidebarSession): number;
```

Consumers: Command Center (ActionContext.agentRunning derives from DisplayState), True Workspaces (uses sidebar indicators as-is).

## Implementation Order (from design doc)

Items 1-3 have no cross-stream deps — start immediately:
1. **Item 3: Fix stale repo names** — Read real git state on workspace load
2. **Item 1: Double-click expand/collapse** — Add dblclick handler to WorkspaceItem
3. **Item 2: Fix stale branch names** — DEPENDS ON worktree lifecycle (session-branch-changed event)

Items 4-8 build on each other:
4. **Item 4: Three-axis indicator model** — Replace StatusDot with shape+color system
5. **Item 5: PR status icons** — Icon-only PR glyphs with tooltips
6. **Attention scoring** — computeAttentionScore, sort workspaces + sessions
7. **Read/unread tracking** — Unread state management, bold/pulse overlay
8. **Workspace header summary pips** — Replace count badges

## What NOT to Build

- Sidebar header redesign → deferred to relay-phase3-spotlight (design doc already exists)
- "Needs-eyes" rail → Phase 2 idea, not in scope
- Command Center action registration → done when Command Center stream ships

## Process

1. Start Items 1 + 3 immediately (no deps)
2. Run `/harness:plan` for the full stream
3. Gate Item 2 on worktree lifecycle landing
4. Ship Items 4-8 as a unit after Items 1-3
5. Run `/harness:complete`
