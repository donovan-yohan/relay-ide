# Quality

Testing patterns and quality standards for Relay IDE.

## Current State

- vitest (^4.1.2) as test runner, configured in `vitest.config.ts`
- TypeScript test files in `test/`, run directly via vitest (no compilation step)
- 82 unit/integration test files covering server modules and frontend utilities
- React 19 frontend with TypeScript strict mode
- E2E tests (Playwright) in `test/e2e/` are excluded from `npm test` and run separately
- Pre-push hook (`.husky/pre-push`) runs only changed tests via `vitest run --changed`
- Pre-commit hook: husky + lint-staged (eslint + prettier)

## Commands

```bash
npm test                                    # Run all unit/integration tests (vitest)
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

## E2E Testing

Playwright component tests live in `test/e2e/`. They are excluded from `npm test` via `vitest.config.ts` (`exclude: ['test/e2e/**']`) and run separately.

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
