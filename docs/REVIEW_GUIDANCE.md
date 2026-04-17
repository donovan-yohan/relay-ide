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

- Does this change respect the one-concern-per-module boundary? (27 server modules, each owning a single concern)
- If a new server module is added, is the module count updated in `ARCHITECTURE.md` and the ADRs?
- Does cross-module dependency flow downward? (`index.ts` is the composition root — no other module may import it)
- Does this maintain TypeScript + ESM conventions (`.js` extensions on relative imports, `node:` prefix on builtins)?
- Are new npm dependencies confined to the single module that owns them (e.g., only `pty-handler.ts` depends on `node-pty`)?
- Does `output-parsers/` only import from `types.ts` — not from `utils.ts` or any other server module?

### Security

- Is the PIN auth flow preserved correctly? (`auth.ts` owns scrypt hashing and rate limiting — 5 fails = 15-min lockout)
- Are PTY environment variables properly sanitized? (`CLAUDECODE` env var must be stripped to allow nesting Claude sessions)
- Are WebSocket connections properly authenticated before PTY I/O is relayed?
- Are `hooks.ts` endpoints still localhost-only with per-session token auth?

### Frontend

- Does this follow React 19 + Zustand patterns? (selector hooks from Zustand stores, `useMemo`/`useCallback` at re-render boundaries — not legacy Svelte runes)
- Does `useEffect` avoid reading TanStack Query reactive proxies inside its dep array? (see `docs/bug-analyses/2026-03-23-pr-query-infinite-loop-bug-analysis.md` — the historical Svelte-era repro)
- Are mobile touch and scroll behaviors tested? (see `test/fixtures/mobile-input/` fixture pattern)
- Is the scrollback buffer cap (256KB FIFO per session) respected in any PTY or buffer changes?
- Do dropdown/overlay elements avoid CSS `transform` on containing blocks? (breaks fixed positioning — see `2026-03-19-dropdown-and-tmux-resume-bug-analysis.md`)

### Testing

- Are new server modules accompanied by test files in `test/`?
- Do mobile input changes include fixture-based tests in `test/fixtures/mobile-input/`?
- Does `npm test` pass cleanly? (runs `tsc` + `node --test`)
- Does `npm run build` succeed? (`node-pty` requires native compilation — `postinstall` script handles macOS prebuilt binaries)

## Escape Log

_No escapes recorded yet._
