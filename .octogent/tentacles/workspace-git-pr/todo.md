# workspace-git-pr — Backlog

## Epics

- [ ] **Consolidate cache invalidation** — `branch-linker`, `integration-github`, `integration-jira`, `org-dashboard`, and `gh.ts` each maintain their own 60 s cache with ad-hoc invalidation. Factor into a shared `TtlCache<K, V>` with explicit invalidation keys so PR state changes fan out correctly.
- [ ] **Integration test suite for ticket-transitions** — `ticket-transitions.ts` drives GH labels and Jira transitions on session/PR events; there's a unit test for each provider but no end-to-end scenario covering the full `in-progress → code-review → ready-for-qa` chain. Add a scenario test with injected `execAsync`.
- [ ] **Harden webhook HMAC verification** — `webhooks.ts` verifies GitHub HMAC signatures; add tests for timing-safe compare, malformed headers, and replay windows; document the secret-rotation flow.
- [ ] **Smee reconnect + degradation UX** — when `smeeConnected` flips to false, `webhook-manager.ts` silently falls back to polling. Surface the health state through `/webhooks/manage/status` with structured error codes and write integration tests for transitions.
- [ ] **Branch-linker regex cases** — Current ticket-id extraction handles Jira-style + `GH-NNN`. Add fixtures for edge cases (scoped prefixes, case-insensitive variants, multiple tickets per branch) and document the precedence rule.
- [ ] **Review-poller cancellation semantics** — `startPolling` / `stopPolling` in `review-poller.ts` manage the 5-min interval; test shutdown under in-flight notifications + workspace removal.
- [ ] **`browser-content.ts` token scope audit** — per-file Bearer tokens are minted per request. Audit token lifetime, re-use, and realpath canonicalization for directory-traversal regressions.
- [ ] **Activity feed pagination** — `getActivityFeed` in `git.ts` returns a bounded list; document the limit, expose a cursor if needed, and ensure the frontend `RepoDashboard` handles empty/oversized results.
