# docs-infra

Architecture/design docs, tooling config, CI/CD, release automation, package metadata, repo-level meta files.

## Scope

- **Documentation** — `docs/ARCHITECTURE.md`, `docs/DESIGN.md` (backend patterns), `DESIGN.md` (visual/TUI system, root-level), `docs/FRONTEND.md`, `docs/QUALITY.md`, `docs/LEARNINGS.md`, `docs/REVIEW_GUIDANCE.md`, `docs/WEB_CHAT.md`, `docs/risk-contract.json`.
- **Docs subdirs** — `docs/references/` (`deployment.md`, `qa-guide.md`, `review-agent-setup.md`), `docs/plans/`, `docs/bug-analyses/` (dated post-mortems).
- **Repo roots** — `CLAUDE.md` (harness map, work-tracking scheme, branching policy, gstack skills), `README.md`, `TODOS.md`, `.gitignore`.
- **TypeScript config** — `tsconfig.json` (server build), `frontend/tsconfig.json` (Vite build with strict flags), `frontend/vite.config.ts`, `vite.config.ts` (root).
- **Lint / format** — `eslint.config.js` (`js.configs.recommended` + `tseslint.configs.recommended` + `eslint-plugin-sonarjs` with `cognitive-complexity: 25`, `no-duplicate-string: 4`, `max-switch-cases: 15`, `no-console: error`, `complexity: 25`). Prettier via lint-staged (`package.json` `lint-staged` block).
- **Git hooks** — `.husky/pre-commit` (eslint + prettier via lint-staged), `.husky/pre-push` (context-aware vitest; runs only changed tests, skips `[needs:git-init]` in worktrees).
- **CI** — `.github/workflows/ci.yml`, `.github/workflows/publish.yml` (nightly auto-publish, tag-triggered stable), `.github/workflows/issue-state-automation.yml`, `.github/workflows/issue-state-on-commit.yml`.
- **Release automation** — `scripts/postinstall.js` (chmod prebuilt `node-pty` binary on macOS ARM64, auto-restart background service unless `RELAY_IDE_SKIP_SERVICE_RESTART=1`).
- **Package metadata** — `package.json`, `package-lock.json`, `bun.lockb` (coexists but npm is source-of-truth), `.nvmrc` (Node >= 24 via `engines`).

## Key Decisions

- **CLAUDE.md is a map, not a manual.** Root `CLAUDE.md` must stay under 120 lines. Project knowledge lives in `docs/*.md`. When adding details about a subsystem, update the subsystem's doc and add a row to the Documentation Map, not prose inside `CLAUDE.md`.
- **Two-branch release model.** `nightly` is the default branch and auto-publishes to `npm @nightly` on every push. `master` is protected (PR required, no force push, no deletion, admin-bypass disabled) and publishes to `@latest` only on pushed tags. Hotfixes branch off `master`, merge back, and sync to `nightly` (`docs/references/deployment.md`).
- **Version format is strict.** Stable `X.Y.Z`; nightly auto-stamped as `X.Y.Z-nightly.YYYYMMDD.N`. `npm version <level> --no-git-tag-version` on nightly, PR to master, `git tag v<version>` on master post-merge.
- **Lint rules have meaning.** Cognitive complexity 25, complexity 25, `no-console: error` — enforced so the `createLogger()` pattern stays universal. `sonarjs/no-duplicate-string` at threshold 4 flags common-string drift. `max-switch-cases: 15` pushes large switches toward table-driven dispatch.
- **Pre-push is context-aware.** `.husky/pre-push` detects git-worktree context and adapts — runs `vitest run --changed` in the main tree, `--testNamePattern` exclusion in worktrees, or exits 0 when no test-relevant files changed. Don't disable.
- **`scripts/postinstall.js` is load-bearing.** It fixes `node-pty` prebuilt permissions on macOS ARM64 (otherwise PTY sessions fail at spawn) and gracefully restarts the background service. It must NOT kill the server mid-update — when `POST /update` triggers, the server handles its own graceful restart and sets `RELAY_IDE_SKIP_SERVICE_RESTART=1`.
- **`bun.lockb` coexists with `package-lock.json`** but npm is the authoritative package manager (publishing, CI, `npm ci`). `feedback_run_npm_ci` memory: run `npm ci` before publishing to catch lockfile desync.
- **Work tracking is GitHub Issues.** Labels: `bug`/`feature`/`improvement`/`spike`, state `backlog`/`todo`, priority `p1`–`p4`, projects like `project:sidebar-nav`. Sub-issue + blocker relationships go through `gh api graphql` mutations (`addSubIssue`, `addBlockedBy`), not free-text body references (CLAUDE.md).
- **Bug analyses are dated + retained.** `docs/bug-analyses/YYYY-MM-DD-<slug>-bug-analysis.md` format; listed in `docs/bug-analyses/index.md`. Post-mortem lives forever; don't purge after fix.

## Conventions

- **Updating CLAUDE.md?** Invoke the `claude-md-management:revise-claude-md` skill — do NOT edit the file directly (user's global instructions).
- Adding a doc? Put it under `docs/`, add a row to the Documentation Map in `CLAUDE.md`, and use lowercase-hyphenated filenames.
- Version bump: `npm version patch|minor|major --no-git-tag-version` on `nightly` branch, commit, push, PR to `master`, merge, `git tag v<version>` on `master`, `git push origin v<version>`, then merge master back to nightly.
- Never push directly to `master` or bypass branch protection. Never use `--no-verify` to skip hooks (CLAUDE.md safety rules) unless the user explicitly requests it.
- CI workflow edits require testing via a throwaway branch PR — `.github/workflows/publish.yml` is critical path.
- Keep eslint/prettier opinions centralized in `eslint.config.js` + `.prettierrc`; avoid per-file disables except with a one-line justification comment.
- When touching pre-existing eslint violations in a file, fix them rather than leaving them behind (`feedback_eslint_ownership` memory).

<!-- octogent:suggested-skills:start -->

## Suggested Skills

You can use these skills if you need to.

- `ship`
- `land-and-deploy`
- `document-release`
- `review`
- `retro`
<!-- octogent:suggested-skills:end -->
