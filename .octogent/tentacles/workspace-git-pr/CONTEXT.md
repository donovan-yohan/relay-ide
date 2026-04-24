# workspace-git-pr

Workspace CRUD, git/GitHub/Jira integration, webhooks, PR dashboards, fs watchers, branch lifecycle, ticket transitions.

## Scope

- `server/workspaces.ts` — Workspace entity CRUD + Express Router: dashboard, settings, PR, CI status, branch switch, path autocomplete, bulk add, file-diff/changed-files, worktree creation (mountain names from `MOUNTAIN_NAMES`). `clearPrCache` / `clearFilesListCache` exported for cache invalidation.
- `server/workspace-groups.ts` — Workspace grouping CRUD (`/workspace-groups`): create/read/update/delete/reorder workspace entities.
- `server/git.ts` — `execFile` wrapper over the git CLI: `listBranches`, `getCurrentBranch`, `getActivityFeed`, `switchBranch`, `renameBranch`, `createBranch`, `pushBranch`, `getChangedFiles`, `getFileDiff`, `getDefaultBranch`, `ensureBranchLocal`, `isPrMerged`, `computeBranchLifecycleState`, `extractOwnerRepo`, `buildRepoMap`, `phraseToBranchName`, `getWorkingTreeDiff`.
- `server/git-routes.ts` — Express Router for non-workspace git ops (branch lifecycle, PR lookups, branch switches). Delegates to `git.ts`.
- `server/gh.ts` / `server/gh-routes.ts` — `gh` CLI helpers + Router exposing `gh`-backed endpoints (repo/branch lookups, workflow runs, `getPrForBranch`, `isStalePr`).
- `server/github-app.ts` — GitHub OAuth App: authorization URL + CSRF state, token exchange callback, status, disconnect.
- `server/github-graphql.ts` — GitHub GraphQL client: PR search + response → `PullRequest[]` mapping (`fetchPrsGraphQL`).
- `server/webhooks.ts` — GitHub webhook receiver: HMAC signature verify, event routing, broadcast.
- `server/webhook-manager.ts` — Webhook CRUD, **smee client singleton** (`smeeHandle`, `smeeConnected`, `lastEventAt`), auto-provision backfill, 30 s smart-polling fallback (`pollingTimer`) for repos without a working webhook. Emits `pr-updated` / `ci-updated`.
- `server/watcher.ts` — fs watchers: `WorktreeWatcher` (workspace dirs), `BranchWatcher` (`.git/HEAD`), `RefWatcher` (upstream tracking refs for PR auto-refresh), `GitWatcher` (`.git/` for `files-changed` events with `changedFiles: string[]` from `git status`). `WORKTREE_DIRS = ['.worktrees', '.claude/worktrees']`, `findOrCreateWorktreeForBranch`, `parseAllWorktrees`.
- `server/branch-linker.ts` — Maps ticket IDs (Jira-style + `GH-NNN`) extracted from branch names to workspace repos. 60 s cache; Router at `/branch-linker/links`; `invalidateBranchLinkerCache()` hook for other modules.
- `server/integration-github.ts` — GitHub Issues for `@me`: fetches open issues across all workspaces via `gh issue list`; per-repo 60 s cache; Router at `/integrations/github/issues`.
- `server/integration-jira.ts` — Jira via `acli`: open issues assigned to current user, project statuses; 60 s cache; Router at `/integrations/jira/{issues,statuses}`.
- `server/org-dashboard.ts` — Cross-repo PR dashboard: aggregates open PRs involving current user via `gh search` + GraphQL fallback; triggers ticket transitions on PR state changes; 60 s cache.
- `server/ticket-transitions.ts` — Automated ticket state machine for GitHub Issues (labels `in-progress` / `code-review` / `ready-for-qa`) and Jira (via `acli`). Driven by session creation + PR merge events.
- `server/review-poller.ts` — Polls GitHub notifications (default 5 min) for review requests; creates worktrees; optionally starts review sessions.
- `server/browser-content.ts` — Serves per-file browser content with scoped Bearer token + per-file token gating and realpath-based path-traversal protection.

## Key Decisions

- **git CLI, not a library.** Every git operation shells out to `git`/`gh`/`acli` via `execFileAsync` with explicit timeouts (10 s default for ticket-transitions, 15 s for review-poller, 30 s interval for webhook-manager smart poll). Rationale: avoid divergence between relay-ide's view of git state and what the user sees on the command line. When adding a new git op, keep the CLI shell-out pattern.
- **All integration responses are cached for 60 s.** `branch-linker`, `integration-github`, `integration-jira`, `org-dashboard` each hold a module-level cache. Cache keys differ: branch-linker uses a single key, integration-github caches per-repo, integration-jira uses `jira_issues` as the single key. On PR state changes, `clearPrCache` and `invalidateBranchLinkerCache()` must be called.
- **Webhooks first, polling as fallback.** `webhook-manager.ts` maintains a single smee client and starts 30 s smart polling only for repos that don't have `webhookEnabled === true`. Real-time updates via webhook are preferred; polling is explicit second-choice.
- **Worktree paths are constrained.** `WORKTREE_DIRS = ['.worktrees', '.claude/worktrees']` in `watcher.ts`; `isValidWorktreePath` validates. Service install in `service.ts` uses the same constant to detect worktree vs global contexts.
- **Branch lifecycle state is computed, not stored.** `computeBranchLifecycleState` in `git.ts` derives state from live git + GitHub queries. `ensureBranchLocal` fetches missing refs on demand.
- **Mountain naming convention for worktrees.** `MOUNTAIN_NAMES` in `types.ts` provides human-memorable worktree names. Existing convention elsewhere: `mobile-<name>-<timestamp>` for mobile-created worktrees.
- **Hook dependency direction.** `hooks.ts` calls `phraseToBranchName` + `renameBranch` from `git.ts`. Conversely, `review-poller.ts` and `workspaces.ts` call into `watcher.ts`'s `findOrCreateWorktreeForBranch`. Don't let git modules depend on sessions/PTY.
- **`gh` CLI auth is user-managed.** We never prompt for GitHub credentials ourselves — every `gh` call assumes the user has authenticated `gh`. Timeouts on every `gh` call so a hung CLI never blocks the event loop.

## Conventions

- New git operation? Add it to `git.ts` as a thin `execFileAsync` wrapper with a timeout, export from `git.ts`, then wire a route in `git-routes.ts` or `workspaces.ts`. Tests must inject `ExecFileAsyncLike` to avoid hitting a real repo.
- New integration? Copy the shape of `integration-jira.ts`: `{integration}Deps` interface with `configPath` + `execAsync` injection seam, module-level cache with `CACHE_TTL_MS = 60_000`, Express Router mounted under `/integrations/{name}`.
- Webhook-dependent flows must degrade gracefully when smee is disconnected — check `smeeConnected` / `webhookError` and fall back to the polling path.
- Router factories receive `configPath` (string) plus any callbacks as deps; they never read config directly from disk at module scope.
- `extractOwnerRepo(remoteUrl)` is the single owner/repo parser — reuse, never reinvent.
- Test isolation: tests that need git must use `makeGitRepo` / `makeTempGitRepo` helpers and annotate with `[needs:git-init]` so `.husky/pre-push` skips them in worktree contexts (`docs/QUALITY.md`).

<!-- octogent:suggested-skills:start -->

## Suggested Skills

You can use these skills if you need to.

- `investigate`
- `review`
- `codex`
- `ticket`
<!-- octogent:suggested-skills:end -->
