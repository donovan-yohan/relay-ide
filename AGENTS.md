# relay-ide

Relay Agentic Development Environment — remote web interface for Claude Code CLI sessions from any device. TypeScript + ESM backend (Express + node-pty + WebSocket) → `dist/`. React 19 frontend (Zustand + TanStack Query + Vite) → `dist/frontend/`.

> This file is the map, not the manual. Keep under 120 lines. Push detail into `docs/*.md`.
> `CLAUDE.md` is a symlink to this file — edit `AGENTS.md` and Claude will see it. Do not hand-edit generated `.claude/`, `.codex/`, `opencode.json` — they come from `.chalk/` via [chalkbag](https://github.com/donovan-yohan/chalk-bag).

## Quick Reference

| Action             | Command                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| Build              | `npm run build`                                                          |
| Self-host Relay    | `npm run dev:self`                                                       |
| Test               | `npm test`                                                               |
| Node capabilities  | `relay-ide manifest`                                                     |
| Start              | `npm start`                                                              |
| Run (global)       | `relay-ide`                                                              |
| Version bump       | `npm version patch\|minor\|major`                                        |
| Mobile input tests | Add fixture to `test/fixtures/mobile-input/` before fixing keyboard bugs |

## Documentation Map

| Category       | Path                            | When to look here                                                |
| -------------- | ------------------------------- | ---------------------------------------------------------------- |
| Architecture   | `docs/ARCHITECTURE.md`          | Module boundaries, data flow, API routes, ADR rules              |
| Visual Design  | `DESIGN.md`                     | TUI aesthetic, colors, buttons, icons, border-radius rules       |
| Design         | `docs/DESIGN.md`                | Backend patterns, auth flow, PTY management, session types       |
| Frontend       | `docs/FRONTEND.md`              | React 19 components, state management (Zustand + TanStack Query) |
| Quality        | `docs/QUALITY.md`               | Test runner, test files, isolation patterns                      |
| Review         | `docs/REVIEW_GUIDANCE.md`       | Review agent config, question bank, escape log                   |
| Deployment     | `docs/references/deployment.md` | Publishing + branching (nightly/master + tags)                   |
| Self-hosting   | `docs/SELF_HOSTING.md`          | Build Relay with Relay using isolated dev config/ports/tmux      |
| Node bootstrap | `docs/RELAY_NODE_BOOTSTRAP.md` | Pair/install/update/unpair nodes for federated Relay             |
| Federated Relay | `docs/federated-relay.md`       | Hub/node architecture, pairing, routing, ADRs                    |
| Learnings      | `docs/LEARNINGS.md`             | Persistent cross-session learnings                               |
| Project skills | `.chalk/skills/<name>/SKILL.md` | Repo-local skills (see §Skills)                                  |
| Work tracking  | GitHub Issues                   | `donovan-yohan/relay-ide` — use `/ticket` or `gh issue`          |

## Design System

Read `DESIGN.md` before any visual or UI decision. Font, color, spacing, border-radius, button styles — all defined there. Do not deviate without explicit user approval. In QA mode, flag any code that diverges from `DESIGN.md`.

## Skills

Repo-local skills live under `.chalk/skills/`. Projected to `.claude/skills/` (gitignored) on `chalkbag build`.

- `/scope` → `.chalk/skills/scope/SKILL.md` — issue scoping and brainstorming guardrails
- `/ticket` → `.chalk/skills/ticket/SKILL.md` — GitHub Issue creation + sub-issue / blocker graphql

See `.belayer/README.md` for the issue-workflow pipeline (backlog → refined → todo → in-progress).

## Key Patterns

- 69 `server/` modules (`adapters/`, `output-parsers/`, `protocol-adapters/`), one concern each — update ADRs when adding.
- `node-pty` needs native compile; `postinstall` fixes prebuilt binaries on macOS.
- Strip `CLAUDECODE` from PTY env so Claude sessions nest.
- tmux is mandatory for interactive agent and terminal sessions; xterm.js remains the browser renderer.
- 256KB scrollback cap per session; oldest trimmed FIFO.
- Config: `~/.config/relay-ide/config.json` (global) or `./config.json` (local dev).
- PIN reset: `relay-ide pin reset` on the host (interactive TTY).
- Node.js ≥ 24.0.0 — `nvm use` from `.nvmrc`.
- Relative imports end in `.js`; builtins use `node:` prefix.
- npm package — GitHub Actions publish (see `docs/references/deployment.md`).
- Frontend edits (TSX/CSS) only render locally after `npm run build` — server serves `dist/frontend/`, not sources. Restart `npm start` to pick up new bundle.

## Branching

- **`nightly`** — default, active dev. PRs target here. Each push → `@nightly` npm publish.
- **`master`** — protected. Tags → `@latest` publish.
- Stable release: bump on `nightly`, PR to `master`, tag on `master`, sync back. Hotfixes: branch off `master`, PR to `master`, bump+tag, merge back to `nightly`.
- No direct pushes to `master`. Full workflow in `docs/references/deployment.md`.

## Work tracking

GitHub Issues on `donovan-yohan/relay-ide`. Every issue needs:

- Type: `bug` | `feature` | `improvement` | `spike`
- State: `backlog` (rough) → `refined` (scoped, awaiting plan) → `todo` (planned, belayer-ready) → `in-progress` (belayer claimed). See `.belayer/README.md`.
- Priority: `p1-urgent` | `p2-high` | `p3-normal` | `p4-low`
- Project (when applicable): `project:sidebar-nav`, `project:code-file-tools`, `project:verification-testing`, `project:command-center`, `project:agent-platform`, `project:true-workspaces`
- `epic` label on parents

`/ticket` handles creation + sub-issue / blocker mutations. Reference in `.chalk/skills/ticket/SKILL.md`.

## gstack

- Use `/browse` for all web browsing — never `mcp__claude-in-chrome__*`.
- Skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn.
- If skills aren't loading: `cd .claude/skills/gstack && ./setup`.
