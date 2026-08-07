# Review Guidance

## Deployment Context

- **Package type:** npm package (NOT a web app)
- **Publishing:** Automated via GitHub Actions on `v*` tag push to `master`
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

## Escape Log

_No escapes recorded yet._
