# frontend-state

Zustand stores, React hooks, pure state machines, action registry, REST + WebSocket clients, mobile input pipeline.

## Scope

- `frontend/src/lib/stores/` — Zustand stores:
  - `auth.ts` — PIN auth state + `authAuthenticated` gate
  - `sessions.ts` — session registry, sidebar items, unread tracking, `handleBackendStateChanged`, `refreshAll`, `enrichSidebarBranches`
  - `ui.ts` — layout preferences (sidebar width, collapsed state, right-sidebar tab, file viewer tabs, terminal font size, diff view mode, word wrap) persisted to `localStorage` under `claude-remote-*` keys
  - `config.ts` — server config mirror
  - `boot-state.ts` — first-paint readiness
  - `telemetry.ts` — per-session + account telemetry from `/ws/events`
  - `hints.ts` — onboarding hint progression
  - `toasts.ts`, `notifications.ts`, `unread.ts`
- `frontend/src/lib/state/` — pure state-machine modules (no React):
  - `display-state.ts` — 6-state display machine `transitionDisplayState`, `shouldNotify`, `BackendDisplayState`/`DisplayState` types, legal transition table (e.g. `seen-idle` can only return to `unseen-idle` through `running`)
  - `sidebar-items.ts` — `buildSidebarItems()` reconciliation + `deriveBackendState`, mirrored with `server/sessions.ts computeBackendState`
  - `attention.ts` — `STATE_SCORES`, `highestPriorityState`, `computeAttentionScore` (PR urgency + recency decay + unread bonus), `sortByAttention`, `workspaceAttentionScore`
  - `unread-logic.ts` — `shouldMarkUnread` predicates
- `frontend/src/lib/actions/` — typed action registry:
  - `types.ts` — `Action`, `ActionMeta`, `ActionContext` (view + optional workspacePath/sessionId/agentRunning/isMobile/prState), `ActionCategory` literals
  - `registry.ts` — `registerGlobal`, `registerContextual`, `getAction`, `getAllActions`, `getActionsByCategory`, `_resetForTesting`
  - `shortcuts.ts` — keyboard-shortcut tuples
  - `definitions/` — `session.ts`, `workspace.ts`, `pr.ts`, `settings.ts` (pure `ActionMeta` — handlers wired in `App.tsx`)
- `frontend/src/hooks/` — React hooks:
  - `useEventSocket.ts` — `/ws/events` subscription, dispatches to stores + `QueryClient.invalidateQueries` with throttled poll-invalidate (500 ms window for `pr-updated`/`ci-updated`)
  - `useSessionHandlers.ts` — session CRUD + lifecycle
  - `useActionRegistry.ts` — registry integration for `CommandPalette`
  - `useRepoAggregation.ts` — per-repo state aggregation
  - `useAppShortcuts.ts` — global keyboard shortcuts
  - `useScrollOverflow.ts`, `useClickOutside.ts`, `useUrlNav.ts`, `useOnboardingHints.tsx`, `useWhatsNew.tsx`, `useChatSocket.ts`
- `frontend/src/lib/` — transport + utilities:
  - `api.ts` — REST client (`ConflictError` for 409 responses, typed returns)
  - `ws.ts` — PTY socket (`connectPtySocket`, `sendPtyData`, `sendPtyResize`) + event socket (`connectEventSocket`, `EventMessage` discriminated union)
  - `analytics.ts` — browser analytics batch collection + `data-track` attribute integration
  - `telemetry-sync.ts` — local telemetry cache sync
  - `notifications.ts` — Notification API + service-worker + Web Push subscription
  - `diff-summary.ts`, `diff-utils.ts`, `file-tree-utils.ts`, `fuzzy-scorer.ts`, `greetings.ts`, `pr-state.ts`, `pr-status.ts`, `pr-utils.ts`, `session-intent.ts`, `session-utils.ts`, `shiki.ts`, `terminal-zoom.ts`, `url-nav.ts`, `utils.ts`, `whats-new.ts`, `colors.ts`, `logger.ts`, `types.ts`
- `shared/mobile-input-pipeline.ts` — **pure-function** event-intent pipeline consumed by `MobileInput`. Defines `CapturedIntent`, `PipelineResult`, `codepointCount`, `commonPrefixLength`, `makeBackspaces` helpers. No DOM dependencies — unit-tested via JSON fixtures under `test/fixtures/mobile-input/`.

## Key Decisions

- **Stores vs. pure state.** `lib/stores/` holds reactive Zustand state; `lib/state/` holds pure, testable transition functions that stores call into. Components never import from `lib/state/` directly except for type imports — the flow is: event → store action → pure transition → state update.
- **Server state via TanStack Query; UI state via Zustand.** PRs, CI, dashboards, analytics live in the React Query cache (keys `['pr']`, `['ci-status']`, `['org-prs']`, etc.). Everything else — sessions, sidebar items, UI preferences — is in Zustand. Don't mirror server state into Zustand.
- **Two WebSockets, strict discriminated union.** `EventMessage` in `lib/ws.ts` is the canonical event schema (`worktrees-changed`, `session-backend-state-changed`, `session-renamed`, `session-branch-changed`, `session-ended`, `ref-changed`, `pr-updated`, `ci-updated`, `files-changed`, `session-activity-changed`). `useEventSocket` maintains a handler map keyed off `EventMessage['type']` so adding a new event type forces a compile error until handled.
- **Display state machine enforces transitions.** `seen-idle` can never become `unseen-idle` without going through `running` first. The backend emits only `session-backend-state-changed`; the frontend computes the richer `DisplayState` via `transitionDisplayState` (`docs/FRONTEND.md` line 105).
- **`deriveBackendState` mirrors the server.** `sidebar-items.ts` has a header comment instructing to keep in sync with `server/sessions.ts computeBackendState`. When the server changes priority order, the frontend mirror must be updated in the same PR.
- **Poll invalidation is throttled.** `useEventSocket` wraps `pr-updated` / `ci-updated` in a 500 ms throttle so polling storms don't thrash TanStack Query.
- **Action registry is a two-phase system.** `ActionMeta` (pure, no handler) is defined in `definitions/`; handlers are attached in `App.tsx` via `registerGlobal()`. Registering the same id as both global and contextual throws.
- **Action IDs are typed as `${ActionCategory}.${string}`.** New action must pick a category (`session | workspace | pr | settings | sidebar | terminal | navigation | dashboard | org | ticket`). ID typos are caught at compile time.
- **Mobile input pipeline is DOM-free.** `shared/mobile-input-pipeline.ts` returns `PipelineResult { payload, newInputValue? }`; `MobileInput.tsx` applies the payload to xterm and, if `newInputValue` is set, mutates `inputEl.value` and calls `ensureCursorAtEnd()`. When fixing mobile keyboard bugs, add a fixture to `test/fixtures/mobile-input/` before touching code (CLAUDE.md rule).

## Conventions

- New store? Create `lib/stores/<name>.ts` with a single `create<StoreState>()(...)` call. Load persisted keys lazily inside the creator (wrapped in `try/catch` for environments without `localStorage`).
- New `/ws/events` event type? Add to the `EventMessage` union in `lib/ws.ts` and to the `handlers` map in `useEventSocket.ts` — the object-literal handler type forces compile coverage.
- New REST endpoint? Add a typed function in `lib/api.ts`; components consume via TanStack Query with a keyed cache (`['pr', repoPath, branch]`, etc.).
- New pure transition? Put it in `lib/state/` with table-driven unit tests; never inline transition logic inside a store.
- Keep `shared/mobile-input-pipeline.ts` pure: no `document`, no `window`, no xterm imports. Input fixtures in `test/fixtures/mobile-input/` are canonical.
- Logging: import `createLogger('name')` from `lib/logger.ts`; don't call `console.*` directly (matches server convention).

<!-- octogent:suggested-skills:start -->

## Suggested Skills

You can use these skills if you need to.

- `investigate`
- `review`
- `codex`
- `qa`
<!-- octogent:suggested-skills:end -->
