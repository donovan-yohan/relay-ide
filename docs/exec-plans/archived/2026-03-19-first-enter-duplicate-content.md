# Fix: First Enter Duplicates/Truncates Input on New Worktree Sessions

> **Status**: Active | **Created**: 2026-03-19 | **Last Updated**: 2026-03-19
> **Bug Analysis**: `docs/bug-analyses/2026-03-19-first-enter-duplicate-content-bug-analysis.md`
> **For Claude:** Use /harness:orchestrate to execute this plan.

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-19 | Root Cause | Confirmed: branch rename interception sends chars to PTY twice, Ctrl+U unreliable in Claude Code TUI | Screenshots show duplication (makalu) and truncation (lhotse) patterns consistent with Ctrl+U failure |
| 2026-03-19 | Fix | Remove passthrough during buffering, send all at once on Enter | Eliminates double-send entirely; no reliance on Ctrl+U behavior |

## Progress

- [ ] Task 1: Remove passthrough echo during branch rename buffering

## Surprises & Discoveries

_None yet._

## Plan Drift

_None yet._

---

### Task 1: Remove passthrough echo during branch rename buffering

**Goal:** The branch rename interception at `server/ws.ts:172-193` sends each character to the PTY during buffering (line 179), then tries to undo with `\x15` (Ctrl+U) on Enter (line 187). Ctrl+U doesn't work in Claude Code's Ink/React TUI. Fix by buffering silently (don't write to PTY until Enter), then sending everything in one shot.

**Files:**
- Modify: `server/ws.ts:176-188`

- [ ] **Step 1: Remove passthrough and Ctrl+U**

In `server/ws.ts`, replace the branch rename interception block (lines 173-192):

Change the no-Enter branch to buffer WITHOUT writing to PTY:
```typescript
if (enterIndex === -1) {
    // Buffer without passthrough — don't echo to PTY
    (ptySession as any)._renameBuffer += str;
    return;
}
```

Change the Enter-detected branch to send without Ctrl+U:
```typescript
// No Ctrl+U needed since nothing was sent to PTY during buffering
ptySession.pty.write(renamePrompt + beforeEnter + afterEnter);
```

- [ ] **Step 2: Build and test**

Run: `npm run build && npm test`

- [ ] **Step 3: Commit**

---

## Outcomes & Retrospective

_Filled by /harness:complete when work is done._
