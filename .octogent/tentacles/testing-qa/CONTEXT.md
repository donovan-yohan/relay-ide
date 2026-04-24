# testing-qa

Vitest unit/integration suite, Playwright E2E suite, fixtures, helpers, annotations, pre-push strategy.

## Scope

- `vitest.config.ts` — `include: ['test/**/*.test.ts']`, `exclude: ['test/e2e/**']`, `environment: 'node'`, `testTimeout: 30_000`.
- `playwright.config.ts` — `testDir: './test/e2e'`, Chromium only, base URL `http://localhost:3456` (or `PLAYWRIGHT_PORT`), `webServer.command` boots `RELAY_IDE_PORT=… npm run start` (CI uses built `dist/server/index.js`), `reuseExistingServer: !CI`, 2 retries on CI.
- `test/` — ~99 unit + integration test files (21k+ lines), run directly through vitest (no `tsc` compile step) via `vite-node`.
- `test/actions/` — action registry + shortcut tests.
- `test/adapters/` — telemetry adapter tests.
- `test/components/` — frontend component tests (`CodeBlock`, `EmptyState`, `ErrorToast`, `SessionIndicator`, `TuiCheckbox`, `TuiInput`, `leaf-component-migration`).
- `test/stores/` — Zustand store behavior tests (`sessions-logic`, `ui-store`, `unread-store`, `boot-state-store`, `notifications-store`).
- `test/e2e/` — Playwright specs (`basic.spec.ts`, `components/`, `helpers/visual.ts`, `screenshots/`).
- `test/fixtures/mobile-input/*.json` — canonical JSON fixtures driving `test/mobile-input.test.ts` against `shared/mobile-input-pipeline.ts`. Examples: `gboard-autocorrect-cursor0`, `gboard-autocorrect-multi-word`, `ios-replacement-text`, `paste-event`, `normal-typing`.
- `test/helpers/` — shared scaffolding:
  - `test-server.ts` — boots a relay-ide instance for integration tests
  - `frontend-factories.ts` — factory helpers for SessionSummary / SidebarItem fixtures
  - `mock-fetch.ts` — `fetch` stub for network-touching suites
  - `web-chat-fixtures.ts` — canonical ChatEvent sequences
- `test/e2e/helpers/visual.ts` — Playwright visual-regression helpers.

## Key Decisions

- **Single unit/integration runner.** Vitest is the only runner for `test/` (migrated from `node:test` on 2026-04-03; ADR-005). Playwright is kept strictly for E2E under `test/e2e/`.
- **Unit/integration tests MUST NOT require a running server.** `docs/ARCHITECTURE.md` line 107. Integration tests spin up an in-process server via `test/helpers/test-server.ts`; they never assume an externally running `npm start`.
- **TypeScript sources are consumed directly.** No `tsc -p tsconfig.test.json` step — `vite-node` handles TS on the fly. Tests must therefore use `.js` import extensions like the rest of the codebase.
- **`[needs:RESOURCE]` annotations gate worktree-unsafe tests.** A test that shells out to `git init` (via `makeGitRepo` / `makeTempGitRepo`, or direct `execFileSync`/`execSync` into a temp dir) must include `[needs:git-init]` in the `it()`/`test()` name — `docs/QUALITY.md` lines 26–63. Current annotated files: `test/webhook-manager.test.ts` (7 tests), `test/branch-watcher.test.ts` (3 of 4). Future: `[needs:network]`, `[needs:docker]`.
- **Pre-push is context-aware.** `.husky/pre-push` runs `vitest run --changed` in the main tree, `--testNamePattern` excludes `[needs:git-init]` in worktrees, skips vitest entirely when no test-relevant changes. CI always runs the full suite via `npm test` in `.github/workflows/publish.yml`.
- **Test isolation patterns are explicit.** `auth.test.ts` uses `_resetForTesting()`; `sessions.test.ts` cleans up PTYs in `afterEach`; `config.test.ts` uses `fs.mkdtempSync`; `webhook-manager.test.ts` and `branch-watcher.test.ts` use a `GIT_ISOLATED_ENV` constant to strip `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR` from child processes.
- **Mobile input TDD workflow is canonical.** Red fixture first, then fix `mobile-input-pipeline.ts`, then green. The invariant is that any autocorrect event with non-null `data` must emit replacement text in the payload — never only backspaces (`docs/QUALITY.md` line 118).
- **E2E server boots via `npm run start` locally, `node dist/server/index.js` in CI.** Local runs reuse an existing server if one is bound to the Playwright port; CI always boots a fresh one.
- **Build + test both enforce types.** `npm run build && npm test` gates publishes. Frontend tsconfig adds `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`.

## Conventions

- New integration test that touches git? Use `makeGitRepo` / `makeTempGitRepo` helpers, annotate with `[needs:git-init]`, and wire `GIT_ISOLATED_ENV` into child `execFile` calls.
- New frontend test? Place alongside siblings (`test/stores/*`, `test/components/*`); use `frontend-factories.ts` helpers to construct fixtures rather than inventing shapes.
- New Playwright spec? Add under `test/e2e/components/` or at the top level; keep specs focused — use `helpers/visual.ts` for screenshot comparisons.
- Mobile keyboard regression? **Add a JSON fixture under `test/fixtures/mobile-input/` before writing any code** (CLAUDE.md + `docs/QUALITY.md`). Fixture name should describe device + intent (`gboard-autocorrect-cursor0`, not `test1`).
- Never mock the database in server tests that exercise SQL paths. If you need analytics state, use a real `better-sqlite3` instance in a temp dir (`feedback_no_guessing` project memory: mocks mask real failures).
- Single file runs: `npx vitest run test/<file>.test.ts`. Filter by name: `npx vitest run --testNamePattern '<pattern>'`.
- When a flake appears, document the resource dependency and add the matching `[needs:…]` annotation — do not silently `.skip`.

<!-- octogent:suggested-skills:start -->

## Suggested Skills

You can use these skills if you need to.

- `qa`
- `qa-only`
- `investigate`
- `browse`
- `review`
<!-- octogent:suggested-skills:end -->
