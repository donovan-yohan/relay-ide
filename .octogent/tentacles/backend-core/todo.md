# backend-core — Backlog

## Epics

- [ ] **Document PTY lifecycle ADR** — `hooks.ts` and `pty-handler.ts` share session-state responsibilities but no ADR covers the handoff (see note at bottom of `docs/ARCHITECTURE.md` — ADR-002 superseded, `hooks.ts` has no ADR). Write an ADR describing the session state machine, hook HTTP surface, and scrollback eviction rules.
- [ ] **Add tests for sandbox spawning** — `server/sandbox.ts` has no dedicated test coverage beyond `test/sandbox.test.ts`; extend coverage to readiness polling, port collisions, and ephemeral config teardown.
- [ ] **Harden port-allocator `.env` block rewrite** — `port-allocator.ts` manages `ENV_BLOCK_START`/`ENV_BLOCK_END` markers in user-owned `.env` files. Add fuzz tests against malformed markers, duplicate blocks, and interleaved user edits.
- [ ] **Replace `pending-sessions.json` + scrollback-file snapshot with an atomic write path** — audit `serializeAll`/`restoreFromDisk` in `sessions.ts` for partial-write corruption when auto-update restarts overlap, then implement a tmp-file + rename atomic swap.
- [ ] **Extract session-state machine from `sessions.ts`** — display/backend state transitions are scattered between `sessions.ts`, `hooks.ts`, and the output parsers. Consolidate into a pure function (server mirror of `frontend/src/lib/state/display-state.ts`) with table-driven tests.
- [ ] **Analytics retention + migration test suite** — `analytics.ts` runs `runRetentionCleanup` and recovers orphaned sessions on boot; write integration tests for schema migrations, retention windows, and rollup upserts.
- [ ] **Audit auth rate-limit for shared-IP false positives** — `auth.ts` uses a flat per-IP map with a 15-minute hard lockout. Evaluate CIDR reverse-proxy scenarios (`X-Forwarded-For` trust policy) and document or fix.
