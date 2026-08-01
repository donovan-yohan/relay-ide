# Learnings

Persistent learnings captured across sessions. Append-only, merge-friendly.

Status: `active` | `superseded`
Categories: `architecture` | `testing` | `patterns` | `workflow` | `debugging` | `performance`

---

### L-20260320-alternate-screen-scroll: Alternate-screen terminals need a viewport freeze layer to support scroll during streaming

- status: active
- category: architecture
- source: /harness:bug 2026-03-20
- branch: master

When building terminal features for alternate-screen apps such as vim,
remember that xterm.js has no scrollback in alternate-screen mode (`baseY=0`).
Scroll events reach the TUI correctly, but continuous re-rendering during
streaming immediately overrides the scroll position. A feature requiring
user-controlled scrolling must implement an intermediary buffer layer, such as
screen snapshotting or output gating; simply forwarding scroll events is
insufficient.

---

### L-20260321-mobile-ws-reconnect: Mobile WebSocket reconnection must not rely solely on `onclose` — use `visibilitychange` + heartbeat

- status: active
- category: architecture
- source: /harness:bug 2026-03-21
- branch: master

When a mobile browser backgrounds an app, the OS silently kills TCP connections but the browser may not fire WebSocket `onclose` for 30-60+ seconds (or never). Never rely solely on `onclose` for reconnection. Always add: (1) a `visibilitychange` listener that probes socket health when the page becomes visible, and (2) a periodic client-side heartbeat with a response timeout to detect zombie connections. `readyState === OPEN` is unreliable on zombie sockets — always verify with an actual ping/pong exchange.

---

### L-20260321-nav-model-ui-flows: UI flows must be updated when the navigation model changes — dead code paths become user-facing bugs

- status: active
- category: architecture
- source: /harness:bug 2026-03-21
- branch: olympus

When migrating from a selection-based model (user picks repo/worktree at creation time) to a context-driven model (workspace already knows its folder), audit ALL UI entry points that create entities. Leftover modals, tabs, and labels that reference the old model become broken flows — not just cosmetic debt. In this case, the "New Terminal" button opened a repo-selection modal instead of calling the existing `createTerminalSession()` API, making terminal creation impossible. Always grep for API functions that become unreachable after an architecture change.

---

### L-20260322-session-state-refresh: Session state derived from external systems (git, filesystem) must have a refresh mechanism — snapshot-at-creation is insufficient

- status: active
- category: architecture
- source: /harness:bug 2026-03-22
- branch: mont-blanc

When storing state that mirrors an external system (e.g., `session.branchName` from `git rev-parse`), always implement a refresh mechanism — either a filesystem watcher on the source of truth (`.git/HEAD`), periodic polling, or re-reading on API requests. Snapshot-at-creation creates a hidden staleness contract that users don't expect. In this project, the `WorktreeWatcher` watches directory structure but not `.git/HEAD`, so branch checkouts are invisible. When adding any external-system-derived field to a long-lived object, ask: "what watches for changes to this value?"

---

### L-20260321-execfile-err-code: Check `err.code` not `err.message` for Node.js execFile errors

- status: active
- category: debugging
- source: /harness:loop Phase 1 org-dashboard 2026-03-21

Node.js `child_process.execFile` throws with `code: 'ENOENT'` and message `'spawn <cmd> ENOENT'` when a binary isn't in PATH. String-matching the message (`'command not found'`, `'not found'`) fails because the actual message format is `'spawn gh ENOENT'`. Always check `(err as NodeJS.ErrnoException).code === 'ENOENT'` instead.

---

### L-20260321-github-search-pr-filter: GitHub Search API returns issues AND PRs — filter on `pull_request` field

- status: active
- category: patterns
- source: /harness:loop Phase 1 org-dashboard 2026-03-21

`gh api search/issues?q=is:pr+is:open+involves:@me` can return non-PR issues that match on `involves:@me`. The `pull_request` field on each item is the discriminator — skip items where it's absent.

---

### L-20260321-github-search-reviewers: GitHub Search API does not return `requested_reviewers` — reviewer detection is best-effort

- status: active
- category: patterns
- source: PR #38 review (org-dashboard Phase 1)

The `search/issues` endpoint returns a subset of PR metadata. Notably, `requested_reviewers` is not included — it's only available via the per-PR endpoint (`/repos/{owner}/{repo}/pulls/{number}`). The org dashboard's reviewer detection (`role: 'reviewer'`) is therefore best-effort; PRs where the user is a requested reviewer may display as `role: 'author'` or be filtered out entirely.

---

### L-20260321-github-search-review-decision: GitHub Search API does not return `reviewDecision` — PR status dot defaults to success

- status: active
- category: patterns
- source: PR #38 review (org-dashboard Phase 1)

The `search/issues` endpoint does not include `reviewDecision` (APPROVED, CHANGES_REQUESTED, etc.). The org dashboard's PR status dot (`prStatusDotClass`) falls through to `dot-success` for all open PRs since `reviewDecision` is always null. To show accurate review status, each PR would need a separate API call to the pulls endpoint.

---

### L-20260321-github-search-open-only: Org dashboard "All" filter operates on `is:open` backend data — cannot show closed PRs

- status: active
- category: patterns
- source: PR #38 review (org-dashboard Phase 1)

The org dashboard backend queries `is:open` in its GitHub search. The frontend "All" filter operates on the returned dataset, not a separate query — switching from "Open" to "All" shows the same PRs. To support closed/merged PR display, the backend would need a second query or the existing query would need to drop `is:open` (which would increase response size significantly).

---

### L-20260322-sidebar-group-identity: Sidebar group rows must derive identity from the group, not from individual sessions within it

- status: active
- category: architecture
- source: /harness:bug 2026-03-22
- branch: fix-sidenav-tabs-isolation

When a sidebar row represents a group of sessions (e.g., all tabs for a worktree), the row's name and icon must come from the group's identity (worktree path, branch name), not from a "representative" session selected by recency. Picking the most-recently-active session as the representative leaks tab-level details (session type, auto-generated tab name) into the sidebar. Tab identity belongs to the tab bar; sidebar identity belongs to the worktree/group. When adding grouped UI patterns, always ask: "does the group's display change when the user interacts with an individual item within it?"

---

### L-20260323-tanstack-query-untrack: Never call `.refetch()` on a TanStack Query store inside a Svelte 5 `$effect` without `untrack()`

- status: active
- category: debugging
- source: /harness:bug 2026-03-23
- branch: master

TanStack Query's `createQuery` returns a Svelte 5 reactive proxy. Accessing `.refetch` inside a `$effect` tracks the query store as a dependency. When `refetch()` completes, it updates internal state (`isFetching`, `data`), which re-triggers the effect, creating an infinite loop. Always wrap `.refetch()` calls in `untrack()` when used inside `$effect`, or use `queryClient.invalidateQueries()` from outside reactive contexts instead.

---

### L-20260324-config-stale-read: When one module mutates shared config on disk, all modules that read that config must reload — never validate against a startup snapshot

- status: active
- category: architecture
- source: /harness:bug 2026-03-24
- branch: workspace-config-validation

When multiple server modules access the same config file, ensure they all use the same access pattern. If a workspace router reloads config from disk on every request (fresh reads), but the session handler validates against an in-memory object loaded at startup (stale read), any mutations by the workspace router are invisible to the session handler until restart. Either centralize config access behind a single `getConfig()` that always reads from disk, or use an event/notification pattern so disk mutations propagate to in-memory consumers. The workspace router's `getConfig()` pattern is the correct one — the problem is `index.ts` using a stale `let config` loaded once at startup.

---

### L-20260323-shared-naming-counter: When multiple code paths create the same resource type, they must share a single counter/naming mechanism

- status: active
- category: architecture
- source: /harness:bug 2026-03-23
- branch: master

`POST /sessions` and `POST /workspaces/worktree` both create git worktrees with mountain names, but use different counters (global `config.nextMountainIndex` vs per-workspace `settings.nextMountainIndex`). Worktrees created via one path don't increment the other's counter, causing name collisions that silently break worktree creation. Additionally, resource creation APIs that depend on sequential naming must include collision detection (check if name/branch/directory exists, skip to next) — never assume the counter is accurate. When adding any auto-naming feature, grep for all code paths that create the same resource type and ensure they share one source of truth.

---

### L-20260324-fixed-in-dialog: `position: fixed` inside a `<dialog>` top-layer element uses the dialog as the containing block, not the viewport

- status: active
- category: debugging
- source: commit f88d830 (settings-webhooks branch, 2026-03-24)
- branch: dy/feat/settings-webhooks

When an element with `position: fixed` is a descendant of a `<dialog>` that is in the browser's top layer, the dialog becomes the CSS containing block — not the viewport. This means `inset: 0` fills the dialog, not the screen, and `height: 100%` refers to the dialog's height. The fix: use `position: absolute` on drawers/backdrops inside dialogs, ensure the ancestor dialog content wrapper has `position: relative`, and set `bottom: 0` instead of `height: 100%`. This affects `SettingsToc.svelte` and any future drawer-inside-dialog pattern.

---

### L-20260324-exact-optional-types: `exactOptionalPropertyTypes: true` requires explicit `| undefined` in object spread and partial-init assignments

- status: active
- category: patterns
- source: settings-webhooks branch, frontend tsconfig.json
- branch: dy/feat/settings-webhooks

The frontend tsconfig enables `exactOptionalPropertyTypes: true`. Under this setting, TypeScript distinguishes between a property that is absent (`{}`) and one explicitly set to `undefined` (`{foo: undefined}`). This means: (1) you cannot assign `undefined` to an optional property without adding `| undefined` to its type; (2) object spreads from partial sources may produce type errors at the assignment site even if the runtime values are identical. When adding optional fields to interface types used in spread assignments (e.g., `WorkspaceSettings`), declare them as `fieldName?: Type` and never write `fieldName: undefined` at the assignment site — omit the key entirely instead.

---

### L-20260325-browser-permission-ui: Features gated by browser permissions must surface the permission state in the UI — a settings toggle is not a permission request

- status: active
- category: architecture
- source: /harness:bug 2026-03-25
- branch: everest

When a feature depends on a browser permission (Notifications, Geolocation, Camera, etc.), the settings UI must address two distinct layers: (1) the app-level opt-in (which entities should use the feature) and (2) the browser-level permission (whether the browser allows it at all). A checkbox that only controls layer 1 gives users a false sense of enablement. Always: call the browser permission API when the user enables the feature, display the current permission state (granted/denied/default), and provide guidance if permission was denied. The permission request must be triggered by a user gesture (especially on iOS PWA where this is strictly enforced).

---

### L-20260325-silent-catch-blocks: Silent catch blocks on browser API calls hide broken features — always log or surface permission/subscription failures

- status: active
- category: debugging
- source: /harness:bug 2026-03-25
- branch: everest

When calling browser APIs that can fail due to missing permissions (e.g., `pushManager.subscribe()`, `Notification.requestPermission()`), empty `catch {}` blocks make broken features indistinguishable from working ones. The push notification pipeline had three silent catches that hid the fact that no subscription was ever created. At minimum: log the error in development, and in production surface the failure state in the UI (e.g., "Push notifications unavailable — permission denied"). Never swallow errors from permission-dependent APIs without at least recording the failure in application state.

---

### L-20260325-dnd-device-aware: DnD `dragDisabled` must be device-aware — always-on for mouse, gated for touch

- status: active
- category: patterns
- source: /harness:bug 2026-03-25
- branch: shasta

When using `svelte-dnd-action` on a scrollable container, `dragDisabled` must use different strategies per input method. Mouse drag does not conflict with scroll (users scroll via wheel), so desktop should always have `dragDisabled: false`. Touch drag conflicts with scroll (both are finger gestures), so mobile needs `dragDisabled: true` by default with a long-press gesture to enable drag temporarily. A single global "reorder mode" toggle that gates all input types equally will either break desktop drag (no mouse entry point) or break mobile scroll (always-on touch interception). Use `matchMedia('(pointer: fine)')` or similar to branch behavior.

---

### L-20260325-library-flag-coupling: Never couple a library's technical enable/disable flag to unrelated UI visibility changes

- status: active
- category: architecture
- source: /harness:bug 2026-03-25
- branch: shasta

When a library provides a boolean to enable/disable its event handling (e.g., `svelte-dnd-action`'s `dragDisabled`), do not bind that same boolean to UI layout changes (hiding content, collapsing sections). The library flag exists for event management, not visual design. Coupling them means any change to the event strategy (e.g., making drag always-on for desktop) forces an unintended layout change. Keep library enable/disable flags as narrow technical controls. If a distinct UI mode is needed, use a separate state variable with its own entry/exit logic.

---

### L-20260325-resource-name-uniqueness: Auto-generated resource names that interact with external systems must include a uniqueness token

- status: active
- category: architecture
- source: /harness:bug 2026-03-25
- branch: kilimanjaro

When generating names for resources (branches, worktrees, containers) that interact with external systems retaining permanent history (GitHub PRs, Docker registries, CI pipelines), never reuse bare names from a rotating pool. External systems associate names permanently — `gh pr view <branch>` returns the most recent PR for that branch name regardless of state. Append a short unique suffix (e.g., 4-char random hex) so each lifecycle gets a distinct identity. The cost is cosmetic (slightly longer names); the benefit is eliminating an entire class of stale-association bugs. This applies even when the name is temporary (e.g., renamed after first interaction) because the initial state matters for UX.

---

### L-20260325-bug-fix-tracking: When a bug analysis recommends both a short-term and long-term fix, the long-term fix needs a tracking mechanism or it will be forgotten

- status: active
- category: patterns
- source: /harness:bug 2026-03-25
- branch: kilimanjaro

The 2026-03-19 stale-PR bug analysis recommended (1) filter merged/closed PRs (short-term) and (2) unique branch names (long-term). The short-term fix was partially applied but the long-term fix was never implemented, causing recurrence 6 days later. When a bug has both a symptom fix and a root-cause fix, the root-cause fix must be tracked as a separate work item (plan, issue, or TODO) — otherwise it gets lost in the "we fixed it" satisfaction of the symptom fix.

---

### L-20260324-status-state-machine: UI status indicators derived from multiple signal sources need a formal state machine — not ad-hoc guards

- status: active
- category: architecture
- source: /harness:bug 2026-03-24
- branch: dy-fix-idle-status-regression

When a display status (e.g., session dot color) is derived from multiple independent signals (PTY idle timer, hook-based agentState, parser reconciliation), ad-hoc guards and cooldown timers will always have edge cases. The root invariant — "only show attention when there's genuinely new content the user hasn't seen" — cannot be enforced by checking individual signals in isolation. Instead, model the display state as a formal state machine with a transition function that accepts semantic events and enforces valid transitions at the type level. The key insight: `seen-idle → unseen-idle` should be an **impossible transition** — the only path to `unseen-idle` must go through `running` first.

---

### L-20260325-ws-query-invalidation: WebSocket-driven query invalidation should be scoped to the affected resource — blanket-invalidation is strongly discouraged

- status: active
- category: architecture
- source: /harness:bug 2026-03-25
- branch: master

When WebSocket events carry a payload identifying which resource changed (e.g., `{ repo: "owner/repo" }`), the frontend invalidation handler must use that payload to target specific query keys — not call `invalidateQueries({ queryKey: ['pr'] })` which invalidates every query whose key starts with `['pr']`. TanStack Query keys already encode the resource identity (e.g., `['pr', workspacePath, branch]`), so per-resource invalidation is architecturally possible. Blanket invalidation turns a targeted event into a broadcast, causing O(N) refetches where N is the number of active queries of that type. This is especially wasteful when combined with poll-based event sources that fire periodically regardless of actual changes.

---

### L-20260325-negative-cache-ttl: Negative query results from external systems need longer cache TTLs than positive results — "nothing exists" rarely changes without user action

- status: active
- category: patterns
- source: /harness:bug 2026-03-25
- branch: master

When a query to an external system (GitHub API, database, etc.) returns "not found" / empty / null, cache that negative result with a longer TTL than positive results. The absence of a resource (no PR for a branch) only changes when the user takes explicit action (creates a PR, pushes a ref). Polling a "does this PR exist?" endpoint every 30 seconds when the answer has been "no" for the last hour spawns subprocesses and burns API rate limits for zero information gain. Negative caching should only be invalidated by meaningful state changes: `ref-changed` events, user-initiated refresh, or incoming webhooks — not by periodic "re-check everything" timers. On the server side, endpoints that proxy to expensive external calls (subprocess spawns, API calls) should always cache their results, including negative results.

---

### L-20260325-dual-mobile-mechanism: Never use dual mechanisms (CSS media query + JS matchMedia) to implement mobile-specific behavior — use CSS alone for visibility

- status: active
- category: patterns
- source: /harness:bug 2026-03-25
- branch: hood

When a UI element needs different visibility on mobile vs desktop (e.g., "always visible on mobile, hover-reveal on desktop"), implement it purely in CSS with a media query override — never add a parallel JS `matchMedia` check that also hides the element. Dual mechanisms create redundant hiding that's easy to break independently: fixing the CSS leaves the JS guard in place (or vice versa), making the bug appear unfixed. The pattern: set the desktop default in base CSS (e.g., `opacity: 0` + `:hover { opacity: 1 }`), then override in `@media (max-width: 600px) { opacity: 1 }`. Never pass a `hideTrigger={isMobile}` prop that prevents the element from rendering in the DOM — CSS can't show what JS never rendered.

---

### L-20260325-template-state-chain: When a template adds explicit checks for a state already handled by a state machine, use `{:else if}` — never independent `{#if}` blocks for mutually exclusive states

- status: active
- category: architecture
- source: /harness:bug 2026-03-25
- branch: fuji

When a pure-function state machine (e.g., `derivePrAction()`) already maps input states to actions, and the template adds explicit checks for specific states (e.g., `CONFLICTING` → "Fix Conflicts" button with a different handler), those explicit checks and the state machine's generic output must be rendered as a priority chain, not as independent blocks. Using independent `{#if}` blocks for states that should render only one pill creates duplication when multiple conditions fire — e.g., `CONFLICTING` fires both the explicit check and the generic `action.type !== 'none'` guard. Always use `{#if}/{:else if}/{:else if}` chains so the first matching condition wins. When adding a new template branch for a specific state, check whether the generic action rendering also fires for the same state.

---

### L-20260327-api-error-body-parse: Never call `.json()` on error responses without try-catch — non-JSON error bodies turn server errors into client TypeErrors

- status: active
- category: patterns
- source: /harness:bug 2026-03-27
- branch: master

When parsing error response bodies from API calls, always wrap `.json()` in a try-catch with a fallback to the HTTP status code. Server error responses may be empty (unhandled exception), HTML (Express default error handler), or truncated (network issue). The pattern `if (!res.ok) { const data = await res.json(); throw new Error(data.error) }` is fragile — if `.json()` throws, the user sees a raw TypeError ("Unexpected end of JSON input") instead of the actual HTTP error. Extract a `parseErrorBody(res)` helper that tries `.json()` and falls back to `HTTP ${res.status}`. Apply uniformly to all API functions.

---

### L-20260327-express4-async-errors: Express 4 does NOT catch async route handler errors — unhandled throws leave responses hanging

- status: active
- category: architecture
- source: /harness:bug 2026-03-27
- branch: master

Express 4's `Layer.prototype.handle_request` only has a sync try-catch around `fn(req, res, next)`. If the handler is `async` and the returned promise rejects, Express never catches it — the response hangs indefinitely. Either: (1) upgrade to Express 5 which handles async errors natively, (2) wrap all async handlers with a utility `const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next)`, or (3) add try-catch inside every async handler body. Option 2 is recommended as a single-point fix. When adding new async route handlers, always ensure errors result in a JSON response — never leave the response open.

---

### L-20260326-repo-source-unification: Any endpoint that needs "all repos" must merge config.workspaces and config.rootDirs — never rely on just one

- status: active
- category: architecture
- source: /harness:bug 2026-03-26
- branch: master

The server has two sources of repo paths: `config.workspaces[]` (directly added) and `config.rootDirs[]` (parent directories scanned for `.git/`). When building a list of repos to operate on (e.g., worktree discovery, branch listing), always merge both sources and deduplicate by path. The `GET /worktrees` endpoint only scanned `rootDirs`, making all worktrees in directly-added workspaces invisible. Extract a shared `getAllRepoPaths(config)` helper that merges both sources so new endpoints get it right by default.

---

### L-20260328-startup-gate-web-setup: When adding a web-based setup flow for a resource that had a CLI-only gate, relax the CLI gate to trust the web layer

- status: active
- category: architecture
- source: /harness:bug 2026-03-28
- branch: master

When a server startup gate (hard exit if precondition not met) is the only way to enforce a requirement (e.g., "PIN must exist"), and a web-based setup flow is later added that provides the same guarantee at the HTTP layer, the startup gate must be updated to allow the server to start without the precondition — trusting the web UI to enforce it. Otherwise the startup gate blocks the very server that would serve the setup UI. In this project, `server/index.ts` hard-exits when no `pinHash` exists and `stdin` is not a TTY, but `POST /auth/setup` + `PinGate` UI provide PIN setup through the browser. The non-TTY exit should be removed so the server can start and serve the setup page.

---

### L-20260328-service-install-preconditions: Service install commands must verify all runtime preconditions before installing — the service process cannot prompt

- status: active
- category: patterns
- source: /harness:bug 2026-03-28
- branch: master

When a CLI command installs a background service (launchd, systemd) that starts a separate process, the install path must verify all preconditions that the service process needs but cannot interactively satisfy. Background service processes have no TTY, no user interaction, and limited environment. If the server requires a configured PIN to start, the `--bg` / `install` command must either (a) ensure the PIN exists before installing, or (b) the server must be able to start without it and offer a non-interactive setup path. Never assume the background-started process will have the same capabilities as the interactive CLI session.

---

### L-20260328-svelte-runes-testability: Split .svelte.ts modules into pure .ts logic + thin .svelte.ts wrapper for node:test compatibility

- status: active
- category: testing
- source: /harness:reflect 2026-03-28
- branch: design/command-center

Svelte 5 runes (`$state`, `$derived`) are compiler macros that only work when processed by the Svelte compiler. Files with `.svelte.ts` extension cannot be compiled by `tsc` alone, so they cannot be included in `tsconfig.test.json` for `node --test` execution. When a reactive module needs unit tests, split it: put all pure logic in a plain `.ts` file (Map operations, validation, filtering), then create a thin `.svelte.ts` wrapper that imports the pure functions and adds reactivity via `$state`. Tests import from the `.ts` file; components import from the `.svelte.ts` file. This pattern was used for `registry.ts` + `registry.svelte.ts` in the action system.

---

### L-20260328-config-type-field-rename: When renaming a config field's type (e.g., string[] → Entity[]), update ALL consumers before merging — `as any` casts mask runtime type mismatches

- status: active
- category: architecture
- source: /harness:reflect 2026-03-28
- branch: design/true-workspaces

When a config field changes its type (e.g., `Config.workspaces` from `string[]` to `Workspace[]`), using `as any` casts to bypass TypeScript hides runtime breakage. Every consumer that reads the field with the old type assumption will silently receive the wrong shape at runtime — string comparisons against objects, `.startsWith()` on entity objects, `.includes()` on arrays of the wrong type. The fix agent's approach of changing the type declaration and grepping all consumers is correct, but must be verified by running `tsc --noEmit` BEFORE committing. When planning a type rename: (1) grep all files that access the field, (2) update consumers to use the correct accessor (e.g., `config.repos` for paths, `config.workspaces` for entities), (3) verify zero compile errors, THEN commit.

---

### L-20260328-serialization-whitelist-audit: When adding properties to a long-lived object, check whether it needs serialization — whitelist-based serialization silently drops new fields

- status: active
- category: architecture
- source: /harness:bug 2026-03-28
- branch: nightly

When a system uses whitelist-based serialization and manually picks fields from
a runtime object, adding a property to the runtime type does not cause a
compile error when serialization is missing. When adding any property to a
long-lived object that participates in serialization, check the serialized
type and serializer. Prefer `Pick<>` or a compile-time exhaustiveness check so
TypeScript flags the gap.

---

### L-20260328-module-level-env-eval: Module-level constants derived from `process.env` are evaluated once at import time — they cannot be overridden in tests and leak across process boundaries

- status: active
- category: testing
- source: /harness:bug 2026-03-28
- branch: nightly

If a module computes a value from `process.env` at module scope, that
expression is evaluated when the module is first imported. Tests then inherit
whatever environment was present at import time and cannot change it per case.
Either make it a function with explicit parameters, use a getter that reads the
environment on access, or ensure tests clean the environment before importing
the module.

---

### L-20260328-settings-file-recreation: When restoring a process with preserved credentials, the credential FILE must also be re-created — token preservation alone is insufficient

- status: active
- category: architecture
- source: /harness:reflect 2026-03-28
- branch: fix/hooks-403-after-restart

When a runtime reads credentials from a generated config file, preserving an
in-memory token alone is not enough: the OS may remove the file before the
runtime is recreated. A newly spawned runtime needs the config file written
again and the provider launch argument restored. Gating file creation on
“token already exists” silently leaves the new runtime unconfigured. When
preserving credentials, ask whether the consumer needs an on-disk artifact or
only the in-memory value.

---

### L-20260329-nullish-override-shadow: Never pass global defaults as explicit overrides when a server-side merge cascade exists — `false ?? true` evaluates to `false`

- status: active
- category: architecture
- source: /harness:bug 2026-03-29
- branch: nightly

When a server function uses nullish coalescing (`??`) to merge settings from multiple layers (global < workspace < repo < per-request), an explicit `false` passed as a per-request override shadows a `true` from a lower layer — because `false ?? true` is `false`. Frontend quick-launch functions should omit fields they don't have explicit user input for (send `undefined`, not the global default) so the server's cascade resolves correctly. The pattern "read global state, pass it as override" defeats the entire purpose of per-repo settings. When calling an API that resolves settings from a cascade, only include fields where the user made an explicit choice.

---

### L-20260329-settings-resolution-boundary: Session settings resolution should happen at one layer — don't pre-resolve on the frontend what the server already resolves

- status: active
- category: patterns
- source: /harness:bug 2026-03-29
- branch: nightly

When a server has a canonical settings resolution function (e.g., `resolveSessionSettings()` that merges global → workspace → repo → override), the frontend should not duplicate this logic by pre-filling overrides from its own partial view of the settings. The frontend's `configState` only has global defaults — it cannot see repo-level overrides. Sending global defaults as explicit overrides creates a shadow that the server's merge cascade cannot penetrate. Either (a) omit the fields and let the server resolve, or (b) fetch the merged settings from the server before populating UI defaults. The `fetchMergedWorkspaceSettings()` API exists for case (b).

---

### L-20260403-migration-button-completeness: Framework migrations must audit ALL interactive elements — not just the primary action buttons

- status: active
- category: patterns
- source: /harness:bug DYS-11 2026-04-03
- branch: worktree-DYS-11

When migrating a UI framework (e.g., Svelte → React), raw `<button>` elements in non-primary positions are the most likely elements to be left unconverted. The migration agent typically converts the "obvious" action buttons (PR row actions, form submits) but misses secondary buttons embedded in sub-components: error state retries, filter management delete buttons, confirmation inline actions. After any framework migration, run a grep for `<button` in all migrated component files and verify each instance either (a) uses the project's design-system button component (`TuiButton`), or (b) is an intentional pattern-exception with a CSS class that reproduces equivalent design-system styling (e.g., tab strip navigation). Bespoke CSS that re-implements button styling is a red flag — it means the component was migrated structurally but not visually.

---

### L-20260404-dialog-display-cascade: Never set `display` unconditionally on `<dialog>` elements — author CSS overrides the UA hidden state

- status: active
- category: debugging
- scope: universal
- source: /harness:bug 2026-04-04
- branch: everest-24bf

The HTML `<dialog>` element is hidden when not open via the browser's UA stylesheet: `dialog:not([open]) { display: none }`. If an author stylesheet sets `display: flex` (or `grid`, `block`, etc.) on the `<dialog>` element without qualifying with `[open]`, the author rule wins — because author stylesheets always beat UA stylesheets in the CSS cascade, regardless of specificity. The dialog content then renders in normal DOM flow even though `.showModal()` was never called. On mobile, where the main app container is `position: fixed`, the unintentionally-visible dialog paints on top of the app. Always either: (1) apply layout `display` only to `dialog[open]` or a child wrapper element, or (2) add an explicit `.dialog-class:not([open]) { display: none; }` rule alongside any `display` override.

---

### L-20260404-dialog-layout-wrapper: Apply layout properties to a child wrapper inside `<dialog>`, not the dialog element itself

- status: active
- category: architecture
- scope: universal
- source: /harness:bug 2026-04-04
- branch: everest-24bf

The `<dialog>` element has special browser-managed display semantics (hidden when not open, top-layer when modal). Setting layout properties (`display: flex`, `flex-direction`, `overflow`) directly on the `<dialog>` element risks overriding these semantics. Instead, structure dialog components as `<dialog><div class="wrapper">...</div></dialog>` and apply all layout CSS to the wrapper. The `<dialog>` element itself should only receive cosmetic properties (background, border, width, max-height) that don't interfere with the UA stylesheet's display management. This project's `WorkspaceSettingsDialog` follows this pattern correctly (`.workspace-settings-dialog-content` wrapper), while `DialogShell` applies `display: flex` directly to the `<dialog>`, causing the bug.

---

### L-20260404-dialog-visibility-test: Page-load tests should assert that no dialog content is visible without user interaction

- status: active
- category: testing
- scope: repo
- source: /harness:bug 2026-04-04
- branch: everest-24bf

When a project uses multiple `<dialog>` elements with custom CSS, add a structural test that runs after page boot and asserts: (1) `document.querySelectorAll('dialog[open]')` is empty, and (2) no dialog content is within the visible viewport. This catches CSS cascade issues where author styles accidentally override the UA's `display: none` for non-open dialogs. The test is especially important on mobile viewports where fixed-position main containers change paint order.

---

### L-20260412-gpu-feature-detection: `'gpu' in navigator` detects API availability, not rendering capability — GPU renderer selection must verify actual output

- status: active
- category: architecture
- scope: universal
- source: /harness:bug 2026-04-12
- branch: nightly

When using a GPU-accelerated renderer (WebGPU, WebGL) with a DOM fallback, the feature detection guard (`'gpu' in navigator`, `!!window.WebGLRenderingContext`) only confirms the browser exposes the API — not that the GPU can actually render the content. On mobile devices, the API may be present but the GPU pipeline silently produces no output due to driver limitations, incomplete implementations, or capability gaps. The try/catch around addon loading only catches synchronous errors, but GPU initialization is async (`requestAdapter()`, `requestDevice()`). Either: (1) gate GPU renderers on device class (skip on mobile entirely), (2) verify rendering after async init completes (e.g., canary write + pixel readback), or (3) use an async-aware fallback that waits for the init promise before committing. Never treat "addon loaded without throwing" as "rendering works."

---

### L-20260412-sync-catch-async-init: try/catch around async-initializing addons only catches constructor errors — async failures need separate handling

- status: active
- category: debugging
- scope: universal
- source: /harness:bug 2026-04-12
- branch: nightly

When a library addon has a synchronous `activate()` method that starts an async initialization internally (e.g., xterm.js WebGPU addon calls `_initializeWebgpu()` with `await requestAdapter()`), wrapping the `loadAddon()` call in try/catch gives a false sense of safety. The catch block fires for constructor errors and synchronous activate failures, but the actual initialization happens in a fire-and-forget async path. If the async init fails, no error propagates to the caller. Additionally, checking for a DOM element (`t.element`) after `t.open()` only proves the DOM was created, not that the renderer works. When using addons with async initialization: (1) check if the addon exposes a ready/error event, (2) add a post-init verification step, or (3) at minimum gate the addon on known-good environments rather than relying on the catch.

---

### L-20260412-mobile-gpu-renderer: Mobile devices should not use GPU-accelerated terminal renderers — use DOM rendering as the default

- status: active
- category: patterns
- scope: repo
- source: /harness:bug 2026-04-12
- branch: nightly

In relay-ide's Terminal.tsx, the WebGPU renderer addon should be skipped when `isMobileDevice` is true. Mobile GPU drivers have significantly less mature WebGPU support than desktop, and silent rendering failures (black canvas with working cursor) are indistinguishable from a broken terminal. The DOM renderer works reliably on all mobile browsers. When adding GPU-accelerated features that have a DOM fallback, always include a device-class check alongside the API feature detection: `if ('gpu' in navigator && !isMobileDevice)`.

---

## May 2026 — routed terminal hardening

The original work also experimented with routed public agent sessions. That
model is retired by ADR-020: public routed sessions are terminal-only, while
agents participate through channels and DMs. The transport lessons that remain
current are:

- New routed terminals use the concrete `human-driven` control mode. `unknown`
  is a stale or malformed compatibility state, not a valid create default.
- Routed Active Work invalidation scopes on the global session id
  (`node_<nodeId>:<sessionId>`), not the local `sessionId`.
- The node-link RPC host owns the “no command” fallback for routed terminals
  because a remote node cannot prompt.
- Browser detach closes the attachment stream but leaves the terminal process
  running for later reattach.
- Compare hub and node versions before diagnosing routed-terminal liveness or
  control-state failures.
- Metadata alone does not prove a routed terminal is usable; verify a bounded
  rendered frame on the real surface.
- Bounded audit summaries may cross the hub/node boundary, but raw keystrokes
  and terminal bytes stay on the source system.

---

## July 2026 — channel-workspace navigation spine (epic #1287 audit)

Consolidated from the 2026-07-29 46-agent architecture audit (5 mappers, 3 hunters, per-finding adversarial verification: 37 raw findings, 27 confirmed, 10 refuted) and the Slice 1 PRs #1288–#1291. Full verified ladder lives in epic #1287.

- L-20260729-disjoint-workspace-stores: `+ add project` (`POST /workspaces/bulk`) writes `config.repos` only, the duplicate check reads `config.repos`, and the sidebar renders `workspace_topics` + `ia_workspaces` — so "already exists" and "not in the sidebar" can both be permanently true. Before wiring any add/create surface, trace which store the reading surface renders and write that store. A one-shot boot migration is not a create path.
- L-20260729-workspace-sentinel-ids: channels minted with the literal `workspace:local` / `ws:derived` sentinels can never match real IA workspace ids (`ws:<localId>`), so 100% of channels land in the orphan lane and empty workspace groups are dropped from the tree. Validate cross-store reference id grammar at the create boundary; a sentinel that parses as "some id" poisons grouping silently downstream.
- L-20260729-topic-id-title-slug: topic/channel id WAS `slug(workspaceId + '-' + title)`. Never recompute the id on rename — `channel_messages.channel_id` keys the history and boot `sweepOrphans(listAllTopicIds())` would permanently delete the re-keyed channel's messages. RESOLVED in #1287 Slice 4: `buildWorkspaceTopicRecord` now mints an opaque ULID-shaped id (`mintWorkspaceTopicId`), so duplicate titles in one workspace are legal and renames stay display-only.
- L-20260731-opaque-identity-needs-no-migration: decoupling identity from a derived value costs nothing to grandfather IF you only stop deriving NEW ids. Existing title-slugged `workspace_topics.id` rows became opaque strings the moment nothing recomputed them — no re-key, no backfill, no boot reset, and `sweepOrphans` / `channel_messages` joins are pure set-membership on the id so both shapes behave identically. The migration cost people fear lives in the id-PARSERS, so audit those first: here the only structural readers were `dmChannelTopicId` (recomputes its own deterministic DM id) and `deriveWorkspaceTopicsFromWorkContexts` (keys off the WorkContext id, not a title) — both pass their id explicitly and were untouched. Membership must already live in a column (`workspace_id`), never in the id.
- L-20260801-conflict-must-name-its-blocker: a uniqueness error is only actionable if it names the row that blocks and the way out of it. `workspace_topics` answered "workspace topic already exists" for a row the caller usually CANNOT see — archived topics are filtered out of the default list and `list()` caps at 200 of the 500 stored — so the operator was stuck against an invisible channel. The 409 body now carries `blockingTopicId` / `blockingTopicStatus` / `blockingTopicTitle` / `remedy` (`open` | `restore`), which is also what lets `getOrCreateDmChannel` adopt the winner of a deterministic-id race instead of failing the open. Corollary: emit the conflict STATUS the rest of the codebase uses (409, `statusForCode` in `server/channel-chat-router.ts`) — `server/workspace-topics.ts` was the sole router mapping `SESSION_CONFLICT` to 400, so no client could branch on it.
- L-20260801-status-code-is-not-a-reason-code: never infer a specific failure from a bare HTTP status. `ChannelView` read any 409 on a post as "channel archived" and swapped the composer for a restore bar, but the message store also answers 409 for `channel_message_seq_conflict`, `parent_channel_mismatch` and `thread_root_channel_mismatch` — a retried send on a live channel offered to restore a channel that was never archived. Branch on the `details.reasonCode` the server already sends; the status only selects the family.
- L-20260801-navigate-before-the-write: a remedy the DESTINATION renders is unreachable if navigation is sequenced after the write that fails. `openAgentChannel` / `useTopicRoomCreate` posted the first message before `setActiveChannelId`, so an archived channel's 409 `CHANNEL_ARCHIVED` threw and the restore bar built for exactly that case never mounted — the operator got a toast about a channel the default list filters out. Open first, then write; swallow only the one rejection the destination explains (naming the remedy in a toast), and keep throwing everything else. A unit test of the resolver alone cannot catch this class — the bug lives in the caller's statement order, so drive the caller.
- L-20260801-idempotence-was-load-bearing: deriving an id from user content also silently made the create IDEMPOTENT — a retry 409'd as a no-op. Minting opaque ids removes that guard, and nothing replaces it: every retry mints a fresh row plus a fresh WorkContext, and `workspace_topics` answers its 500-row cap by DELETING the oldest ARCHIVED rows, whose `channel_messages` boot `sweepOrphans` then erases. Before dropping a derived identity, ask what ELSE that derivation guaranteed. The fix is a client-owned id reserved once per create ATTEMPT and reused across retries (released on commit or on an edited draft), so the retry lands on the self-explaining 409 and adopts the blocker. Mint it in a ref, never in a memoized builder — a memo re-runs and hands out a new id, defeating the point.
- L-20260801-one-error-class-per-wire-code: mapping a whole error TYPE onto one gateway code collapses distinct remedies. `POST /workspace-topics` mapped every `WorkspaceTopicStoreError` to `SESSION_CONFLICT`, so a full store answered 409 `retryable: false` — "pick another id and retry", the one action that cannot succeed — instead of 503 `retryable: true`. Branch on `reasonCode`, not on the error class. Same shape on the way out of a store: normalize a field at the single point every producer goes through if the parser normalizes on the way in, or the value round-trips to something the server never held (`blockingWorkspaceId` emitted raw `workspace:local`, parsed back as `ws:local`).
- L-20260729-client-derived-unread: unread state is client-derived: persisted `lastRead` (localStorage) vs live `latestSeq` (in-memory). Any in-memory half must be seeded from a list payload on mount or every page reload renders fully read. Seeding races with mark-as-read: guard stale refetch payloads with a per-channel clamp-epoch fence compared against the query's `dataUpdatedAt` (PR #1290).
- L-20260729-audit-refuter-pass: of 37 plausible audit findings with file:line evidence, 10 (~27%) were refuted by independent adversarial verification. Never file audit findings as issues without a refuter pass; record the refuted ones as no-defect notes so the next audit does not rediscover them.
- L-20260731-workspace-id-column-only: retiring a cross-store sentinel id (#1287 Slice 2, `workspace:local`/`ws:derived` → seeded `ws:local`) is a COLUMN-ONLY move. `workspace_topics.workspace_id` and the `workspaceId` inside `record_json` both migrate; `workspace_topics.id` never does. Any client-side id derivation that embedded the old sentinel — `dmChannelTopicId` slugs the workspace ref into the DM's topic id — must map every local reference (null, both sentinels, `ws:local`) onto ONE frozen segment, or the next DM open mints a new channel and boot `sweepOrphans` deletes the old transcript. The seed itself is create-if-absent on every boot, not a marker: a lost marker must never leave the hub without the workspace its create paths fall back to.
- L-20260801-fold-state-is-not-component-state: an effect that re-seeds "sensible defaults" into component state on every model change is a defect wherever the model churns identity. The chat rail re-added every `model.rootIds` entry to a local `expandedIds` set whenever the nav model changed, and `useSessionsStore` replaces its `sessions` array via `.map()` on every activity/status/branch/rename WS event — so a collapsed root sprang open within seconds of any live agent turn, and desktop rail collapse was effectively non-functional. Fix the class, not the churn: DERIVE the fold from persisted operator intent (`selectExpandedRailIds`) instead of seeding state, and let PRESENCE in the record mean "the operator has decided" while the VALUE means "what they decided" — one map replaces both an expanded set and a seen-roots ledger. Corollary: any per-mount `useState` fold (the mobile cockpit's `collapsedGroupIds`) is silently lost on reload, so it belongs in the persisted ui store; and once fold state is global, component tests must reset it between cases or one test's collapse folds the next test's rows.
