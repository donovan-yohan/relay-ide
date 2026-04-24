# agent-integration — Backlog

## Epics

- [ ] **Harden the adapter registry** — `server/protocol-adapters/index.ts` and `server/adapters/*-telemetry.ts` both rely on manual registration (factory map + side-effect import). Add a build-time check (unit test that walks `server/types.ts` `AgentFramework` and asserts every framework has a parser + protocol + telemetry adapter) to prevent silent drops.
- [ ] **Approval-buffer stress test** — `pushToBuffer` in `web-session-handler.ts` has approval-preserving eviction but no load test. Add a test that pushes 10k interleaved events and verifies approvals survive under the 1000-event cap, including the all-approvals fallback branch.
- [ ] **Codify AgentEvent ↔ ChatEvent boundary** — the sibling relationship is currently only documented in a header comment. Write an ADR (or add a section in `docs/ARCHITECTURE.md`) describing which lifecycle belongs to each and add a lint/test that flags cross-pollination.
- [ ] **Agent browser soft-dep regression test** — `ensurePlaywright()` must return a helpful error when Chromium is missing. Add a test that simulates the missing-binary path and asserts the server still boots and other routes stay healthy.
- [ ] **Telemetry pending-file migration** — `PendingTelemetryFile.version` implies a schema version but no migration path exists. Document the current schema and add a forward-compat migration helper.
- [ ] **Hook token rotation** — per-session `hookToken`s live forever inside the session. Design a rotation path (e.g., on resume) and add tests for token mismatch rejection.
- [ ] **OpenCode relay reconnection semantics** — `opencode-relay.ts` proxies WebSocket/SSE to the OpenCode CLI. Document and test behavior on agent restart, CLI crash, and transport downgrade.
