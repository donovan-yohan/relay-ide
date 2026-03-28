# Jira CLI Rewrite — Execution Plan

> **Status**: Complete | **Created**: 2026-03-22
> **Design**: docs/design-docs/2026-03-22-jira-acli-rewrite-design.md

## Progress

- [x] Task 1: Rewrite server/integration-jira.ts to use acli CLI
- [x] Task 2: Rewrite jiraTransition() and clean up ticket-transitions.ts
- [x] Task 3: Remove Linear integration (server + types)
- [x] Task 4: Update frontend (TicketsPanel, StatusMappingModal, api.ts)
- [x] Task 5: Rewrite tests
- [x] Task 6: Build + test verification — 368 tests pass, 0 failures

---

### Task 1: Rewrite server/integration-jira.ts
**Depends on**: None
**Files**: `server/integration-jira.ts`

Replace all three route handlers with execFile('acli') calls:
- Remove `GET /configured` endpoint
- Rewrite `GET /issues` to run `acli jira workitem search --jql ... --json`
- Rewrite `GET /statuses?projectKey=X` to search issues and extract unique statuses
- Add site URL caching (from `acli jira auth status` output)
- Map acli JSON output to existing JiraIssue type per design doc data mapping table
- Delete dead code: `getEnvVars()`, `buildAuthHeader()`, `JiraSearchResult` interface
- Update `IntegrationJiraDeps` to include `execAsync` injection
- Keep 60s in-memory cache, 10s timeout
- Error handling: ENOENT → acli_not_in_path, auth stderr → acli_not_authenticated, timeout → jira_fetch_failed

### Task 2: Rewrite jiraTransition() and clean up ticket-transitions.ts
**Depends on**: None (parallel with Task 1)
**Files**: `server/ticket-transitions.ts`

- Rewrite `jiraTransition()` to use `execFile('acli', ['jira', 'workitem', 'transition', '--key', ticketId, '--status', transitionName, '--yes'])`
- Add `execAsync` dependency injection
- Delete `isValidJiraUrl()`
- Delete `linearStateUpdate()`
- Simplify `detectTicketSource()`: remove LINEAR_API_KEY check, remove 'linear' branch
- Simplify `getStatusMapping()`: remove 'linear' parameter
- Delete all `linear` branches in `transitionOnSessionCreate()` and `checkPrTransitions()`

### Task 3: Remove Linear integration (server + types)
**Depends on**: None (parallel with Tasks 1-2)
**Files**: `server/integration-linear.ts` (delete), `server/index.ts`, `server/types.ts`

- Delete `server/integration-linear.ts`
- Remove Linear route mounting from `server/index.ts`
- Remove from types.ts: `LinearIssue`, `LinearIssuesResponse`, `LinearState`
- Narrow `BranchLink.source` to `'github' | 'jira' | undefined`
- Narrow `TicketContext.source` to `'github' | 'jira'`
- Remove `Config.integrations.linear` from type definition

### Task 4: Update frontend
**Depends on**: Task 1 (needs to know error codes), Task 3 (Linear removal)
**Files**: `frontend/src/components/TicketsPanel.svelte`, `frontend/src/components/StatusMappingModal.svelte`, `frontend/src/lib/api.ts`

- TicketsPanel: Remove Linear tab, remove jiraConfigured check, always show Jira tab
- TicketsPanel: Update error messages for acli_not_in_path, acli_not_authenticated, jira_auth_failed
- api.ts: Remove fetchLinearConfigured, fetchLinearIssues, fetchLinearStates, fetchJiraConfigured
- StatusMappingModal: Remove Linear status mapping, change "Transition ID" label to "Status name"

### Task 5: Rewrite tests
**Depends on**: Tasks 1-3 (need final implementation to test against)
**Files**: `test/integration-jira.test.ts` (rewrite), `test/integration-linear.test.ts` (delete), `test/ticket-transitions.test.ts` (modify)

- Rewrite integration-jira tests to mock execFile (follow integration-github.test.ts pattern)
- Test cases: ENOENT, auth failure, timeout, success, empty, cache, statuses dedup, missing projectKey
- Delete integration-linear.test.ts
- Update ticket-transitions tests: remove Linear cases, add acli transition tests

### Task 6: Build + test verification
**Depends on**: Tasks 1-5
**Files**: None (verification only)

- Run `npm run build` — verify TypeScript compilation succeeds
- Run `npm test` — verify all tests pass
- Fix any compilation or test failures
