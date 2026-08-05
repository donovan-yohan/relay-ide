# Quality

Testing patterns and quality standards for Relay IDE.

## Current State

- vitest (^4.1.2) as test runner, configured in `vitest.config.ts`
- TypeScript test files in `test/`, run directly via vitest (no compilation step)
- 99 unit/integration test files covering server modules and frontend utilities
- React 19 frontend with TypeScript strict mode
- E2E tests (Playwright) in `test/e2e/` are excluded from `npm test` and run separately; their fixture-page targets are gated (see [Fixture-page contract](#fixture-page-contract-gated))
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
npm run check                               # Type check everything (tsc)
```

## Type Checking

TypeScript strict mode covers the full codebase via `tsc`. Both `build` and `test` fail on type errors. CI runs both via `npm run build && npm test`, ensuring no code with type errors can be published.

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

Full suite always runs in CI (`npm test` in `.github/workflows/publish.yml`).

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

Playwright component tests live in `test/e2e/`. They are excluded from `npm test` via `vitest.config.ts` (`exclude: ['test/e2e/**']`) and run separately.

### Fixture-page contract (gated)

A spec that navigates to `/test-<name>.html` only executes if `frontend/test-<name>.html` exists **and** is registered as a Rollup input in `frontend/vite.config.ts` (`includeE2eFixtures`). If either is false the navigation 404s, every later assertion is skipped, and the spec reports green while covering nothing.

That is enforced, not just documented:

| Where                                         | What fails                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `test/playwright-fixture-target-gate.test.ts` | `npm test` (required CI job) — any spec target that is missing or unregistered |
| `test/e2e/global-setup.ts`                    | `npm run test:e2e` aborts before launching a browser                           |

Both read `test/e2e/fixture-targets.ts`. The gate is bidirectional: a registered fixture page that no spec navigates to also fails, so dead pages cannot accumulate in the build.

Adding an e2e spec therefore means adding **three** things: the spec, `frontend/test-<name>.html` + its entry module, and the `buildInputs` line in `frontend/vite.config.ts`.

### The #1299 audit (2026-08-05)

56 of 69 specs pointed at fixture pages that had never existed, so they had never run a single assertion. `test/e2e/` was swept against the live channel-era app: **kept 12 / rewritten 0 / deleted 57.**

Rewrites were deliberately not attempted. Re-pointing a stale component spec at a surface it was not written for produces a test that asserts the wrong thing, and a wrong test is worse than no test — the flows below are recorded as gaps instead.

**Kept (12)** — target resolves and the spec runs:

| Spec                                              | Target                                |
| ------------------------------------------------- | ------------------------------------- |
| `basic.spec.ts`, `components/CipherText.spec.tsx` | `/` (the app itself)                  |
| `channel-thread.spec.ts`                          | `test-channel-thread.html`            |
| `channel-timeline-scroll.spec.ts`                 | `test-channel-timeline.html`          |
| `mobile-cockpit.spec.ts`                          | `test-mobile-cockpit.html`            |
| `sidebar-mechanics.spec.ts`                       | `test-sidebar-mechanics.html`         |
| `components/CustomizeSessionDialog.spec.ts`       | `test-customize-session-dialog.html`  |
| `components/EnvPickerDialog.spec.ts`              | `test-env-picker-dialog.html`         |
| `components/FullPageDiff.spec.ts`                 | `test-full-page-diff.html`            |
| `components/PrRow.spec.ts`                        | `test-pr-row-long.html`               |
| `components/Terminal.spec.ts`                     | `test-terminal.html`                  |
| `components/UtilityRailBranchPanel.spec.ts`       | `test-utility-rail-branch-panel.html` |

**Deleted (57)**, grouped by why:

_(a) Dead surface — the component module has no importer left in the app, or is gone entirely. Nothing to re-cover (11):_
`ChangedFiles`, `FilterChipBar`, `MobileInput`, `PickerResultRow`, `PrGlyph`, `SessionIndicator`, `SessionItem`, `ShortcutHint`, `StatusMappingModal`, `TuiRow`, `WorkspaceItem` (module deleted from the tree). The mobile-input _pipeline_ keeps its own coverage via `test/mobile-input.test.ts` and `test/fixtures/mobile-input/`.

_(b) Live surface, behaviour already covered by a vitest test that imports the same module (18):_
`BranchSwitcher`, `PrTopBar`, `RenameWarningModal`, `TargetBranchSwitcher` → `test/pr-top-bar-action.test.ts`; `CommandPalette` → `test/command-palette-*.test.ts`; `DeleteWorktreeDialog` → `test/workspace-lifecycle-registry.test.ts`; `DialogShell` → `test/customize-session-dialog-*.test.ts`; `DiffFileSidebar`, `DiffSourceToggle`, `DiffViewer` → `test/components/UtilityRailReviewPanel.test.ts`; `FilePicker` → `test/components/FilePicker.test.ts`; `FileTreeSidebar` → `test/components/FileTree.test.ts` + `file-tree-remote.test.ts`; `RepoDashboard`, `TicketsPanel`, `TuiProgress` → `test/repo-dashboard-tickets-flow.test.ts`; `SearchableSelect` → `test/components/SettingsAgentProfilesSection.test.ts`; `TuiButton` → `test/components/Tooltip.test.ts`; `WorkspaceEditor` → `test/workspace-editor-validation.test.ts`.

_(c) Live surface with no behavioural coverage — deleted because the spec never ran, and recorded here as a real gap (28):_
`AgentBadge`, `AnalyticsDashboard`, `BootScreen`, `ContextMenu`, `DataTable`, `GitHubIntegration`, `ImageToast`, `IntegrationRow`, `JiraIntegration`, `MarqueeText`, `MobileHeader`, `OpenPicker`, `OrgDashboard`, `PinGate`, `PinInput`, `SessionDetail`, `SettingRow`, `SettingsDialog`, `SettingsToc`, `Sidebar`, `StatusDot`, `TicketCard`, `Toolbar`, `TuiMenuItem`, `TuiMenuPanel`, `UpdateToast`, `WebhookIntegration`, `WorkspaceSettingsDialog`.

Note that `test/components/leaf-component-migration.test.ts` names several group-(c) components. It asserts the file exists and exports the expected symbols — structural, not behavioural — so it is not counted as coverage here. `AddWorkspaceDialog` was the same class of gap; #1298 closed it with `test/components/AddWorkspaceDialog.test.ts`, which drives the real dialog (host picker, folder browser, submit) against a mocked `POST /workspaces/bulk` and pins the add-project outcomes the pure `resolveBulkAddLanes` unit test cannot reach — most importantly the refresh-vs-reveal split, where an archived-only add must still call `onWorkspacesAdded`, with an empty array.

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
