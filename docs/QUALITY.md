# Quality

Testing patterns and quality standards for Relay IDE.

## Current State

- vitest (^4.1.2) as test runner, configured in `vitest.config.ts`
- TypeScript test files in `test/`, run directly via vitest (no compilation step)
- The unit/integration suite is the bulk of coverage: several hundred `*.test.ts`
  files across server modules, shared protocol code, and frontend utilities.
  Deliberately not counted here — a hard number rots within a week.
- React 19 frontend with TypeScript strict mode
- E2E tests (Playwright) in `test/e2e/` are excluded from `npm test`
  (`exclude: ['test/e2e/**']`) and run through their own CI job; their
  fixture-page targets are gated (see
  [Fixture-page contract](#fixture-page-contract-gated))
- Pre-push hook (`.husky/pre-push`) runs only changed tests via `vitest run --changed`
- Pre-commit hook: husky + lint-staged (eslint + prettier)

## Commands

```bash
npm test                                    # Run all unit/integration tests (vitest)
npm run test:smoke:multi-node              # Canonical hub + two-node PTY smoke harness
npx vitest run                              # Same as npm test
npx vitest run test/auth.test.ts            # Run a single test file
npx vitest run --changed HEAD~1             # Run only tests affected by recent changes
npx vitest run --testNamePattern 'pattern'  # Run tests matching a name pattern
npm run build                               # Build server + frontend
npm run check                               # tsc (server) + tsc (frontend) + tsc (test) + eslint .
```

`npm run check` is four gates, not one:
`tsc --noEmit && tsc --noEmit -p frontend/tsconfig.json && npm run typecheck:test && npm run lint`.
A lint failure fails `check` even when types are clean.

## Type Checking

TypeScript strict mode covers the full codebase via `tsc`, across three projects: the server/root config, `frontend/tsconfig.json`, and `test/tsconfig.json`. Both `build` and `test` fail on type errors, and the `ci` job runs `npm run check` before `npm run build`, so no code with type errors can be merged or published.

`frontend/tsconfig.json` strict flags: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`, `skipLibCheck`.

## Test Annotations

Tests that depend on specific environment resources use `[needs:RESOURCE]` annotations in their test names. This allows the pre-push hook to selectively exclude tests that can't run in certain contexts (e.g., git worktrees).

### Convention

A test gets a `[needs:RESOURCE]` annotation when it depends on an environment resource that may not be available in all execution contexts. The annotation goes in the `it()` / `test()` name, not in `describe()` blocks, because vitest's `--testNamePattern` matches the full test name including the describe prefix.

### Current Annotations

**`[needs:git-init]`** ... test creates a throwaway git repo via `git init` in a temp directory. These tests break in git worktree contexts because `GIT_DIR` leaks from the parent environment.

| File                           | Annotated tests                                           | Helper            |
| ------------------------------ | --------------------------------------------------------- | ----------------- |
| `test/webhook-manager.test.ts` | 7 tests (POST /repos, POST /repos/remove, POST /backfill) | `makeGitRepo`     |
| `test/branch-watcher.test.ts`  | 3 of 4 tests (all except `closes cleanly`)                | `makeTempGitRepo` |

**Criteria:** A test gets `[needs:git-init]` if it calls `makeGitRepo`, `makeTempGitRepo`, or directly invokes `execFileSync`/`execSync` with any git command targeting a temp directory.

### Future Annotations

The pattern extends to other environment dependencies as needed:

- `[needs:network]` ... test requires network access
- `[needs:docker]` ... test requires a running Docker daemon

### Pre-Push Behavior

The `.husky/pre-push` hook detects git worktree context and adapts:

- **Main tree:** runs changed tests only (`vitest run --changed`)
- **Worktree:** runs changed tests, excluding `[needs:git-init]` tests via `--testNamePattern`
- **No test-related changes:** skips vitest entirely (exits 0)

## Required gates

Pull requests into `nightly` or `master` must pass three workflows. Drafts are
skipped.

| Gate        | Workflow                          | What it runs                                                                                                             |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ci`        | `.github/workflows/ci.yml`        | `npm run check` → `npm run build` → eslint on files changed vs. the base ref → `npm test`                                |
| `e2e`       | `.github/workflows/ci.yml`        | `needs: ci`. Builds with `RELAY_IDE_E2E_FIXTURES=1` and runs `playwright test --grep smoke` on the hosted Chrome channel |
| `changelog` | `.github/workflows/changelog.yml` | Fails a PR touching `server/`, `frontend/`, or `shared/` without a `CHANGELOG.md` `[Unreleased]` entry                   |

The `e2e` job is conditional: it detects changed files against the base ref and
no-ops successfully when the diff is docs/markdown-only. Any other change makes
it required.

`.github/workflows/publish.yml` is the publish lane (tags and `nightly` pushes),
not the PR gate. It is not what proves a pull request.

## Test Isolation Patterns

- `auth.test.ts` uses `_resetForTesting()` export from `auth.ts` for fresh rate-limit state
- `sessions.test.ts` cleans up spawned PTY processes in `afterEach` hooks
- `config.test.ts` uses temporary directories (`fs.mkdtempSync`) and cleans up between tests
- `service.test.ts` `isInstalled` test is environment-dependent, may fail when launchd service is actually installed
- `pull-requests.test.ts` tests type construction only, no `gh` CLI calls or runtime dependencies
- `webhook-manager.test.ts` and `branch-watcher.test.ts` use `GIT_ISOLATED_ENV` constant to strip `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_COMMON_DIR` from child git processes

## Security Policy Tests

- Assert forbidden capabilities one by one with individual `not.toContain(...)` checks. Avoid negated `arrayContaining([...])` for deny-list/default-deny coverage; it only proves the full set is absent.
- Persisted policy migration tests should cover missing, explicit `null`, malformed object, unknown-bit, and identity-drift ACL records, then verify the repaired least-privilege ACL is written back to disk.
- Keep manifest-vs-ACL separation covered: changing node-reported availability/probe data must not change hub ACL grants.

## E2E Testing

Playwright component tests live in `test/e2e/`. They are excluded from `npm test` via `vitest.config.ts` (`exclude: ['test/e2e/**']`) and run in the dedicated `e2e` job described under Required gates — conditional on the diff touching something other than docs/markdown.

### Fixture-page contract (gated)

A spec that navigates to `/test-<name>.html` only executes if `frontend/test-<name>.html` exists **and** is registered as a Rollup input in `frontend/vite.config.ts` (`includeE2eFixtures`). If either is false the navigation 404s, every later assertion is skipped, and the spec reports green while covering nothing.

That is enforced, not just documented:

| Where                                         | What fails                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `test/playwright-fixture-target-gate.test.ts` | `npm test` (required CI job) — any spec target that is missing or unregistered |
| `test/e2e/global-setup.ts`                    | `npm run test:e2e` aborts before launching a browser                           |

Both read `test/e2e/fixture-targets.ts`. The rule is **positive**, and it covers every `.ts`/`.tsx` file under `test/e2e/`, not only `*.spec.ts`:

- every `.goto()` argument must be a static path that resolves — the app root or a built fixture page. A dynamic argument (`` `/${FIXTURE}.html` ``) is reported as an unverifiable target, not skipped.
- every spec must end up with at least one recognised target, counting the `test/e2e/` helpers it imports. A spec that navigates nowhere fails instead of passing silently.
- a registered fixture page that no spec navigates to also fails, so dead pages cannot accumulate in the build.

The positive form is the point. The first version matched literal `/test-*.html` substrings inside spec files, and review broke it three ways in one sitting: hoist the page name into a `const`, move the navigation into a helper (helpers were not scanned), or name the page something that does not start with `test-`. Each produced a spec with zero recognised targets, and zero targets meant "nothing to check" — the exact recurrence the gate exists to prevent. All three are pinned as failing cases in the gate's own test.

### Config isolation (enforced)

The fixture web-server runs against a **run-scoped temp config dir**, never the shared root a deployed hub owns. `test/e2e/isolated-config.ts` mints `"$TMPDIR"/relay-ide-e2e-*/config.json` and `playwright.config.ts` passes it as `RELAY_IDE_CONFIG`.

There is no fallback, on any side:

| Where                                               | What fails                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `playwright.config.ts` (web-server launch)          | an inherited `RELAY_IDE_CONFIG` that is not itself a run-scoped `relay-ide-e2e-*` dir     |
| `test/e2e/global-setup.ts`                          | a server already listening on the e2e port whose `/healthz` reports a different config    |
| `server/index.ts` (boot, `RELAY_IDE_E2E_FIXTURES=1`) | a missing, relative, or shared-root config — the server exits 1 before reading anything   |
| `test/e2e-fixture-config-isolation.test.ts`         | `npm test` (required CI job), including the built server's boot refusal                   |

Three properties are worth stating exactly, because the looser versions read the same and are not the same thing:

- **An inherited `RELAY_IDE_CONFIG` is validated, never trusted.** It must be outside every shared root *and* run-scoped — a `relay-ide-e2e-*` directory under `$TMPDIR`. "Not under `~/.config/relay-ide`" was the old rule and it was too weak: `RELAY_IDE_CONFIG=/srv/relay/hub/config.json` exported in a shell passed it and got exactly the silent override #1214 was about, one directory over.
- **The temp dir is minted lazily and removed by `globalTeardown`.** `--list`, `--ui`, and `--debug` never start a server and no longer create one; abandoned runs leave a dir behind, and the next mint sweeps `relay-ide-e2e-*` dirs older than a day.
- **The default port `3466` is not the safeguard.** It avoids the installed hub's `3456`, but `reuseExistingServer` still adopts whatever is listening. `global-setup.ts` probes `/healthz` and refuses any server that does not report this run's config path — the fixture server publishes `fixtureConfigPath` there in fixture mode only. CI does not set `RELAY_IDE_PORT`; the harness owns the port.

Both the harness and the server call `findFixtureConfigIsolationViolation` in `server/runtime-state-paths.ts`, which treats the XDG root *and* the hardcoded `~/.config/relay-ide` root as off-limits (`server/service.ts` ignores XDG, so checking one root leaves the other reachable).

This is #1214: before it, the fixture server inherited the default config resolution. Once a deploy put a PIN in the shared config, every smoke test failed on an unlock screen, and runs that "passed" had only recycled a PIN-less server started before the deploy. Never work around it by pointing `RELAY_IDE_CONFIG` at a hub's config; a per-run temp dir is the only supported value.

Adding an e2e spec therefore means adding **three** things: the spec, `frontend/test-<name>.html` + its entry module, and the `buildInputs` line in `frontend/vite.config.ts`.

### The #1299 audit (2026-08-05)

57 of 69 specs pointed at fixture pages that had never existed, so they had never run a single assertion. `test/e2e/` was swept against the live channel-era app: **kept 11 / rewritten 0 / deleted 58.**

Rewrites were deliberately not attempted. Re-pointing a stale component spec at a surface it was not written for produces a test that asserts the wrong thing, and a wrong test is worse than no test — the flows below are recorded as gaps instead.

**Kept (11)** — target resolves *and the suite goes green*:

| Spec                                        | Target                                |
| --------------------------------------------- | ---------------------------------------- |
| `basic.spec.ts`                             | `/` (the app itself)                  |
| `channel-thread.spec.ts`                    | `test-channel-thread.html`            |
| `channel-timeline-scroll.spec.ts`           | `test-channel-timeline.html`          |
| `mobile-cockpit.spec.ts`                    | `test-mobile-cockpit.html`            |
| `sidebar-mechanics.spec.ts`                 | `test-sidebar-mechanics.html`         |
| `components/CustomizeSessionDialog.spec.ts` | `test-customize-session-dialog.html`  |
| `components/EnvPickerDialog.spec.ts`        | `test-env-picker-dialog.html`         |
| `components/FullPageDiff.spec.ts`           | `test-full-page-diff.html`            |
| `components/PrRow.spec.ts`                  | `test-pr-row-long.html`               |
| `components/Terminal.spec.ts`               | `test-terminal.html`                  |
| `components/UtilityRailBranchPanel.spec.ts` | `test-utility-rail-branch-panel.html` |

"Target resolves" was the original claim and it was not enough — running the suite found three ways a resolvable target still fails:

- `components/CustomizeSessionDialog.spec.ts` (12 tests) threw `No QueryClient set` on load, so every test timed out waiting for a button the page never rendered. Fixed by wrapping the fixture harness in `QueryClientProvider`.
- `basic.spec.ts`'s four `visual regression` screenshots had never had a baseline committed. `test/e2e/basic.spec.ts-snapshots/*-chromium-linux.png` now exists.
- `mobile-cockpit.spec.ts`'s roster pending-inbox test cannot pass: `TopicSidebarShell` builds `rosterAttentionBySessionKey` as a literal `{}` and never fills it, so `pendingInboxCount` is always `0`. Marked `test.fixme` rather than deleted — the assertion is the record of the product gap.

**Deleted (58)**, grouped by why. The list below is generated from `test/e2e-sweep-ledger.ts`, which `test/e2e-sweep-ledger.test.ts` checks against the real import graph — including cutting `vi.mock`ed edges, which is how three wrong "already covered" credits were caught. Counts here are asserted against that ledger, so this table cannot drift from it.

_(a) Dead surface — the component module has no importer left in the app, or is gone entirely. Nothing to re-cover (12):_
`ChangedFiles`, `FileTreeSidebar` (no such module; the surviving `FileTree` emits none of the `.file-tree-sidebar__*` classes the spec asserted), `FilterChipBar`, `MobileInput`, `PickerResultRow`, `PrGlyph`, `SessionIndicator`, `SessionItem`, `ShortcutHint`, `StatusMappingModal`, `TuiRow`, `WorkspaceItem` (module deleted from the tree). The mobile-input _pipeline_ keeps its own coverage via `test/mobile-input.test.ts` and `test/fixtures/mobile-input/`.

_(b) Live surface, still loaded for real by a vitest test that imports the same module (13):_
`CommandPalette` → `test/command-palette-message-search.test.ts`; `DeleteWorktreeDialog`, `WorkspaceEditor` → `test/workspace-lifecycle-registry.test.ts`; `DialogShell` → `test/components/AddWorkspaceDialog.test.ts`; `DiffFileSidebar`, `DiffSourceToggle` → `test/components/UtilityRailReviewPanel.test.ts`; `DiffViewer` → `test/components/file-surface-parity.test.ts`; `FilePicker` → `test/components/FilePicker.test.ts`; `PrTopBar` → `test/pr-top-bar-action.test.ts`; `RepoDashboard` → `test/repo-dashboard-tickets-flow.test.ts`; `SearchableSelect` → `test/components/SettingsAgentProfilesSection.test.ts`; `TuiButton` → `test/components/Tooltip.test.ts`; `TuiProgress` → `test/components/channel-timeline-presence.test.ts`.

_(c) Live surface with no behavioural coverage — deleted because the spec never ran, and recorded here as a real gap (33):_
`AgentBadge`, `AnalyticsDashboard`, `BootScreen`, `BranchSwitcher`, `CipherText`, `ContextMenu`, `DataTable`, `GitHubIntegration`, `ImageToast`, `IntegrationRow`, `JiraIntegration`, `MarqueeText`, `MobileHeader`, `OpenPicker`, `OrgDashboard`, `PinGate`, `PinInput`, `RenameWarningModal`, `SessionDetail`, `SettingRow`, `SettingsDialog`, `SettingsToc`, `Sidebar`, `StatusDot`, `TargetBranchSwitcher`, `TicketCard`, `TicketsPanel`, `Toolbar`, `TuiMenuItem`, `TuiMenuPanel`, `UpdateToast`, `WebhookIntegration`, `WorkspaceSettingsDialog`.

Four of those started in group (b) and moved here when the check went in: `test/pr-top-bar-action.test.ts` `vi.mock`s `BranchSwitcher`, `TargetBranchSwitcher`, and `RenameWarningModal` away, and `test/repo-dashboard-tickets-flow.test.ts` does the same to `TicketsPanel`. Crediting a suite that replaces the module with a stub is the same failure mode as a spec pointed at a page that does not exist, one layer up. `CipherText` is here for a different reason: its spec asserted `.cipher-text` at `/`, where only the transient `BootScreen` renders it, and 2 of its 5 tests failed on a real run.

Note that `test/components/leaf-component-migration.test.ts` names several group-(c) components. It asserts the file exists and exports the expected symbols — structural, not behavioural — so it is not counted as coverage here, and the ledger test rejects it as a credit. `AddWorkspaceDialog` was the same class of gap; #1298 closed it with `test/components/AddWorkspaceDialog.test.ts`, which drives the real dialog (host picker, folder browser, submit) against a mocked `POST /workspaces/bulk` and pins the add-project outcomes the pure `resolveBulkAddLanes` unit test cannot reach — most importantly the refresh-vs-reveal split, where an archived-only add must still call `onWorkspacesAdded`, with an empty array. The remote lane is covered too: selecting a node swaps the folder browser for a cwd input, and submitting calls `createTerminalSession` and reports `failed to create remote terminal: ...` rather than the project-registry copy.

Also removed in the sweep: `test/e2e/helpers/visual.ts` (no spec imported it), the snapshot directories of the deleted specs, and `frontend/test-environment-picker.html` + `frontend/src/test-environment-picker.tsx` (a built fixture page no spec navigated to — the inverse of the same rot).

For local/devbox smoke runs, prefer a system browser instead of Playwright's
downloaded browser cache. On Debian-based devboxes install Chromium once, then
point Playwright at it:

```bash
sudo apt-get update && sudo apt-get install -y chromium
PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e -- --grep smoke
```

GitHub-hosted CI uses the preinstalled Chrome channel. Avoid putting
`npx playwright install --with-deps chromium` in the required smoke gate unless a
runner image truly lacks a browser; browser provisioning has previously wedged
after download and blocked unrelated PRs.

## Mobile Input Testing

The mobile input event-intent pipeline is extracted into `shared/mobile-input-pipeline.ts` and tested via JSON event fixtures.

**Test file:** `test/mobile-input.test.ts`
**Fixtures:** `test/fixtures/mobile-input/*.json`

**Workflow for mobile keyboard bug fixes:**

1. Create a fixture JSON in `test/fixtures/mobile-input/` reproducing the event sequence that triggers the bug
2. Run `npm test` ... the new fixture should fail (TDD red)
3. Fix the pipeline logic in `shared/mobile-input-pipeline.ts`
4. Run `npm test` ... all fixtures should pass (TDD green)

**Fixture format:**

```json
{
  "name": "descriptive-name",
  "description": "What this tests",
  "device": "android-chrome-gboard",
  "events": [
    {
      "inputType": "insertText",
      "data": "the",
      "rangeStart": 0,
      "rangeEnd": 3,
      "valueBefore": "teh",
      "cursorBefore": 3,
      "valueAfter": "the"
    }
  ],
  "expectedPayload": "\u007f\u007f\u007fthe"
}
```

**Critical invariant:** When an autocorrect event carries replacement text (`data` is non-null), the payload must always include that text, never only backspaces.

## See Also

- [Architecture](ARCHITECTURE.md) ... module structure and invariants
- [Design](DESIGN.md) ... backend patterns and conventions
