# relay-ide

Relay is a channel-first agent workspace. A channel is the durable
conversation, a DM is a channel with one agent profile, and agents are
participants. The hub serves the React UI and stable gateway; local or paired
nodes own processes, files, repos, worktrees, and `relay-pty` terminals.

> This file is the map, not the manual. Keep it under 120 lines. `CLAUDE.md` is
> a symlink to this file. Do not hand-edit generated `.claude/`, `.codex/`, or
> `opencode.json`; they are projected from `.chalk/` by chalkbag.

## Commands

| Action            | Command               |
| ----------------- | --------------------- |
| Install           | `npm install`         |
| Build             | `npm run build`       |
| Type/lint check   | `npm run check`       |
| Test              | `npm test`            |
| Source dev        | `npm run dev`         |
| Self-host Relay   | `npm run dev:self`    |
| Backend only      | `npm run dev:backend` |
| Frontend HMR      | `npm run dev:vite`    |
| Start hub         | `npm start`           |
| Node capabilities | `relay-ide manifest`  |

Node.js 24 or newer is required. Run `nvm use` from `.nvmrc`. Frontend changes
need Vite HMR or a fresh build before package-mode verification.

## Documentation map

| Area              | Source                                 |
| ----------------- | -------------------------------------- |
| Public onboarding | `README.md`                            |
| Current docs      | `docs/README.md`                       |
| Channel model     | `docs/CHANNEL_CHAT.md`                 |
| Architecture      | `docs/ARCHITECTURE.md`                 |
| Frontend          | `docs/FRONTEND.md`                     |
| Visual system     | `DESIGN.md`                            |
| Backend patterns  | `docs/DESIGN.md`                       |
| Quality           | `docs/QUALITY.md`                      |
| Security          | `docs/SECURITY_POLICY.md`              |
| Terminal backend  | `docs/TERMINAL_BACKENDS.md`            |
| Provider adapters | `docs/provider-guide.md`               |
| Self-hosting      | `docs/SELF_HOSTING.md`                 |
| Federated dev     | `docs/FEDERATED_DEV.md`                |
| Release notes     | `CHANGELOG.md`                         |
| Deployment        | `docs/references/deployment.md`        |
| Devbox hub        | `docs/references/devbox-hub-deploy.md` |
| ADRs              | `docs/adrs/`                           |
| Learnings         | `docs/LEARNINGS.md`                    |

## Product and architecture rules

- New conversation work targets `ChannelView`, `ChannelTimeline`,
  `ChannelMessageRow`, the channel router/store/hub, and the binder/bridge.
- Channels own transcripts. Agent runtimes are internal execution state behind
  durable profile actors; never expose a runtime session as a chat destination.
- DMs are deterministic channels. Threads use `threadId`/`parentMessageId`
  inside the same channel sequence.
- Agent output in channels uses `AssistantMarkdown` and `AgentDetailCard`.
  Isolated component fixtures do not prove the live channel path.
- Built-in agent frameworks are Claude Code, Codex, OpenCode, and Hermes.
  Custom frameworks and profiles must use the same channel contract.
- The hub owns channel persistence, mention routing, auth, policy, and
  federation. Nodes own local execution and paths.
- Sidebar/navigation surfaces read the channel-workspace model
  (`workspace_topics` + `ia_workspaces` + channel summaries), never
  `config.repos`. Any add/create surface must write the store its reading
  surface renders. Verified findings ladder: epic #1287; traps in
  `docs/LEARNINGS.md` § navigation spine.
- Interactive terminals use `relay-pty`/libghostty-vt only. xterm.js is the
  browser renderer. Relay server restart is cold resume, not child-process
  supervision.
- Runtime SQLite and config live in the config directory, never the checkout by
  default.
- External agent brains use `relay-ide v1 ... --json`, not private browser or
  node-link protocols.
- Relative ESM imports end in `.js`; Node builtins use the `node:` prefix.

## Design and quality

Read `DESIGN.md` before UI work. Preserve its typography, color, spacing,
motion, button, and zero-radius rules unless the user approves a change.

For substantial production work, use the repo's intent/context/harness
discipline. Run one adversarial review before expensive gates, batch valid
findings, then one focused re-review. Final evidence must target the exact head.
For mobile, browser, deployment, or device claims, verify the real surface.

## Skills and work tracking

Repo skills live in `.chalk/skills/` and are projected by chalkbag:

- `/scope` — issue scoping and brainstorming guardrails
- `/ticket` — GitHub issue creation, sub-issues, and blockers

Issues live in `donovan-yohan/relay-ide`. Workflow is `backlog` → `refined` →
`todo` → `in-progress`. Claim work in `.worktrees/<issue-slug>`.

## Branching

- `nightly` is the active-development base and default PR target.
- `master` is protected; tags publish stable releases.
- Do not push directly to `master`.
- Stable release and hotfix details live in
  `docs/references/deployment.md`.
