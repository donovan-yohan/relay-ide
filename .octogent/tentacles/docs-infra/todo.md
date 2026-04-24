# docs-infra — Backlog

## Epics

- [ ] **ADR backfill** — `docs/ARCHITECTURE.md` footnotes that ADR-002 was superseded and `hooks.ts` has no ADR; ADRs are summarized in a table but underlying `docs/adrs/*.md` files were never committed. Decide whether to reconstruct per-ADR files or formalize the in-doc table, then add an ADR for the hook HTTP surface + session state machine.
- [ ] **Docs pruning pass** — run `/harness:prune` equivalent: audit `docs/references/`, `docs/plans/`, `docs/bug-analyses/` for staleness; collapse anything that no longer matches the code; confirm `CLAUDE.md` stays under 120 lines.
- [ ] **Publish workflow dry-run** — codify `npm ci && npm run build && npm test` as a pre-publish guard in `.github/workflows/publish.yml` (or a helper script) so lockfile desync + type drift fail fast (`feedback_run_npm_ci` memory).
- [ ] **Eslint rule inventory** — document the intent behind every custom rule (cognitive complexity 25, `no-duplicate-string: 4`, `max-switch-cases: 15`, `no-console: error`) in `docs/QUALITY.md` or a new `docs/LINTING.md` so contributors stop disabling rules they don't understand.
- [ ] **Bug analysis template** — current bug analyses share a rough shape but diverge. Create a template under `docs/bug-analyses/TEMPLATE.md` covering: symptom, repro, root cause, fix, follow-ups, prevention.
- [ ] **Rename persisted-state prefix** — `claude-remote-*` localStorage keys (frontend) predate the relay-ide rebrand. Coordinate with `frontend-state` to migrate and ship a one-time read-both-write-new path.
- [ ] **Deployment guide test** — `docs/references/deployment.md` describes the release path. Walk through it end-to-end on a test branch and add explicit commands for hotfix and rollback scenarios.
- [ ] **Scrub `bun.lockb`** — decide whether to keep both lockfiles or remove `bun.lockb` to avoid drift. If keeping, document the invariant (npm is source-of-truth) inline.
