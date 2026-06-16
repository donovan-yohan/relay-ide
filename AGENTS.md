# relay-ide

Relay Agentic Development Environment — a hub/node web workspace for AI coding agents, terminals, and repo-aware development from any device. TypeScript + ESM backend (Express + node-pty + terminal backends + WebSocket) → `dist/`. React 19 frontend (Zustand + TanStack Query + Vite) → `dist/frontend/`.

> This file is the map, not the manual. Keep under 120 lines. Push detail into `docs/*.md`.
> `CLAUDE.md` is a symlink to this file — edit `AGENTS.md` and Claude will see it. Do not hand-edit generated `.claude/`, `.codex/`, `opencode.json` — they come from `.chalk/` via [chalkbag](https://github.com/donovan-yohan/chalk-bag).

## Quick Reference

| Action             | Command                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| Build              | `npm run build`                                                          |
| Type/lint check    | `npm run check`                                                          |
| Self-host Relay    | `npm run dev:self`                                                       |
| Source dev         | `npm run dev`                                                            |
| Split dev backend  | `npm run dev:backend`                                                    |
| Split dev frontend | `npm run dev:vite`                                                       |
| Test               | `npm test`                                                               |
| Node capabilities  | `relay-ide manifest`                                                     |
| Start hub          | `npm start` or `relay-ide hub`                                           |
| Run (global)       | `relay-ide`                                                              |
| Version bump       | `npm version patch\|minor\|major`                                        |
| Mobile input tests | Add fixture to `test/fixtures/mobile-input/` before fixing keyboard bugs |

## Documentation Map

| Category             | Path                                         | When to look here                                                                                                        |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Docs index           | `docs/README.md`                             | Current source-of-truth docs vs historical plans/spikes                                                                  |
| Architecture         | `docs/ARCHITECTURE.md`                       | Module boundaries, data flow, API routes, ADR rules                                                                      |
| Boo/session model    | `docs/BOO_PHILOSOPHY.md`                     | Scriptable session substrate, rendered-screen gaps, operator-cockpit roadmap                                             |
| Workbench            | `docs/WORKBENCH_BOUNDARY.md`                 | Relay product boundary, #552 nouns, mobile/pair/dogfood acceptance                                                       |
| Visual Design        | `DESIGN.md`                                  | Product framing, TUI aesthetic, colors, spacing, buttons                                                                 |
| Design               | `docs/DESIGN.md`                             | Backend patterns, auth flow, PTY management, session types                                                               |
| Frontend             | `docs/FRONTEND.md`                           | React 19 components, state management (Zustand + TanStack Query)                                                         |
| Quality              | `docs/QUALITY.md`                            | Test runner, test files, isolation patterns                                                                              |
| Terminal backend     | `docs/TERMINAL_BACKENDS.md`                  | `relay-pty`-only backend, rejected legacy `tmux-compat` state, cold-resume semantics                                     |
| Review               | `docs/REVIEW_GUIDANCE.md`                    | Review agent config, question bank, escape log                                                                           |
| Deployment           | `docs/references/deployment.md`              | Publishing + branching (nightly/master + tags)                                                                           |
| Devbox deploy        | `docs/references/devbox-hub-deploy.md`       | Shared devbox hub deploy, Mac node-link restart, verification evidence, process hygiene                                  |
| Dogfood recovery     | `docs/references/dogfood-recovery.md`        | Relay-develops-Relay proof loop, recovery, diagnostics, no-force-merge gate                                              |
| Self-hosting         | `docs/SELF_HOSTING.md`                       | Build Relay with Relay using isolated dev config/ports/process identity                                                  |
| Security policy      | `docs/SECURITY_POLICY.md`                    | Trust tiers, capability bits, hub ACL defaults, manifest-vs-policy boundary, exact-operation approvals, handshake grants |
| Handshake grants     | `docs/OPERATOR_HANDSHAKE_GRANTS.md`          | One-time `relay-ohg-v1` operator handshake grant lane: ceremony, bounded scope, fail-closed validation                   |
| rmux helper          | `docs/RMUX_HELPER_PROTOCOL.md`               | Experimental #707/#745 JSON/stdin-stdout boundary spec for a throwaway `relay-rmux-helper` prototype                     |
| Session durability   | `docs/SESSION_DURABILITY.md`                 | Process-owner vs attach-handle, derived durability state machine, transition emission                                    |
| Hub/node pkg         | `docs/RELAY_HUB_NODE_PACKAGING.md`           | Hub vs node command shape, npm package decision, install/update commands                                                 |
| Node bootstrap       | `docs/RELAY_NODE_BOOTSTRAP.md`               | Pair/install/update/unpair nodes for federated Relay, bootstrap diagnostics                                              |
| WSL2 nodes           | `docs/WSL2_RELAY_NODE_SUPPORT.md`            | Windows/WSL2 node bootstrap, service mode, known limits                                                                  |
| Federated dev        | `docs/FEDERATED_DEV.md`                      | Cross-machine dev workflow: synced git checkouts, `dev:node`, version skew                                               |
| Federated Relay      | `docs/federated-relay.md`                    | Hub/node architecture, pairing, routing, ADRs                                                                            |
| CLI gateway          | `docs/CLI_GATEWAY.md`                        | Versioned `relay-ide v1 ... --json` contract for external agent adapters                                                 |
| Agent view artifacts | `docs/AGENT_VIEW_ARTIFACTS.md`               | Agent-authored static HTML/CSS WorkContext artifact contract, viewer package route, security model                       |
| Web chat             | `docs/WEB_CHAT.md`                           | Experimental adapter-shaped web chat surface for agent CLIs (status, scope, limits)                                      |
| Provider guide       | `docs/provider-guide.md`                     | Authoring/configuring agent framework providers (Claude/Codex/OpenCode/Hermes/custom)                                    |
| Handoff template     | `docs/pipeline-handoff-artifact-template.md` | PipelineHandoffArtifact authoring template: stages, evidence dispositions, exact-head fields                             |
| ADRs                 | `docs/adrs/`                                 | Accepted ADRs (latest: ADR-017 brain-as-peer, ADR-018 command-mediated handoff, ADR-019 context-packet storage)          |
| Learnings            | `docs/LEARNINGS.md`                          | Persistent cross-session learnings                                                                                       |
| Project skills       | `.chalk/skills/<name>/SKILL.md`              | Repo-local skills (see §Skills)                                                                                          |
| Work tracking        | GitHub Issues                                | `donovan-yohan/relay-ide` — use `/ticket` or `gh issue`                                                                  |

## Product Vocabulary

Use the six-layer vocabulary when naming IA work: View → Workspace → Project → Instance → Bench → Tab. Current implementation is still incremental: a Workspace is a grouping/config layer (`workspaces`, repo membership, settings), not a synonym for a repo; repo/worktree bindings are optional session/tab context. A read-only, flag-gated frontend MVP exists (`view-spine`, default OFF) that derives `Workspace → Project → Instance → Bench` from existing store data; it is a projection, not the persisted model (backend lane #733–#737 pending). See `docs/FRONTEND.md`.

Workbench nouns (per `docs/WORKBENCH_BOUNDARY.md`, epic #552) overlay this tree without replacing it: `WorkContext` is the durable envelope tying task/repo/worktree/session/artifacts together; `Actor`, `Session`, `Node`, `TaskRef`, `RepoInstance`, `WorktreeInstance`, `Artifact`, `AuditEvent`, and `CapabilityGrant` are the shared identity/control/audit primitives. `RepoInstance` is the git-specific Instance shape; `WorktreeInstance` is the git-specific Bench shape. `Session.controlMode` is `agent-driven | human-driven | co-driven` (#470/#493) with `ControlActor` identity; raw keystrokes/bytes never leave the source system. Active Work is the federated read model exposing these across nodes.

## Design System

Read `DESIGN.md` before any visual or UI decision. Font, color, spacing, border-radius, button styles — all defined there. Do not deviate without explicit user approval. In QA mode, flag any code that diverges from `DESIGN.md`.

## Skills

Repo-local skills live under `.chalk/skills/`. Projected to `.claude/skills/` (gitignored) on `chalkbag build`.

- `/scope` → `.chalk/skills/scope/SKILL.md` — issue scoping and brainstorming guardrails
- `/ticket` → `.chalk/skills/ticket/SKILL.md` — GitHub Issue creation + sub-issue / blocker graphql

Issue workflow: `backlog` (rough) → `refined` (scoped) → `todo` (planned) → `in-progress` (claimed). Use explicit worktrees under `.worktrees/<issue-slug>` when claiming work.

## Key Patterns

- Hub/node is the current architecture direction: the hub owns the web UI; nodes expose local capabilities and PTY/session execution through hub-mediated links. The local hub is itself a node (`server/local-node.ts`).
- External agent brains (Hermes, Claude, Codex, custom) are hub-level session peers via the versioned CLI gateway (`relay-ide v1 ... --json`), not protocol clients on `/hub/node-link`. See ADR-017 and `docs/CLI_GATEWAY.md`.
- Routed PTY sessions are scoped, revocable, and capability-gated (#426/#427). Mode changes and human interventions on `agent-driven` tabs emit hash-chained audit envelopes (#470/#499); raw bytes stay on the source system.
- Durable evidence layer: WorkContext artifacts + pipeline handoff artifacts (`work-context-artifacts.*` / `handoff-artifacts.*` gateway verbs, same store, exact-head append-only) carry stage evidence without raw transcripts; resume packets (#901) and handoff timelines (#902) read it back. See `docs/pipeline-handoff-artifact-template.md`.
- Workspace evidence dashboard (#897) is a read-only `evidence` tab over `/workspace-evidence/*` with capability-driven file/artifact/session/surface sections — a client over Relay action contracts, never a browser-only write path.
- Agent frameworks are configurable; built-ins include Claude Code, Codex, OpenCode, and Hermes. Do not hard-code Claude-only assumptions in new docs or UI copy.
- `node-pty` needs native compile; `postinstall` fixes prebuilt binaries on macOS.
- Strip `CLAUDECODE` from PTY env so Claude sessions nest.
- New interactive agent and terminal sessions use `relay-pty`/libghostty-vt only; `tmux-compat` is unsupported legacy state and must not be restored. xterm.js remains the browser renderer.
- `relay-pty` is not a process supervisor: browser reconnect/live Relay process reattach is supported, but Relay server restart is cold resume from saved session metadata/scrollback only.
- 256KB scrollback cap per session; oldest trimmed FIFO.
- Config + all runtime SQLite live in the config dir: `~/.config/relay-ide/` (global), `~/.config/relay-ide/dev/<slug>-<hash>/` (`npm run dev`), never the repo checkout by default (#961). See `docs/SELF_HOSTING.md` § Runtime state directory and cleanup.
- PIN reset: `relay-ide pin reset` on the host (interactive TTY).
- Node.js ≥ 24.0.0 — `nvm use` from `.nvmrc`.
- Relative imports end in `.js`; builtins use `node:` prefix.
- npm package — GitHub Actions publish (see `docs/references/deployment.md`).
- Frontend edits (TSX/CSS) only render in package mode after `npm run build`; Vite HMR is available through `npm run dev`.

## Branching

- **`nightly`** — default, active dev. PRs target here. Each push → `@nightly` npm publish.
- **`master`** — protected. Tags → `@latest` publish.
- Stable release: bump on `nightly`, PR to `master`, tag on `master`, sync back. Hotfixes: branch off `master`, PR to `master`, bump+tag, merge back to `nightly`.
- No direct pushes to `master`. Full workflow in `docs/references/deployment.md`.

## Work tracking

GitHub Issues on `donovan-yohan/relay-ide`. Every issue needs type, state, priority, project label when applicable, and `epic` on parent issues. `/ticket` handles creation + sub-issue / blocker mutations; reference `.chalk/skills/ticket/SKILL.md`.

## gstack

- Use `/browse` for all web browsing — never `mcp__claude-in-chrome__*`.
- Skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn.
- If skills aren't loading: `cd .claude/skills/gstack && ./setup`.
