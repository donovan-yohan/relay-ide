# Git-tracked artifact audit — 2026-06-27

Status: power-wash audit slice for #1035. Scope is files currently tracked by Git on `origin/nightly`, not local runtime clutter in an individual checkout.

## Method

```bash
git ls-files
git ls-files | awk '/^\./ || /^logs\// || /\.db(-shm|-wal)?$/ || /^dist\// || /^frontend\/test-.*\.html$/ || /^pending-.*\.json$/ {print}'
git check-ignore -v --no-index docs/design-system/ui_kits/relay-web/chat.html docs/design-system/colors_and_type.css
git grep -n "ralph-loop\|sisyphus" -- . ':!.git'
for f in frontend/test-*.html; do basename "$f"; git grep -n "$(basename "$f")" -- . ':!frontend/test-*.html'; done
```

Result summary on this slice:

- total tracked files: 1311
- tracked dot/config paths: 26
- tracked runtime DB/log/state files: 0
- tracked `dist/` build output: 0
- tracked frontend component harness HTML files: 7

## Delete now

| Path                            | Finding                                                                                                                                                                                                          | Action                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `.sisyphus/ralph-loop.local.md` | Stale local automation/run state from 2026-04-09 with no code/docs references. It stores per-run loop metadata (`session_id`, verification attempt id, start time) and does not describe current Relay behavior. | Remove from Git and ignore `.sisyphus/` going forward. |

## Keep tracked

| Path / group                                  | Why it stays tracked                                                                                                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.chalk/`                                     | Source of truth for repo-local chalkbag skills, subagents, providers, and permissions. `AGENTS.md` explicitly tells contributors to edit `.chalk/` and not generated `.claude/`, `.codex/`, `.agents/`, `.opencode/` outputs. |
| `.github/`, `.husky/`, `.nvmrc`, `.prettier*` | Repo workflow/toolchain config, not local runtime state.                                                                                                                                                                      |
| `.relay/messages/*.json`                      | Repo-local WorkContext message templates used by the CLI gateway template discovery flow. These are examples/contracts, not generated per-user state.                                                                         |
| `frontend/test-*.html`                        | Vite/e2e component harness entries. Each tracked HTML file is referenced by `frontend/vite.config.ts` and/or a component e2e spec. Do not delete as “top-level test junk” without replacing those harnesses.                  |
| `docs/design-system/**`                       | Tracked design/reference assets and UI-kit mocks. The old ignore rule hid these tracked docs from normal `git add`; this slice narrows the ignore rule to local design-system scratch artifacts instead.                      |

## Follow-up candidates

| Candidate                                                                 | Follow-up question                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.chalk/skills/example-skill/` and `.chalk/subagents/example-subagent.md` | Decide whether repo-local chalkbag examples are still useful developer documentation or should move to upstream chalkbag docs. Do not delete in this slice because `.chalk/README.md` presents them as editable source, not runtime state. |
| `docs/design-system/ui_kits/relay-web/`                                   | Keep while it remains a visual reference target. Future cleanup can split stable design artifacts from screenshots/uploads if the tree grows.                                                                                              |
| historical docs under `docs/plans/`, `docs/spikes/`, `docs/refactor/`     | They are intentionally historical per `docs/README.md`; delete only when a current source-of-truth doc supersedes the record and issue references are no longer useful.                                                                    |

## Guardrail

Do not use `find .` output from a dirty checkout as deletion evidence. This audit is intentionally based on `git ls-files`; local `.env`, DBs, logs, worktrees, generated `.claude/`, and `dist/` are already ignored unless explicitly forced into the index.
