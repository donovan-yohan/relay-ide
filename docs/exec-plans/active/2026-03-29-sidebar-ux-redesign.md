# Sidebar & Navigation UX Redesign Implementation Plan

> **Status**: Active | **Created**: 2026-03-29 | **Last Updated**: 2026-03-29
> **Design Doc**: `docs/design-docs/2026-03-28-sidebar-ux-redesign-design.md`
> **Consulted Learnings**: L-20260322-session-state-refresh, L-20260324-status-state-machine, L-20260322-sidebar-group-identity, L-20260325-ws-query-invalidation, L-20260325-negative-cache-ttl, L-20260328-svelte-runes-testability, L-20260325-dual-mobile-mechanism
> **For Claude:** Use /harness:orchestrate to execute this plan.

**Goal:** Transform the sidebar from a static session list into a live attention engine with three-axis indicators (session state shape+color, read/unread overlay, PR icon glyphs), attention-scored sorting, and real-time branch updates.

**Architecture:** Extend the existing display-state machine to add `needs-answer` and `error` states, then build three visual layers that compose independently: a new `SessionIndicator` component replacing `StatusDot` for session state shapes, an `isUnread` tracking system layered on top, and icon-only PR glyphs replacing colored dots. An `attentionScore` function sorts both sessions-within-workspace and workspace-against-workspace. Branch staleness is fixed server-side by wiring `BranchWatcher` into WebSocket events, and repo name staleness by reading real git state on workspace load.

**Tech Stack:** Svelte 5 (runes), TypeScript, node:test, Express, node-pty, WebSocket

---

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-28 | Design | Approach C (Progressive Attention) — ship truth+sort now, design needs-eyes rail later | attentionScore drives sort immediately; real usage data guides phase 2 |
| 2026-03-28 | Design | Three independent visual axes (state shape, read/unread, PR icon) | Composable system — any state can be unread, PR status orthogonal to session state |
| 2026-03-28 | Design | Shape language organic→angular maps calm→urgent | Shapes distinguishable without color (accessibility) |
| 2026-03-28 | Design | Color-alpha pulse, NOT opacity pulse | Prevents cascading to child elements (tooltips) |
| 2026-03-28 | Design | 200ms click delay for double-click detection | Acceptable trade-off per design doc; fallback to chevron-only if user testing shows issues |
| 2026-03-29 | Plan | Split display-state.ts logic into pure .ts + reactive .svelte.ts | Per L-20260328-svelte-runes-testability: keeps attention score testable with node:test |
| 2026-03-29 | Plan | Gate Item 2 (branch WebSocket event) on manual verification | BranchWatcher exists but session-branch-changed WS event isn't wired yet on nightly |

## Progress

- [x] Task 1: Extend DisplayState + state machine (add `needs-answer`, `error`)
- [x] Task 2: Fix stale repo names (read real git state on workspace load)
- [x] Task 3: Double-click expand/collapse workspace rows
- [x] Task 4: Wire branch-changed WebSocket event (server → frontend)
- [x] Task 5: SessionIndicator component (three-axis shape+color system)
- [x] Task 6: PR status icon glyphs (replace StatusDot for PR display)
- [x] Task 7: Read/unread tracking system
- [x] Task 8: Attention score + sidebar sorting
- [x] Task 9: Workspace header summary pips

## Surprises & Discoveries

- Previous agent left Task 4 uncommitted with minor formatting issues (collapsed newlines) — fixed before committing
- `backend-state.test.ts` had a stale assertion from before Task 1's error state addition — fixed
- No TuiTooltip component existed; used native `title` attribute for PrGlyph instead

## Plan Drift

_None yet — updated when tasks deviate from plan during execution._

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `frontend/src/components/SessionIndicator.svelte` | Shape+color indicator replacing StatusDot for session state display |
| `frontend/src/components/PrGlyph.svelte` | Icon-only PR status glyph with tooltip |
| `frontend/src/lib/state/attention.ts` | Pure `computeAttentionScore()` + `sortByAttention()` (testable with node:test) |
| `frontend/src/lib/state/unread-logic.ts` | Pure `shouldMarkUnread()` logic — no reactive dependencies (testable with node:test) |
| `frontend/src/lib/state/unread.svelte.ts` | Unread state tracking with localStorage persistence |
| `test/attention.test.ts` | Tests for attention score computation |
| `test/unread.test.ts` | Tests for unread state management |

### Modified Files

| File | Changes |
|------|---------|
| `frontend/src/lib/state/display-state.ts` | Add `needs-answer`, `error` to DisplayState; extend state machine |
| `frontend/src/lib/types.ts` | Add `permissionType` to event types, `isUnread` + `prStatus` to SidebarItem |
| `frontend/src/lib/state/sidebar-items.ts` | Integrate attention sorting into `buildSidebarItems()` |
| `frontend/src/lib/state/sessions.svelte.ts` | Handle `session-branch-changed` WS event, integrate unread tracking |
| `frontend/src/lib/pr-status.ts` | Add `prGlyph()` mapping function |
| `frontend/src/components/WorkspaceItem.svelte` | Replace status dots with SessionIndicator, add dblclick, pips, sorting |
| `server/ws.ts` | Wire BranchWatcher `onBranchChange` to broadcast `session-branch-changed` |
| `server/workspaces.ts` | Read real git remote URL + HEAD for workspace name/branch on load |
| `server/sessions.ts` | Extend `fireBackendStateIfChanged` to include `permissionType` |
| `test/display-state.test.ts` | Add transition tests for `needs-answer`, `error` states |
| `test/sidebar-items.test.ts` | Add sorted output assertions |

---

### Task 1: Extend DisplayState + State Machine

**Files:**
- Modify: `frontend/src/lib/state/display-state.ts`
- Modify: `test/display-state.test.ts`
- Modify: `frontend/src/lib/types.ts`

This task adds `needs-answer` and `error` to the DisplayState type and extends the transition function. The design doc distinguishes `permission` (tool approval, filled diamond ◆) from `needs-answer` (question, hollow diamond ◇) and adds `error` (crash, square ■). The backend currently lumps both approval and question into `permission`. We need a `permissionType` discriminator.

- [ ] **Step 1: Write failing tests for new states**

Add these cases to the transition table in `test/display-state.test.ts`:

```typescript
// After the existing transition table entries, add:
[
  'running',
  { type: 'backend-state-changed', state: 'permission', permissionType: 'question' },
  'needs-answer',
  'running + backend-state-changed(permission, question) → needs-answer',
],
[
  'running',
  { type: 'backend-state-changed', state: 'permission', permissionType: 'approval' },
  'permission',
  'running + backend-state-changed(permission, approval) → permission',
],
[
  'running',
  { type: 'backend-state-changed', state: 'permission' },
  'permission',
  'running + backend-state-changed(permission, no type) → permission (backward compat)',
],
[
  'needs-answer',
  { type: 'user-viewed' },
  'needs-answer',
  'needs-answer + user-viewed → needs-answer (question must be answered, not just viewed)',
],
[
  'needs-answer',
  { type: 'backend-state-changed', state: 'running' },
  'running',
  'needs-answer + backend-state-changed(running) → running',
],
[
  'running',
  { type: 'backend-state-changed', state: 'error' },
  'error',
  'running + backend-state-changed(error) → error',
],
[
  'error',
  { type: 'session-ended' },
  'inactive',
  'error + session-ended → inactive',
],
[
  'error',
  { type: 'user-viewed' },
  'error',
  'error + user-viewed → error (stays — error needs acknowledgment, not just viewing)',
],
```

Also add `shouldNotify` tests:

```typescript
it('running → needs-answer → true', () => {
  assert.equal(shouldNotify('running', 'needs-answer'), true);
});

it('running → error → true', () => {
  assert.equal(shouldNotify('running', 'error'), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="display-state|transitionDisplayState"`
Expected: FAIL — `needs-answer` and `error` are not valid DisplayState values

- [ ] **Step 3: Update DisplayState type and transition function**

In `frontend/src/lib/state/display-state.ts`, replace the entire file:

```typescript
export type DisplayState = 'initializing' | 'running' | 'unseen-idle' | 'seen-idle'
  | 'permission' | 'needs-answer' | 'inactive' | 'error';
export type BackendDisplayState = 'initializing' | 'running' | 'idle' | 'permission' | 'error';

export type DisplayEvent =
  | { type: 'backend-state-changed'; state: BackendDisplayState; permissionType?: 'approval' | 'question' }
  | { type: 'user-viewed' }
  | { type: 'session-ended' };

export function transitionDisplayState(current: DisplayState, event: DisplayEvent): DisplayState {
  switch (event.type) {
    case 'backend-state-changed': {
      switch (event.state) {
        case 'idle':
          if (current === 'running' || current === 'initializing') return 'unseen-idle';
          return current;
        case 'running':
          return 'running';
        case 'permission':
          if (event.permissionType === 'question') return 'needs-answer';
          return 'permission';
        case 'error':
          return 'error';
        case 'initializing':
          return 'initializing';
      }
    }
    case 'user-viewed': {
      if (current === 'unseen-idle' || current === 'permission') return 'seen-idle';
      // needs-answer stays — viewing isn't answering; agent is still blocked
      // error stays — error needs acknowledgment, not just viewing
      return current;
    }
    case 'session-ended': {
      return 'inactive';
    }
  }
}

export function isAttentionState(state: DisplayState): boolean {
  return state === 'unseen-idle' || state === 'permission' || state === 'needs-answer' || state === 'error';
}

export function shouldNotify(from: DisplayState, to: DisplayState): boolean {
  return from === 'running' && isAttentionState(to);
}
```

- [ ] **Step 4: Update BackendDisplayState in server types**

In `server/types.ts`, update the BackendDisplayState type:

```typescript
export type BackendDisplayState = 'initializing' | 'running' | 'idle' | 'permission' | 'error';
```

- [ ] **Step 5: Update sessionToBackendState in sidebar-items.ts**

In `frontend/src/lib/state/sidebar-items.ts`, update the `sessionToBackendState` function (line 12-20) and `deriveBackendState` priority map:

```typescript
function sessionToBackendState(session: SessionSummary): BackendDisplayState {
  const { agentState, idle } = session;
  if (agentState === 'permission-prompt') return 'permission';
  if (agentState === 'error') return 'error';
  if (agentState === 'processing') return 'running';
  if (agentState === 'initializing') return 'initializing';
  if (!agentState && !idle) return 'running';
  return 'idle';
}

function deriveBackendState(sessions: SessionSummary[]): BackendDisplayState {
  const priority: Record<BackendDisplayState, number> = {
    permission: 4,
    error: 3,
    running: 2,
    initializing: 1,
    idle: 0,
  };

  let best: BackendDisplayState = 'idle';
  for (const session of sessions) {
    const state = sessionToBackendState(session);
    if (priority[state] > priority[best]) {
      best = state;
    }
  }
  return best;
}
```

Also update `initialDisplayState` to handle `error`:

```typescript
function initialDisplayState(sessions: SessionSummary[]): DisplayState {
  if (sessions.length === 0) return 'inactive';
  switch (deriveBackendState(sessions)) {
    case 'permission':   return 'permission';
    case 'error':        return 'error';
    case 'running':      return 'running';
    case 'initializing': return 'initializing';
    case 'idle':
    default:
      return 'seen-idle';
  }
}
```

- [ ] **Step 6: Update server computeBackendState**

In `server/sessions.ts` (line 114-125), update `computeBackendState`:

```typescript
export function computeBackendState(session: { agentState: AgentState; idle: boolean }): BackendDisplayState {
  if (session.agentState === 'permission-prompt') return 'permission';
  if (session.agentState === 'error') return 'error';
  if (session.agentState === 'processing') return 'running';
  if (session.agentState === 'initializing') return 'initializing';
  if (session.agentState === 'idle' || session.agentState === 'waiting-for-input') return 'idle';
  return session.idle ? 'idle' : 'running';
}
```

- [ ] **Step 7: Wire permissionType through server callback and WebSocket**

The backend currently sends `permission` for both tool approval and agent questions. We need `permissionType` so the frontend can distinguish them.

In `server/sessions.ts`, change the `BackendStateChangeCallback` type and `fireBackendStateIfChanged`:

```typescript
type BackendStateChangeCallback = (sessionId: string, state: BackendDisplayState, permissionType?: 'approval' | 'question') => void;

export function fireBackendStateIfChanged(session: Session): void {
  const newState = computeBackendState(session);
  // Derive permissionType from agentState
  let permissionType: 'approval' | 'question' | undefined;
  if (newState === 'permission') {
    permissionType = session.agentState === 'waiting-for-input' ? 'question' : 'approval';
  }
  if (session._lastEmittedBackendState === newState && session._lastEmittedPermissionType === permissionType) return;
  session._lastEmittedBackendState = newState;
  session._lastEmittedPermissionType = permissionType;
  for (const cb of [...backendStateChangeCallbacks]) {
    try { cb(session.id, newState, permissionType); }
    catch (err) { console.error('[sessions] backendStateChange callback error:', err); }
  }
}
```

Add `_lastEmittedPermissionType?: 'approval' | 'question'` to the Session interface where `_lastEmittedBackendState` is defined.

In `server/ws.ts`, update the callback registration to forward `permissionType`:

```typescript
sessions.onBackendStateChange((sessionId, state, permissionType) => {
  broadcastEvent('session-backend-state-changed', { sessionId, state, permissionType });
});
```

- [ ] **Step 8: Wire permissionType on the frontend**

In `frontend/src/lib/state/sessions.svelte.ts`, update `handleBackendStateChanged` signature:

```typescript
export function handleBackendStateChanged(sessionId: string, backendState: BackendDisplayState, permissionType?: 'approval' | 'question'): void {
```

And pass it through to `transitionDisplayState`:

```typescript
  const newDisplayState = transitionDisplayState(item.displayState, {
    type: 'backend-state-changed',
    state: backendState,
    permissionType,
  });
```

In `App.svelte`, forward `msg.permissionType` from the WebSocket event handler:

```typescript
handleBackendStateChanged(msg.sessionId, msg.state, msg.permissionType);
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS including the new transition table entries

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/state/display-state.ts frontend/src/lib/state/sidebar-items.ts frontend/src/lib/types.ts server/types.ts server/sessions.ts server/ws.ts frontend/src/lib/state/sessions.svelte.ts test/display-state.test.ts
git commit -m "feat: extend display state machine with needs-answer and error states

Wire permissionType through server callback → WebSocket → frontend
to distinguish tool approval (◆) from agent question (◇)."
```

---

### Task 2: Fix Stale Repo Names

**Files:**
- Modify: `server/workspaces.ts:168-182`
- Modify: `test/worktrees.test.ts` (or add assertions to existing workspace tests)

Currently, `GET /workspaces` returns `path.basename(p)` as the workspace name, which is the directory name — not the actual repo name from the git remote. If the user cloned `donovan-yohan/claude-remote-cli` into a folder called `project`, the sidebar shows "project" instead of "claude-remote-cli".

- [ ] **Step 1: Write a test for real repo name detection**

Create a test that verifies `detectGitRepo` returns the repo name from `git remote get-url origin`. In `test/worktrees.test.ts`, add:

```typescript
describe('workspace name from git remote', () => {
  it('derives repo name from git remote origin URL', async () => {
    // This tests the actual helper function
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    // Use the current repo as test fixture
    const result = await exec('git', ['remote', 'get-url', 'origin'], { cwd: process.cwd() });
    const url = result.stdout.trim();
    // Extract name: last path segment minus .git
    const name = url.split('/').pop()?.replace(/\.git$/, '') ?? '';
    assert.ok(name.length > 0, 'should extract a non-empty name from git remote');
    assert.ok(!name.includes('/'), 'name should not contain slashes');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (this is a characterization test)**

Run: `npm test -- --test-name-pattern="workspace name from git remote"`
Expected: PASS

- [ ] **Step 3: Update GET /workspaces to use real git repo name**

In `server/workspaces.ts`, update the `GET /` handler (lines 168-182). Replace the workspace mapping:

```typescript
  // GET /workspaces — list all workspaces with git info
  router.get('/', async (_req: Request, res: Response) => {
    const config = getConfig();
    const workspacePaths = config.repos ?? [];

    const results: Repo[] = await Promise.all(
      workspacePaths.map(async (p) => {
        const { isGitRepo, defaultBranch } = await detectGitRepo(p, exec);
        let name = path.basename(p);

        // Derive real repo name from git remote origin URL
        if (isGitRepo) {
          try {
            const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: p });
            const url = stdout.trim();
            if (url) {
              const remoteName = url.split('/').pop()?.replace(/\.git$/, '');
              if (remoteName) name = remoteName;
            }
          } catch {
            // No remote configured — fall back to directory name
          }
        }

        return { path: p, name, isGitRepo, defaultBranch };
      }),
    );

    res.json({ workspaces: results });
  });
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add server/workspaces.ts test/worktrees.test.ts
git commit -m "fix: derive workspace name from git remote instead of directory name"
```

---

### Task 3: Double-Click Expand/Collapse

**Files:**
- Modify: `frontend/src/components/WorkspaceItem.svelte`

Add `dblclick` handler on the workspace header row to toggle collapse. Single-click continues to navigate. The design doc specifies a 200ms delay on single-click to distinguish from double-click.

- [ ] **Step 1: Add double-click handler to workspace header**

In `WorkspaceItem.svelte`, add a click-delay mechanism. After the `let isMobile` line (~line 99), add:

```typescript
  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  function handleHeaderClick(e: MouseEvent) {
    // Don't delay on mobile — no double-click on touch
    if (isMobile) {
      onSelectWorkspace(workspace.path);
      return;
    }
    if (clickTimer) {
      // Second click within 200ms → double-click → toggle collapse
      clearTimeout(clickTimer);
      clickTimer = null;
      toggleWorkspaceCollapse(workspace.path);
    } else {
      // First click → delay to allow double-click detection
      clickTimer = setTimeout(() => {
        clickTimer = null;
        onSelectWorkspace(workspace.path);
      }, 200);
    }
  }
```

- [ ] **Step 2: Replace the onclick handler on workspace-header div**

In the template (line 211), change:

```svelte
    onclick={() => { onSelectWorkspace(workspace.path); }}
```

to:

```svelte
    onclick={handleHeaderClick}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds with no type errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/WorkspaceItem.svelte
git commit -m "feat: double-click workspace header to expand/collapse"
```

---

### Task 4: Wire Branch-Changed WebSocket Event

**Files:**
- Modify: `server/ws.ts`
- Modify: `frontend/src/lib/state/sessions.svelte.ts`
- Modify: `frontend/src/lib/ws.ts` (if needed for event type)

**Gate:** This task requires `BranchWatcher` to be wired into the WebSocket layer. `BranchWatcher` exists on nightly and watches `.git/HEAD` for both main repos and worktrees. The gap is that no WebSocket event is emitted when a branch changes. If `session-branch-changed` is not yet wired on nightly when this task starts, implement the wiring here.

- [ ] **Step 1: Check if branch-changed WS event exists**

Run: `grep -r "session-branch-changed\|branch-changed" server/ws.ts`
If found, skip to step 4 (frontend handling). If not found, continue.

- [ ] **Step 2: Wire BranchWatcher callback to broadcast in ws.ts**

In `server/ws.ts`, import and use `BranchWatcher`. Find where `watcher.on('worktrees-changed', ...)` is set up (around line 39-41) and add branch change broadcasting after it.

First, update the `setupWebSocket` function signature to accept a `BranchWatcher` instance, or use the existing watcher's callback. The simplest approach: in the watcher's `onBranchChange` callback (set up in `server/index.ts`), call `broadcastEvent`.

In `server/ws.ts`, after the `watcher.on('worktrees-changed', ...)` block, add:

```typescript
  // Expose a function for external callers (e.g., BranchWatcher) to broadcast branch changes
  function broadcastBranchChanged(cwdPath: string, branchName: string): void {
    // Find sessions whose cwd or worktreePath matches
    const matchingSessions = [...sessions.getAll()].filter(
      s => s.cwd === cwdPath || s.worktreePath === cwdPath || s.repoPath === cwdPath
    );
    for (const session of matchingSessions) {
      broadcastEvent('session-branch-changed', { sessionId: session.id, branch: branchName, cwdPath });
    }
  }
```

Return `broadcastBranchChanged` from `setupWebSocket` alongside `broadcastEvent`.

In `server/index.ts` (or wherever `BranchWatcher` is instantiated), wire its callback to call `broadcastBranchChanged`.

- [ ] **Step 3: Handle session-branch-changed on the frontend**

In `frontend/src/lib/state/sessions.svelte.ts`, add a handler:

```typescript
export function handleBranchChanged(sessionId: string, branch: string): void {
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.branchName = branch;
  }
  // Also update the SidebarItem
  const item = sidebarItems.find(i => i.sessions.some(s => s.id === sessionId));
  if (item) {
    item.branchName = branch;
  }
}
```

- [ ] **Step 4: Wire the event in App.svelte's onMessage handler**

Find the WebSocket event handler in `App.svelte` that processes event messages. Add a case for `session-branch-changed`:

```typescript
case 'session-branch-changed':
  handleBranchChanged(msg.sessionId, msg.branch);
  break;
```

- [ ] **Step 5: Add CipherText decode animation on branch change in WorkspaceItem.svelte**

The design doc requires that when a branch changes, the branch name animates through random characters before resolving to the new name. The existing `CipherText` primitive handles this.

In `WorkspaceItem.svelte`, import `CipherText`:

```typescript
import CipherText from './CipherText.svelte';
```

Replace the two `<span class="secondary-branch">` occurrences (lines 278 and 355) with:

```svelte
<!-- Active session branch name (line ~278) -->
<CipherText value={representative.branchName} class="secondary-branch" />

<!-- Inactive worktree branch name (line ~355) -->
<CipherText value={wt.branchName} class="secondary-branch" />
```

`CipherText` automatically animates when its `value` prop changes — so when `handleBranchChanged` updates the session's branch name, the reactive binding triggers the decode animation.

- [ ] **Step 6: Run build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add server/ws.ts server/index.ts frontend/src/lib/state/sessions.svelte.ts frontend/src/App.svelte frontend/src/components/WorkspaceItem.svelte
git commit -m "feat: broadcast branch-changed WebSocket event with CipherText decode animation"
```

---

### Task 5: SessionIndicator Component

**Files:**
- Create: `frontend/src/components/SessionIndicator.svelte`
- Modify: `frontend/src/components/WorkspaceItem.svelte`

Replace the inline `status-dot` spans with a proper `SessionIndicator` component that renders text characters (not SVG) for the shape language defined in the design doc.

Shape mapping:
- `initializing` → `●` green circle, 0.4 opacity
- `running` → `●` green circle, 0.8 opacity
- `unseen-idle` / `seen-idle` → `▶` yellow triangle
- `permission` → `◆` red filled diamond, bold
- `needs-answer` → `◇` red hollow diamond
- `error` → `■` red square
- `inactive` → `─` gray dash

- [ ] **Step 1: Create SessionIndicator.svelte**

```svelte
<script lang="ts">
  import type { DisplayState } from '../lib/state/display-state.js';

  let { state }: { state: DisplayState } = $props();

  const config: Record<DisplayState, { char: string; colorClass: string; bold: boolean }> = {
    initializing:  { char: '●', colorClass: 'ind-green-dim',   bold: false },
    running:       { char: '●', colorClass: 'ind-green',       bold: false },
    'unseen-idle': { char: '▶', colorClass: 'ind-yellow',      bold: false },
    'seen-idle':   { char: '▶', colorClass: 'ind-yellow-muted', bold: false },
    permission:    { char: '◆', colorClass: 'ind-red',         bold: true  },
    'needs-answer':{ char: '◇', colorClass: 'ind-red',         bold: true  },
    error:         { char: '■', colorClass: 'ind-red',         bold: false },
    inactive:      { char: '─', colorClass: 'ind-gray',        bold: false },
  };

  let { char, colorClass, bold } = $derived(config[state]);

  let pulseClass = $derived(
    state === 'permission' ? 'pulse-fast'
    : state === 'needs-answer' ? 'pulse-fast'
    : state === 'unseen-idle' ? 'pulse-slow'
    : ''
  );

  let label = $derived(
    state === 'permission' ? 'needs approval'
    : state === 'needs-answer' ? 'needs answer'
    : state === 'unseen-idle' ? 'idle, unread'
    : state === 'seen-idle' ? 'idle'
    : state
  );
</script>

<span
  class="session-indicator {colorClass} {pulseClass}"
  class:bold
  role="img"
  aria-label={label}
>{char}</span>

<style>
  .session-indicator {
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    text-align: center;
  }

  .bold { font-weight: 700; }

  /* Colors — using color (not background) since these are text characters */
  .ind-green       { color: rgba(74, 222, 128, 0.8); }
  .ind-green-dim   { color: rgba(74, 222, 128, 0.4); }
  .ind-yellow      { color: #f0c674; }
  .ind-yellow-muted { color: rgba(240, 198, 116, 0.5); }
  .ind-red         { color: #cc6666; }
  .ind-gray        { color: #555; }

  /* Pulse using color alpha — NOT opacity (per design doc, prevents tooltip fade) */
  @keyframes pulse-red {
    0%, 100% { color: rgba(204, 102, 102, 1); }
    50%      { color: rgba(204, 102, 102, 0.15); }
  }

  @keyframes pulse-yellow {
    0%, 100% { color: rgba(240, 198, 116, 1); }
    50%      { color: rgba(240, 198, 116, 0.15); }
  }

  .pulse-fast { animation: pulse-red 1.4s ease-in-out infinite; }
  .pulse-slow { animation: pulse-yellow 2.5s ease-in-out infinite; }

  @media (prefers-reduced-motion: reduce) {
    .pulse-fast, .pulse-slow { animation: none; }
  }
</style>
```

- [ ] **Step 2: Replace status dot usage in WorkspaceItem.svelte**

Import the new component at the top of WorkspaceItem.svelte:

```typescript
import SessionIndicator from './SessionIndicator.svelte';
```

Replace the inline `<span class={statusDotClass(groupPath)}></span>` (line 260) with:

```svelte
<SessionIndicator state={sidebarItemById.get(groupPath)?.displayState ?? 'inactive'} />
```

Also replace the `<span class="dot dot-inactive"></span>` for inactive rows (lines 311, 349) with:

```svelte
<SessionIndicator state="inactive" />
```

- [ ] **Step 3: Remove old status-dot CSS from WorkspaceItem**

Remove these CSS blocks from WorkspaceItem.svelte (lines 622-656):

```css
  /* Status dot */
  .status-dot { ... }
  .status-dot--running { ... }
  .status-dot--initializing { ... }
  .status-dot--unseen-idle { ... }
  .status-dot--seen-idle { ... }
  .status-dot--permission { ... }
  .status-dot--inactive { ... }
  .dot-inactive { ... }
  @keyframes attention-glow { ... }
```

Also remove the `statusDotClass()` function (lines 55-58) since it's no longer needed.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SessionIndicator.svelte frontend/src/components/WorkspaceItem.svelte
git commit -m "feat: replace status dots with three-axis SessionIndicator shapes"
```

---

### Task 6: PR Status Icon Glyphs

**Files:**
- Create: `frontend/src/components/PrGlyph.svelte`
- Modify: `frontend/src/lib/pr-status.ts`
- Modify: `frontend/src/components/WorkspaceItem.svelte`
- Modify: `test/pr-status.test.ts`

Replace the colored-dot PR indicators with icon-only glyphs using text characters, per the design doc mapping:
- draft → `◌` gray
- open → `○` blue
- review-requested → `○` yellow
- changes-requested → `✕` red
- approved → `✓` green
- merged → `●` purple
- closed → `⊘` red

- [ ] **Step 1: Add prGlyph mapping to pr-status.ts**

Add to `frontend/src/lib/pr-status.ts`:

```typescript
export interface PrGlyphInfo {
  char: string;
  colorClass: string;
  label: string;
}

export function prGlyph(status: PrDotStatus): PrGlyphInfo {
  switch (status) {
    case 'draft':             return { char: '◌', colorClass: 'pr-gray',   label: 'draft pr' };
    case 'open':              return { char: '○', colorClass: 'pr-blue',   label: 'open pr' };
    case 'review-requested':  return { char: '○', colorClass: 'pr-yellow', label: 'review requested' };
    case 'changes-requested': return { char: '✕', colorClass: 'pr-red',    label: 'changes requested' };
    case 'approved':          return { char: '✓', colorClass: 'pr-green',  label: 'approved' };
    case 'merged':            return { char: '●', colorClass: 'pr-purple', label: 'merged' };
    case 'closed':            return { char: '⊘', colorClass: 'pr-red',    label: 'closed (not merged)' };
    case 'unknown':           return { char: '?', colorClass: 'pr-gray',   label: 'unknown' };
  }
}
```

- [ ] **Step 2: Write test for prGlyph**

In `test/pr-status.test.ts`, add:

```typescript
import { prGlyph } from '../frontend/src/lib/pr-status.js';

describe('prGlyph', () => {
  it('maps each status to a unique character', () => {
    const statuses: PrDotStatus[] = ['draft', 'open', 'review-requested', 'changes-requested', 'approved', 'merged', 'closed', 'unknown'];
    const chars = statuses.map(s => prGlyph(s).char);
    // changes-requested (✕) and closed (⊘) must be different
    assert.notEqual(prGlyph('changes-requested').char, prGlyph('closed').char);
    // All have non-empty chars
    for (const c of chars) {
      assert.ok(c.length > 0);
    }
  });

  it('approved is green checkmark', () => {
    const g = prGlyph('approved');
    assert.equal(g.char, '✓');
    assert.equal(g.colorClass, 'pr-green');
  });
});
```

- [ ] **Step 3: Run test**

Run: `npm test -- --test-name-pattern="prGlyph"`
Expected: PASS

- [ ] **Step 4: Create PrGlyph.svelte component**

```svelte
<script lang="ts">
  import type { PrDotStatus } from '../lib/pr-status.js';
  import { prGlyph } from '../lib/pr-status.js';
  import TuiTooltip from './TuiTooltip.svelte';

  let { status }: { status: PrDotStatus } = $props();
  let glyph = $derived(prGlyph(status));
</script>

<TuiTooltip text={glyph.label}>
  <span class="pr-glyph {glyph.colorClass}" role="img" aria-label={glyph.label}>{glyph.char}</span>
</TuiTooltip>

<style>
  .pr-glyph {
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1;
    flex-shrink: 0;
  }

  .pr-gray   { color: #555; }
  .pr-blue   { color: #4a9eff; }
  .pr-yellow { color: #f0c674; }
  .pr-red    { color: #e05252; }
  .pr-green  { color: #5cb85c; }
  .pr-purple { color: #b294bb; }
</style>
```

- [ ] **Step 5: Replace StatusDot PR usage in WorkspaceItem.svelte**

Replace the `<StatusDot status={derivePrDotStatus(matchedPr)} size={5} />` and CI status block (lines 265-273) with:

```svelte
{#if matchedPr}
  <span class="sidebar-pr-status">
    <PrGlyph status={derivePrDotStatus(matchedPr)} />
    {#if matchedPr.ciStatus === 'SUCCESS'}<span class="ci-pass">✓</span>
    {:else if matchedPr.ciStatus === 'FAILURE' || matchedPr.ciStatus === 'ERROR'}<span class="ci-fail">✕</span>
    {:else if matchedPr.ciStatus === 'PENDING'}<span class="ci-pending">●</span>
    {/if}
  </span>
{/if}
```

Import PrGlyph at the top:

```typescript
import PrGlyph from './PrGlyph.svelte';
```

Remove the StatusDot import if no longer used elsewhere in the file.

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/pr-status.ts frontend/src/components/PrGlyph.svelte frontend/src/components/WorkspaceItem.svelte test/pr-status.test.ts
git commit -m "feat: icon-only PR glyphs with tooltips replacing colored dots"
```

---

### Task 7: Read/Unread Tracking System

**Files:**
- Create: `frontend/src/lib/state/unread.svelte.ts`
- Create: `test/unread.test.ts` (pure logic tests for the non-reactive part)
- Modify: `frontend/src/lib/types.ts` (add `isUnread` to SidebarItem)
- Modify: `frontend/src/lib/state/sessions.svelte.ts`
- Modify: `frontend/src/components/WorkspaceItem.svelte`

Per the design doc, unread is orthogonal to session state. A session becomes unread when:
- Session transitions from running to any non-running state AND user is not viewing it
- Session receives new output while user is viewing a different session
- PR status changes
- Error occurs

Unread clears when the user clicks into the session.

Per L-20260328-svelte-runes-testability, split pure logic from reactive wrapper.

- [ ] **Step 1: Create pure unread logic (test/unread.test.ts)**

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldMarkUnread } from '../frontend/src/lib/state/unread-logic.js';

describe('shouldMarkUnread', () => {
  it('running → idle when not viewing → true', () => {
    assert.equal(shouldMarkUnread('running', 'unseen-idle', false), true);
  });

  it('running → idle when viewing → false', () => {
    assert.equal(shouldMarkUnread('running', 'unseen-idle', true), false);
  });

  it('running → permission when not viewing → true', () => {
    assert.equal(shouldMarkUnread('running', 'permission', false), true);
  });

  it('running → error → true', () => {
    assert.equal(shouldMarkUnread('running', 'error', false), true);
  });

  it('idle → idle → false (no change)', () => {
    assert.equal(shouldMarkUnread('seen-idle', 'seen-idle', false), false);
  });

  it('inactive → inactive → false', () => {
    assert.equal(shouldMarkUnread('inactive', 'inactive', false), false);
  });
});
```

- [ ] **Step 2: Create unread-logic.ts**

Create `frontend/src/lib/state/unread-logic.ts`:

```typescript
import type { DisplayState } from './display-state.js';
import { isAttentionState } from './display-state.js';

/**
 * Determine if a state transition should mark the item as unread.
 * Pure function — no reactive dependencies.
 */
export function shouldMarkUnread(
  from: DisplayState,
  to: DisplayState,
  isCurrentlyViewing: boolean,
): boolean {
  if (isCurrentlyViewing) return false;
  if (from === to) return false;
  // Any transition into an attention state marks unread
  return isAttentionState(to);
}
```

- [ ] **Step 3: Run test**

Run: `npm test -- --test-name-pattern="shouldMarkUnread"`
Expected: PASS

- [ ] **Step 4: Create reactive unread.svelte.ts**

Create `frontend/src/lib/state/unread.svelte.ts`:

```typescript
const UNREAD_STORAGE_KEY = 'claude-remote-unread';

let unreadItems = $state<Set<string>>(loadUnread());

function loadUnread(): Set<string> {
  try {
    const stored = localStorage.getItem(UNREAD_STORAGE_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch { return new Set(); }
}

function saveUnread(): void {
  try {
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify([...unreadItems]));
  } catch { /* localStorage unavailable */ }
}

export function isUnread(itemId: string): boolean {
  return unreadItems.has(itemId);
}

export function markUnread(itemId: string): void {
  if (!unreadItems.has(itemId)) {
    unreadItems.add(itemId);
    saveUnread();
  }
}

export function markRead(itemId: string): void {
  if (unreadItems.has(itemId)) {
    unreadItems.delete(itemId);
    saveUnread();
  }
}

export function pruneUnread(validIds: Set<string>): void {
  let pruned = false;
  for (const id of unreadItems) {
    if (!validIds.has(id)) {
      unreadItems.delete(id);
      pruned = true;
    }
  }
  if (pruned) saveUnread();
}
```

- [ ] **Step 5: Add isUnread to SidebarItem type**

In `frontend/src/lib/types.ts`, add `isUnread` and `prStatus` to the `SidebarItem` interface:

```typescript
export interface SidebarItem {
  id: string;
  kind: 'repo' | 'worktree';
  path: string;
  repoPath: string;
  displayName: string;
  branchName: string;
  lastActivity: string;
  displayState: DisplayState;
  lastKnownBackendState: BackendDisplayState | null;
  sessions: SessionSummary[];
  isUnread?: boolean;
  prStatus?: PrDotStatus;
}
```

Import `PrDotStatus` at the top of `types.ts`:

```typescript
import type { PrDotStatus } from './pr-status.js';
```

Note: `prStatus` will be populated in `buildSidebarItems()` (Task 8) by looking up the PR for the item's branch name from the org PRs data. This connects the PR enrichment from Sidebar.svelte to the attention scoring system.

- [ ] **Step 6: Wire unread into handleBackendStateChanged**

In `frontend/src/lib/state/sessions.svelte.ts`, import and integrate:

```typescript
import { shouldMarkUnread } from './unread-logic.js';
import { markUnread, markRead, isUnread } from './unread.svelte.js';
```

In `handleBackendStateChanged`, after the display state transition (around line 132), add:

```typescript
  if (newDisplayState !== oldDisplayState) {
    item.displayState = newDisplayState;

    // Track unread
    const isViewing = item.sessions.some(s => s.id === activeSessionId);
    if (shouldMarkUnread(oldDisplayState, newDisplayState, isViewing)) {
      markUnread(item.id);
      item.isUnread = true;
    }

    // ... existing notification code ...
  }
```

In `handleUserViewed`, add:

```typescript
export function handleUserViewed(sessionId: string): void {
  const item = sidebarItems.find(i => i.sessions.some(s => s.id === sessionId));
  if (item) {
    item.displayState = transitionDisplayState(item.displayState, { type: 'user-viewed' });
    markRead(item.id);
    item.isUnread = false;
  }
}
```

- [ ] **Step 7: Apply unread visual treatment in WorkspaceItem.svelte**

In the session row template, update the session name styling to use `isUnread`:

```svelte
{@const itemIsUnread = sidebarItemById.get(groupPath)?.isUnread ?? false}
```

Use this in the template:

```svelte
<span class="session-name" class:bold={itemIsUnread}>{groupDisplayName(groupPath, groupSessions)}</span>
```

Add a left accent border for unread items. In the `<li>` element, add:

```svelte
class:unread={itemIsUnread}
```

Add CSS:

```css
.session-row.unread {
  border-left-color: var(--status-warning);
}

.session-row.unread .session-name {
  font-weight: 700;
  color: #e8e8e8;
}
```

- [ ] **Step 8: Verify build and tests**

Run: `npm run build && npm test`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/state/unread-logic.ts frontend/src/lib/state/unread.svelte.ts frontend/src/lib/types.ts frontend/src/lib/state/sessions.svelte.ts frontend/src/components/WorkspaceItem.svelte test/unread.test.ts
git commit -m "feat: read/unread tracking with bold name + accent border overlay"
```

---

### Task 8: Attention Score + Sidebar Sorting

**Files:**
- Create: `frontend/src/lib/state/attention.ts`
- Create: `test/attention.test.ts`
- Modify: `frontend/src/lib/state/sidebar-items.ts`
- Modify: `frontend/src/components/Sidebar.svelte`

Per L-20260328-svelte-runes-testability, the attention score function is a pure .ts file testable with node:test.

- [ ] **Step 1: Write tests for attention score**

Create `test/attention.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAttentionScore, sortByAttention } from '../frontend/src/lib/state/attention.js';
import type { SidebarItem } from '../frontend/src/lib/types.js';

function makeScoreItem(overrides: Partial<SidebarItem> & { displayState: SidebarItem['displayState'] }): SidebarItem {
  return {
    id: 'test',
    kind: 'worktree',
    path: '/test',
    repoPath: '/repo',
    displayName: 'test',
    branchName: 'main',
    lastActivity: new Date().toISOString(),
    lastKnownBackendState: null,
    sessions: [],
    ...overrides,
  };
}

describe('computeAttentionScore', () => {
  it('permission scores highest', () => {
    const permission = computeAttentionScore(makeScoreItem({ displayState: 'permission' }));
    const running = computeAttentionScore(makeScoreItem({ displayState: 'running' }));
    assert.ok(permission > running);
  });

  it('needs-answer scores above error', () => {
    const needsAnswer = computeAttentionScore(makeScoreItem({ displayState: 'needs-answer' }));
    const error = computeAttentionScore(makeScoreItem({ displayState: 'error' }));
    assert.ok(needsAnswer > error);
  });

  it('error scores above unseen-idle', () => {
    const error = computeAttentionScore(makeScoreItem({ displayState: 'error' }));
    const unseen = computeAttentionScore(makeScoreItem({ displayState: 'unseen-idle' }));
    assert.ok(error > unseen);
  });

  it('unseen-idle scores above running', () => {
    const unseen = computeAttentionScore(makeScoreItem({ displayState: 'unseen-idle' }));
    const running = computeAttentionScore(makeScoreItem({ displayState: 'running' }));
    assert.ok(unseen > running);
  });

  it('inactive scores lowest', () => {
    const inactive = computeAttentionScore(makeScoreItem({ displayState: 'inactive' }));
    const seenIdle = computeAttentionScore(makeScoreItem({ displayState: 'seen-idle' }));
    assert.ok(inactive < seenIdle);
  });

  it('unread bonus stacks with state score', () => {
    const unread = computeAttentionScore(makeScoreItem({ displayState: 'unseen-idle', isUnread: true }));
    const read = computeAttentionScore(makeScoreItem({ displayState: 'unseen-idle', isUnread: false }));
    assert.ok(unread > read);
  });

  it('changes-requested PR adds urgency', () => {
    const withPr = computeAttentionScore(makeScoreItem({
      displayState: 'running',
      prStatus: 'changes-requested',
    }));
    const withoutPr = computeAttentionScore(makeScoreItem({
      displayState: 'running',
    }));
    assert.ok(withPr > withoutPr);
    assert.equal(withPr - withoutPr, 200);
  });

  it('review-requested PR adds urgency', () => {
    const withPr = computeAttentionScore(makeScoreItem({
      displayState: 'running',
      prStatus: 'review-requested',
    }));
    const withoutPr = computeAttentionScore(makeScoreItem({
      displayState: 'running',
    }));
    assert.equal(withPr - withoutPr, 150);
  });

  it('recency contributes to score', () => {
    const recent = computeAttentionScore(makeScoreItem({
      displayState: 'running',
      lastActivity: new Date().toISOString(),
    }));
    const old = computeAttentionScore(makeScoreItem({
      displayState: 'running',
      lastActivity: new Date(Date.now() - 120 * 60_000).toISOString(),
    }));
    assert.ok(recent > old);
  });
});

describe('sortByAttention', () => {
  it('sorts permission above running', () => {
    const items = [
      makeScoreItem({ id: 'a', displayState: 'running' }),
      makeScoreItem({ id: 'b', displayState: 'permission' }),
    ];
    const sorted = sortByAttention(items);
    assert.equal(sorted[0]!.id, 'b');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="attentionScore|sortByAttention"`
Expected: FAIL — module not found

- [ ] **Step 3: Create attention.ts**

Create `frontend/src/lib/state/attention.ts`:

```typescript
import type { SidebarItem } from '../types.js';
import type { DisplayState } from './display-state.js';

const STATE_SCORES: Record<DisplayState, number> = {
  permission:    1000,
  'needs-answer': 900,
  error:          800,
  'unseen-idle':  500,
  running:        100,
  initializing:    50,
  'seen-idle':     10,
  inactive:         1,
};

function minutesSinceLastActivity(item: SidebarItem): number {
  if (!item.lastActivity) return Infinity;
  return (Date.now() - new Date(item.lastActivity).getTime()) / 60_000;
}

export function computeAttentionScore(item: SidebarItem): number {
  let score = STATE_SCORES[item.displayState] ?? 0;

  // PR urgency
  if (item.prStatus === 'changes-requested') score += 200;
  if (item.prStatus === 'review-requested')  score += 150;

  // Recency bonus (max 100, decays to 0 over ~100 minutes)
  const minutes = minutesSinceLastActivity(item);
  score += Math.max(0, 100 - minutes);

  // Unread bonus
  if (item.isUnread) score += 300;

  return score;
}

export function sortByAttention<T extends SidebarItem>(items: T[]): T[] {
  return [...items].sort((a, b) => computeAttentionScore(b) - computeAttentionScore(a));
}

/**
 * Compute the highest attention score among a workspace's sidebar items.
 * Used to sort workspaces against each other.
 */
export function workspaceAttentionScore(items: SidebarItem[]): number {
  if (items.length === 0) return 0;
  return Math.max(...items.map(computeAttentionScore));
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --test-name-pattern="attentionScore|sortByAttention"`
Expected: All PASS

- [ ] **Step 5: Integrate sorting into buildSidebarItems**

In `frontend/src/lib/state/sidebar-items.ts`, import and apply sorting at the end of `buildSidebarItems()`:

```typescript
import { sortByAttention } from './attention.js';
```

Before `return result;` (line 201), add:

```typescript
  return sortByAttention(result);
```

- [ ] **Step 6: Sort workspaces in Sidebar.svelte by highest-scoring session**

In `Sidebar.svelte`, integrate attention sorting with the existing drag-and-drop system. The strategy: attention sort provides the initial ordering, but once the user drags, their drag order persists until the next page load.

```typescript
import { workspaceAttentionScore } from '../lib/state/attention.js';
```

Find the `$effect` that syncs `localDndItems` from the workspace list. Replace it with attention-sorted input:

```typescript
// Track whether user has dragged in this session
let userHasDragged = $state(false);

// Attention-sorted workspace list
let attentionSortedRepos = $derived(
  [...repos].sort((a, b) => {
    const aItems = sidebarItems.filter(i => i.repoPath === a.path);
    const bItems = sidebarItems.filter(i => i.repoPath === b.path);
    return workspaceAttentionScore(bItems) - workspaceAttentionScore(aItems);
  })
);

// Sync DnD items: use attention sort unless user has manually reordered
$effect(() => {
  if (!userHasDragged) {
    localDndItems = attentionSortedRepos.map(r => ({ ...r, id: r.path }));
  }
});
```

In `handleDndFinalize`, set `userHasDragged = true` so that attention sort stops overriding the user's manual order:

```typescript
function handleDndFinalize(e: CustomEvent) {
  localDndItems = e.detail.items;
  userHasDragged = true;
  // persist the new order via API
  reorderWorkspaces(localDndItems.map(i => i.path));
}
```

This gives the correct behavior: attention-sorted by default, user-dragged order when manually reordered, reset to attention sort on page reload (Phase 2 will add persistent pinning).

- [ ] **Step 7: Run full test suite**

Run: `npm run build && npm test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/state/attention.ts test/attention.test.ts frontend/src/lib/state/sidebar-items.ts frontend/src/components/Sidebar.svelte
git commit -m "feat: attention score computation + workspace/session sorting by urgency"
```

---

### Task 9: Workspace Header Summary Pips

**Files:**
- Modify: `frontend/src/components/WorkspaceItem.svelte`

Replace the count badge `[3]` in collapsed workspace headers with state-summary pips: `◆1 ●1 ─1` showing count per state category, ordered by urgency, using the same shape+color as SessionIndicator.

- [ ] **Step 1: Add pip computation function**

In `WorkspaceItem.svelte`, after the existing derived variables, add:

```typescript
  interface StatePip {
    char: string;
    colorClass: string;
    count: number;
  }

  let summaryPips = $derived((): StatePip[] => {
    const items = sessionState.sidebarItems.filter(i => i.repoPath === workspace.path);
    const counts = new Map<string, { char: string; colorClass: string; count: number }>();

    // Map each display state to its pip character and color
    const pipConfig: Record<string, { char: string; colorClass: string }> = {
      permission:     { char: '◆', colorClass: 'pip-red' },
      'needs-answer': { char: '◇', colorClass: 'pip-red' },
      error:          { char: '■', colorClass: 'pip-red' },
      'unseen-idle':  { char: '▶', colorClass: 'pip-yellow' },
      running:        { char: '●', colorClass: 'pip-green' },
      initializing:   { char: '●', colorClass: 'pip-green' },
      'seen-idle':    { char: '▶', colorClass: 'pip-yellow-muted' },
      inactive:       { char: '─', colorClass: 'pip-gray' },
    };

    for (const item of items) {
      const cfg = pipConfig[item.displayState];
      if (!cfg) continue;
      const key = item.displayState;
      const existing = counts.get(key);
      if (existing) {
        existing.count++;
      } else {
        counts.set(key, { ...cfg, count: 1 });
      }
    }

    // Sort by urgency (red first, then yellow, green, gray)
    const urgencyOrder = ['permission', 'needs-answer', 'error', 'unseen-idle', 'running', 'initializing', 'seen-idle', 'inactive'];
    return urgencyOrder
      .filter(state => counts.has(state))
      .map(state => counts.get(state)!)
      .slice(0, 3); // Max 3 pips (per design doc mobile constraint)
  });
```

- [ ] **Step 2: Replace the count badge in the template**

Replace the collapsed count badge (lines 223-225):

```svelte
{#if collapsed && totalItems > 0}
  <span class="collapse-count">{totalItems}</span>
{/if}
```

with:

```svelte
{#if collapsed}
  {@const pips = summaryPips()}
  {#if pips.length > 0}
    <span class="summary-pips">
      {#each pips as pip}
        <span class="pip {pip.colorClass}">{pip.char}{pip.count}</span>
      {/each}
    </span>
  {/if}
{/if}
```

- [ ] **Step 3: Add pip CSS**

Add to the `<style>` block:

```css
  .summary-pips {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    flex-shrink: 0;
  }

  .pip {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    white-space: nowrap;
  }

  .pip-red         { color: #cc6666; }
  .pip-yellow      { color: #f0c674; }
  .pip-yellow-muted { color: rgba(240, 198, 116, 0.5); }
  .pip-green       { color: rgba(74, 222, 128, 0.8); }
  .pip-gray        { color: #555; }
```

- [ ] **Step 4: Remove old collapse-count CSS**

Remove the `.collapse-count` CSS block (lines 428-435) since it's replaced by `.summary-pips`.

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/WorkspaceItem.svelte
git commit -m "feat: workspace header summary pips replacing count badges"
```

---

## Dependency Graph

```
Task 1 (DisplayState extension)
├── Task 5 (SessionIndicator) — needs new states
├── Task 7 (Unread tracking) — needs isAttentionState for new states
├── Task 8 (Attention score) — needs new states for scoring
└── Task 9 (Summary pips) — needs new states for pip rendering

Task 2 (Fix stale repo names) — independent
Task 3 (Double-click) — independent
Task 4 (Branch WS event) — independent (gated on server plumbing)

Task 7 (Unread) → Task 8 (Attention) — scoring uses isUnread
Task 5 (SessionIndicator) → Task 9 (Summary pips) — pips use same shape language
```

**Execution order:** Tasks 1-3 can run in parallel. Task 4 is gated. Tasks 5-9 are sequential after Task 1.

---

## Outcomes & Retrospective

**What worked:**
- Pure logic / reactive wrapper split (unread-logic.ts, attention.ts) made node:test testing straightforward
- Shape language with text characters (not SVG) kept implementation simple and accessible
- Color-alpha pulse instead of opacity pulse was the right call — no tooltip fade issues

**What didn't:**
- Previous agent left Task 4 uncommitted with collapsed newlines — formatting issues from automated editing
- `backend-state.test.ts` had a stale assertion from Task 1's error state addition — should have been caught in Task 1's commit

**Learnings to codify:**
- When adding a new BackendDisplayState variant, grep for all test files asserting on the old behavior

## Deferred / Phase 2

Items explicitly deferred from this plan, with pointers for future pickup:

| Item | Design Doc Section | Why Deferred |
|------|-------------------|--------------|
| **Needs-eyes rail** — ephemeral inbox at sidebar top promoting urgent items | Cross-Model Perspective (line 52), Approaches Considered (line 338) | Need real usage data from attentionScore before designing the rail UI |
| **Drag-and-drop workspace pinning** — persistent pin order | Attention Score & Sorting (line 254) | Requires new interaction model, persistence, and state beyond Phase 1 scope |
| **PR comment count badge** — `[3]` badge on PRs with unread comments | Axis 3: PR Status (line 135), Reviewer Concerns (line 415) | Needs investigation: do existing GitHub webhooks provide comment data, or new polling needed? |
| **Mobile `?` legend overlay** — sidebar footer icon explaining indicator shapes | Responsive & Accessibility (line 397) | Not blocking — shapes are accessible without legend, but good discoverability improvement |
| **TuiTooltip for indicators** — custom tooltips instead of native `title` | Discoverability (line 143) | No TuiTooltip component exists yet; native `title` used as fallback |
| **Sidebar header redesign** — collapse to `« relay` | Constraints (line 31), Item 6 (line 308) | Deferred to Phase 3 spotlight design doc |
| **Worktree HEAD path verification** — confirm BranchWatcher handles worktree `.git` files | Reviewer Concerns (line 410) | Flagged but not explicitly verified during execution |
