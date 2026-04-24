# testing-qa — Backlog

## Epics

- [ ] **Audit `[needs:*]` annotation coverage** — `docs/QUALITY.md` lists `[needs:git-init]` cases but future `[needs:network]` and `[needs:docker]` are aspirational. Scan `test/` for network + docker calls, add the annotations, and update the pre-push filter.
- [ ] **Extract a shared factory for `Session`/`SidebarItem`** — `test/helpers/frontend-factories.ts` only covers a subset. Extend to cover all `SessionSummary` + `WorktreeInfo` shapes and migrate ad-hoc test object literals.
- [ ] **Expand mobile-input fixture matrix** — current fixtures cover Gboard autocorrect + iOS replacement + paste. Add fixtures for dictation, IME composition, split-keyboard on iPad, and grapheme-cluster edits before the next mobile keyboard bug.
- [ ] **Playwright visual-regression baselines** — `test/e2e/helpers/visual.ts` and `screenshots/` lack a refresh workflow doc. Write a contributor runbook + CI job that compares screenshots with stable diffing, fails on material change, and supports `test:e2e:update`.
- [ ] **Component test gap: dialogs** — `test/components/` covers low-level primitives but not `DialogShell`, `SettingsDialog`, `CustomizeSessionDialog`. Add tests against the popover top-layer contract.
- [ ] **Server integration test runner** — factor `test/helpers/test-server.ts` into reusable `startRelay(config)` + `stopRelay()` helpers with port allocation, so every integration test can boot cheaply in parallel.
- [ ] **CI matrix for Node versions** — `engines: node >= 24`. Add a CI job that tests on 24.x only (current) but document how to detect regressions when Node 24.x minor upgrades ship.
- [ ] **Flake dashboard** — log test durations and failures over time; surface the top flaky tests and convert them into deterministic tests or explicit annotated exclusions.
