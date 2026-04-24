# frontend-state — Backlog

## Epics

- [ ] **Keep frontend `deriveBackendState` ↔ server `computeBackendState` in lockstep** — `sidebar-items.ts` has a comment instructing manual mirroring of `server/sessions.ts`. Write a shared fixture (e.g. generated JSON of `(agentState, idle) → backendState` tuples) consumed by both suites so divergence is caught.
- [ ] **Action registry conflict tests** — `registry.ts` throws on double-registration but `_resetForTesting` is the only recovery. Add tests that exercise contextual re-registration across view transitions and document the lifecycle.
- [ ] **WebSocket reconnection UX polish** — `lib/ws.ts` manages PTY (exponential backoff, capped 10 s, max 30 attempts) and event sockets (fixed 3 s). Centralize retry state into a tiny machine with observable status, and surface `[Reconnecting…]` consistently across views.
- [ ] **Mobile-input fixture coverage** — audit `test/fixtures/mobile-input/` for coverage gaps (iOS cursor-0 autocorrect, grapheme-cluster edits, paste+IME, dictation replacement). Add missing fixtures before next mobile keyboard bug (per CLAUDE.md rule).
- [ ] **Throttle + debounce audit** — `useEventSocket` uses a 500 ms throttle for poll invalidation and ad-hoc timers for ref-changed. Document every timer in the frontend, rationalize windows, and add jest fake-timer tests.
- [ ] **Store persistence migration path** — `ui.ts` stores localStorage keys as `claude-remote-*` (legacy product name). Plan a rename to `relay-ide-*` with a one-time migration read that keeps user prefs intact.
- [ ] **Onboarding hint eviction logic** — `useOnboardingHints` + `hints.ts` need tests for user dismissal persistence and progression across sessions.
- [ ] **TanStack Query invalidation keys doc** — enumerate every `queryKey` used and which events invalidate it (`useEventSocket.ts`, view components). Produce a table so backend events and cache invalidation stay aligned.
