# Review Guidance

## Deployment Context

- **Package type:** npm package (NOT a web app)
- **Publishing:** Automated via GitHub Actions on `v*` tag push to `master` (`vX.Y.Z` → `latest`, `vX.Y.Z-rc.N` → `rc`); every push to `nightly` → `nightly`
- **Workflow:** `npm version <type>` → `git push && git push --tags` → CI publishes
- **Node requirement:** >= 24.0.0 (`.nvmrc` present — run `nvm use` before testing)

## Review Agent Setup

The `/review` and `/ship` workflows use `docs/risk-contract.json` to select the review provider:

- `"provider": "default"` — spawns the `pr:review` subagent directly (no external service needed)
- `"provider": "greptile"` — waits for the `Greptile Code Review` check run on the head SHA
- `"provider": "coderabbit"` — waits for the `CodeRabbit Review` check run on the head SHA
- `"provider": "custom"` — waits for a configurable check run name

See `docs/references/review-agent-setup.md` for full config field reference.

## Review Question Bank

### Architecture

- Does this change respect the one-concern-per-module boundary? (58 server modules, each owning a single concern)
- If a new server module is added, is the module count updated in `ARCHITECTURE.md` and the ADRs?
- Does cross-module dependency flow downward? (`index.ts` is the composition root — no other module may import it)
- Does this maintain TypeScript + ESM conventions (`.js` extensions on relative imports, `node:` prefix on builtins)?
- Are new npm dependencies confined to the single module that owns them (e.g., only `pty-handler.ts` depends on `node-pty`)?
- Does `output-parsers/` only import from `types.ts` — not from `utils.ts` or any other server module?

### Security

- Is the PIN auth flow preserved correctly? (`auth.ts` owns scrypt hashing and rate limiting — 5 fails = 15-min lockout)
- Are provider-runtime environment variables properly sanitized?
  (`CLAUDECODE` must be stripped before Relay starts a private Claude channel
  runtime from a Claude-hosted development environment.)
- Are WebSocket connections properly authenticated before PTY I/O is relayed?
- Are `hooks.ts` endpoints still localhost-only with per-session token auth?
- For capability/ACL changes, are node manifests treated only as availability/probe data while hub ACL state remains authoritative for grants?
- Do unknown capability bits fail closed, including values loaded from persisted JSON?
- Do trust-tier overlays preserve or tighten policy only, especially `prod` moving high-risk allowed bits to confirmation instead of silent allow?
- Are legacy, null, or malformed ACL records migrated to persisted least-privilege defaults instead of normalized only in memory?
- Are ACL identity fields pinned to the trusted node registry record rather than accepted from stored ACL JSON?

### Frontend

- Does this follow React 19 + Zustand patterns? (selector hooks from Zustand stores, `useMemo`/`useCallback` at re-render boundaries — not legacy Svelte runes)
- Does `useEffect` avoid depending on unstable TanStack Query result references (e.g., the whole `useQuery` return value or freshly-cloned `data`) in its dep array? Prefer depending on stable primitives or memoized selections. (See `docs/bug-analyses/2026-03-23-pr-query-infinite-loop-bug-analysis.md` for the historical Svelte-era repro.)
- Are mobile touch and scroll behaviors tested? (see `test/fixtures/mobile-input/` fixture pattern)
- Is the scrollback buffer cap (256KB FIFO per session) respected in any PTY or buffer changes?
- Do dropdown/overlay elements avoid CSS `transform` on containing blocks?
  Transformed ancestors change fixed-position containing blocks.

### Testing

- Are new server modules accompanied by test files in `test/`?
- Do mobile input changes include fixture-based tests in `test/fixtures/mobile-input/`?
- Does `npm test` pass cleanly? (runs `vitest run` — `node-pty` is a native addon and may compile if no compatible prebuild is available; `postinstall` fixes macOS ARM64 `spawn-helper` permissions)
- Does `npm run build` succeed? (`node-pty` is a native addon and may compile if no compatible prebuild is available; `postinstall` fixes macOS ARM64 `spawn-helper` permissions)

## Release Hygiene

Checked at review time, not when the tag is cut. The PR template
(`.github/pull_request_template.md`) carries the author-side version, and
`.github/workflows/changelog.yml` enforces the first bullet on any PR touching
`server/`, `frontend/`, or `shared/`. The rest are review judgement — CI can see
that an entry exists, not whether it is honest or readable.

- Is there a `CHANGELOG.md` `[Unreleased]` entry, or does the PR explicitly state "no user-visible change"? Internal refactors, test-only work, and CI plumbing may decline — silence may not. A PR that took the label or body escape hatch while shipping user-visible behavior is a review finding, not a passing check.
- Is the entry honest about what landed on this head? Right group (Added / Changed / Fixed / Removed), no claims the diff does not support, issue or PR number attached.
- For feature PRs, does the entry read like a release note — user-visible behavior in the product vocabulary — not implementation? "Channel search jumps to the matching message" beats "add an FTS5 index to the messages table".
- Are docs named or declined? The PR should say which of `AGENTS.md`, `docs/*.md`, or `DESIGN.md` it touched, or state "none needed".
- On a version-bump PR, is `[Unreleased]` drained into a dated section for the new version? CI resolves that section as the GitHub Release body before it builds and fails the tag run if it is missing, so a bump without a drain costs a deleted tag and a re-cut.

## Escape Log

_No escapes recorded yet._
