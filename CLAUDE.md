# relay-ide

Relay Agentic Development Environment — remote web interface for interacting with Claude Code CLI sessions from any device. TypeScript + ESM backend (Express + node-pty + WebSocket) compiled to `dist/`. Svelte 5 frontend (runes + Vite) compiled to `dist/frontend/`.

## Quick Reference

| Action             | Command                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| Build              | `npm run build`                                                          |
| Test               | `npm test`                                                               |
| Start              | `npm start`                                                              |
| Run (global)       | `relay-ide`                                                              |
| Version bump       | `npm version patch\|minor\|major`                                        |
| Mobile input tests | Add fixture to `test/fixtures/mobile-input/` before fixing keyboard bugs |

## Design System

Always read `DESIGN.md` before making any visual or UI decisions. All font choices, colors, spacing, border-radius, button styles, and aesthetic direction are defined there. Do not deviate without explicit user approval. In QA mode, flag any code that doesn't match DESIGN.md.

## Documentation Map

| Category      | Path                   | When to look here                                                      |
| ------------- | ---------------------- | ---------------------------------------------------------------------- |
| Architecture  | `docs/ARCHITECTURE.md` | Module boundaries, data flow, API routes, ADR rules                    |
| Visual Design | `DESIGN.md`            | TUI aesthetic, colors, buttons, icons, border-radius rules             |
| Design        | `docs/DESIGN.md`       | Backend patterns, auth flow, PTY management, session types             |
| Frontend      | `docs/FRONTEND.md`     | Svelte 5 components, state management, UI conventions                  |
| Quality       | `docs/QUALITY.md`      | Test runner, test files, isolation patterns                            |
| References    | `docs/references/`     | Deployment guide, review agent setup                                   |
| Learnings     | `docs/LEARNINGS.md`    | Persistent cross-session learnings (architecture, debugging, patterns) |
| Work Tracking | Linear (DYS-\*)        | Bugs, features, spikes, epics — query via Linear MCP                   |

## Key Patterns

- Thirty-four server modules under `server/`, each owning one concern — update ADRs when adding modules
- `node-pty` requires native compilation; `postinstall` script fixes prebuilt binaries on macOS
- `CLAUDECODE` env var must be stripped from PTY env to allow nesting Claude sessions
- Scrollback buffer capped at 256KB per session; oldest chunks trimmed first (FIFO)
- Config at `~/.config/relay-ide/config.json` (global) or `./config.json` (local dev)
- PIN reset: run `relay-ide pin reset` on the host machine (interactive TTY required)
- Requires Node.js >= 24.0.0 (use `nvm use` with `.nvmrc`)
- All relative imports use `.js` extensions; Node builtins use `node:` prefix
- npm package — publishing automated via GitHub Actions (see `docs/references/deployment.md`)

## Branching & Deployment

- **`nightly`** — default branch, active development. PRs target here. Every push auto-publishes `@nightly`.
- **`master`** — protected, stable releases only. Tags trigger `@latest` publish.
- **Stable release** — bump version on `nightly`, PR to `master`, merge, `git tag` on master, push tag, sync back.
- **Hotfixes** — branch off `master`, PR to `master`, bump+tag, merge back to `nightly`.
- Direct pushes to `master` are blocked (no bypass) — all commits via PR, version tags via `git push origin <tag>`.
- See `docs/references/deployment.md` for full workflow.

## Work Tracking (Linear)

All work items are tracked in Linear (Dystudios team, DYS-\* prefix). Do NOT use TODOS.md — Linear is the source of truth.

**Creating tickets:** Use the Linear MCP (`mcp__plugin_linear_linear__save_issue`). Every ticket MUST have:

- `team`: `Dystudios`
- `labels`: a type label (`Bug`, `Feature`, `Improvement`, or `Spike`) + `donovan-yohan/relay-ide`
- `priority`: 1=Urgent, 2=High, 3=Normal, 4=Low
- `project`: assign to a project when the ticket fits a workstream (see below)
- `state`: `Backlog` for new items, `Todo` when scoped and ready to start

**Projects:**

- **Sidebar & Navigation UX** — sidenav, status indicators, session states, navigation
- **Code & File Tools** — file browser, diffs, changed files, LLM summaries
- **Verification & Testing** — sandbox mode, Playwright e2e, CI gates
- **Command Center** — command palette, keyboard shortcuts, discoverability
- **Agent Platform** — Codex, Gemini, multi-agent, spawning UX
- **True Workspaces** — multi-repo workspace groupings

**Querying tickets:** Use `list_issues` with `label: "donovan-yohan/relay-ide"` to see all relay-ide issues. Filter by `project`, `state`, or `priority` as needed.

**Blocking relationships:** Use `blockedBy`/`blocks` when tickets have dependencies. Use `parentId` to nest sub-tasks under epic issues.

## gstack

- Use `/browse` from gstack for ALL web browsing — never use `mcp__claude-in-chrome__*` tools
- Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn
- If gstack skills aren't working, run `cd .claude/skills/gstack && ./setup` to build the binary and register skills
