# Plan: Codex Review Fixes — Org Dashboard

> **Status**: Active | **Created**: 2026-03-22
> **Source**: `docs/design-docs/2026-03-22-codex-review-fixes-design.md`
> **Branch**: `dy/feat/org-dashboard-cleanup`

## Progress

- [x] Task 1: F5 — Fix premature idempotency update in ticket-transitions
- [x] Task 2: F6 — Add source to BranchLink type and propagate through branch-linker
- [x] Task 3: F3 — Fix poller timestamp gap (poll-start watermark)
- [x] Task 4: F4 — Make stopPolling async and await in-flight poll
- [x] Task 5: F7 — Validate JIRA_BASE_URL at module init
- [x] Task 6: F1 — Validate ticketContext server-side in POST /sessions
- [x] Task 7: F2 — Fetch merged PRs for transition checks
- [x] Task 8: F8 — Fix hasActiveSession key mismatch in branch-linker
- [x] Task 9: F10 — Add Jira/Linear transition tests (including F5 fix coverage)
- [x] Task 10: F9 — Add automation lifecycle tests (poller start/stop/shutdown)

---

### Task 1: F5 — Fix premature idempotency update
**File:** `server/ticket-transitions.ts`
**Change:** Move `transitionMap.set()` after successful API calls in both `transitionOnSessionCreate` and `checkPrTransitions`. For GitHub labels (which have their own try/catch), set after the `addLabel` call. For Jira/Linear, set after the `jiraTransition`/`linearStateUpdate` call succeeds without throwing.

### Task 2: F6 — Add source to BranchLink
**Files:** `server/types.ts`, `server/branch-linker.ts`, `server/ticket-transitions.ts`, `frontend/src/lib/types.ts`
**Change:** Add `source?: 'github' | 'jira' | 'linear'` to `BranchLink` type. In `branch-linker.ts`, infer source from ticket ID pattern (GH- prefix = github, else check configured integrations). In `ticket-transitions.ts`, use `link.source` if available instead of `detectTicketSource()`.

### Task 3: F3 — Fix poller timestamp gap
**File:** `server/review-poller.ts`
**Change:** Capture `const pollStartTimestamp = new Date().toISOString()` before the fetch call. Use `pollStartTimestamp` instead of `new Date().toISOString()` when saving `lastPollTimestamp` at end of cycle.

### Task 4: F4 — Make stopPolling async
**Files:** `server/review-poller.ts`, `server/index.ts`
**Change:** Track `let activePollPromise: Promise<void> | null = null` in review-poller. Set it in the setInterval callback. Make `stopPolling()` async — clear interval then `await activePollPromise`. In `server/index.ts`, make `gracefulShutdown` async and `await stopPolling()`.

### Task 5: F7 — Validate JIRA_BASE_URL
**Files:** `server/integration-jira.ts`, `server/ticket-transitions.ts`
**Change:** In `integration-jira.ts` `getEnvVars()`, validate baseUrl with `new URL()` — reject if protocol is not `https:` (allow `http:` for localhost dev). In `ticket-transitions.ts` `jiraTransition()`, apply same validation before making the request.

### Task 6: F1 — Validate ticketContext server-side
**File:** `server/index.ts`
**Change:** After the existing format check at line 754, add validation: verify `ticketContext.source` is a valid value ('github'|'jira'|'linear'), verify `ticketContext.repoPath` is a configured workspace, and verify the integration is configured (env vars present for the claimed source).

### Task 7: F2 — Fetch merged PRs for transition checks
**File:** `server/org-dashboard.ts`
**Change:** After fetching open PRs, make a second `gh api` call for recently merged PRs (`is:pr is:merged merged:>7d involves:@me`). Pass both open and merged PRs to `checkPrTransitions`. Only cache and return open PRs to the client (merged fetch is internal-only for transitions).

### Task 8: F8 — Fix hasActiveSession key mismatch
**File:** `server/index.ts`
**Change:** In the `getActiveBranchNames` callback at line 290, change the map key from `s.repoPath` (which can be a worktree path) to the workspace root. Find the matching workspace root by checking which configured workspace path is a prefix of `s.repoPath`.

### Task 9: F10 — Add Jira/Linear transition tests
**File:** `test/ticket-transitions.test.ts`
**Change:** Add test cases for: Jira transitions with mocked `fetch`, Linear transitions with mocked `fetch`, status-mapping lookups, the F5 fix (transitionMap not updated on API failure), and source detection via branch links.

### Task 10: F9 — Add automation lifecycle tests
**File:** `test/review-poller.test.ts`
**Change:** Add tests for: async stopPolling awaits in-flight poll, poll-start watermark is used (not end-of-cycle timestamp), and pollInFlight prevents overlap.
