# Bug Analysis: Delete Worktree Modal Stays Open After Deletion

> **Status**: Confirmed | **Date**: 2026-04-04
> **Severity**: Medium
> **Affected Area**: frontend/src/components/dialogs/DeleteWorktreeDialog.tsx
> **Linear**: DYS-59

## Symptoms

- Delete worktree modal transitions to "Deleting..." state but never closes
- Worktree is successfully removed from the filesystem and disappears from sidebar
- Modal overlay remains active, blocking UI interaction
- Requires manual page refresh to recover

## Reproduction Steps

1. Open relay-ide with at least one worktree visible in the sidebar
2. Right-click a worktree and select "Delete Worktree"
3. Confirm deletion in the modal
4. Observe: modal stays at "Deleting..." while worktree disappears from sidebar

## Root Cause

Two compounding issues in `handleConfirm()` (DeleteWorktreeDialog.tsx:33-47):

**1. `setDeleting(false)` only in catch block:** The `deleting` state is set to `true` at the start but only reset in the `catch` block. In the success path, `deleting` stays `true` forever. If `shellRef.current?.close()` fails silently (e.g., ref stale from a concurrent re-render), the dialog is stuck in an unrecoverable "Deleting..." state with no error shown and no way out.

**2. Redundant `await refreshAll()` creates race condition:** The WebSocket `worktrees-changed` handler (useEventSocket.ts:48-50) already calls `refreshAll()` when the server broadcasts the event. The additional `await refreshAll()` in `handleConfirm` runs concurrently, creating a window for state mutations and React re-renders that can leave `shellRef.current` in an inconsistent state between the `deleteWorktree()` resolve and the `close()` call.

## Evidence

- Server broadcasts `worktrees-changed` (server/index.ts:1712) before returning HTTP 200 (line 1714)
- WebSocket handler fires `refreshAll()` immediately (useEventSocket.ts:49)
- `handleConfirm` then also calls `refreshAll()` after `close()` — redundant
- `setDeleting(false)` appears only at line 44 inside the `catch` block — never in the success path or `finally` block
- `timed()` wrapper (sessions.ts:73-102) catches all fetch errors, so `refreshAll()` itself won't throw from network failures, but `buildSidebarItems` or other synchronous code could

## Impact Assessment

- Users cannot interact with the UI until they refresh the page
- The worktree IS deleted, so data is not at risk
- Affects any user who deletes a worktree via the dialog

## Fix Applied

1. Moved `setDeleting(false)` to the `finally` block — ensures the dialog always resets from "Deleting..." state regardless of success or failure
2. Removed the redundant `await refreshAll()` — the WebSocket `worktrees-changed` handler already triggers sidebar refresh, eliminating the race condition

## Architecture Review

### Systemic Spread

None — this is the only dialog that calls `refreshAll()` inline after a mutation. Other async dialogs (e.g., CreateWorktree) let the WebSocket event handle refresh.

### Design Gap

The pattern of calling `refreshAll()` after a mutation that also triggers a WebSocket broadcast is a latent anti-pattern. The WebSocket event bus is the canonical refresh mechanism. Inline `refreshAll()` calls after mutations should be avoided when the server already broadcasts an event.

### Testing Gaps

The existing Playwright spec (`test/e2e/components/DeleteWorktreeDialog.spec.ts`) only tests open/cancel/screenshot — it does not test the confirm→close flow. A unit test for `handleConfirm` success path would have caught the missing `setDeleting(false)` reset.

### Harness Context Gaps

None — this is a straightforward UI bug with a clear root cause.
