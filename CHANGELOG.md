# Changelog

All notable changes to Relay are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

| Channel           | Trigger                       | npm dist-tag |
| ----------------- | ----------------------------- | ------------ |
| Stable            | `vX.Y.Z` tag on `master`      | `latest`     |
| Release candidate | `vX.Y.Z-rc.N` tag on `master` | `rc`         |
| Nightly           | any push to `nightly`         | `nightly`    |

Only stable and release-candidate tags get a section here; nightly builds are
stamped automatically and are not release-noted. See
[docs/references/deployment.md](docs/references/deployment.md) for the release
workflow.

## [Unreleased]

### Added

- `CHANGELOG.md` and a release-candidate publish lane: `vX.Y.Z-rc.N` tags on `master`
  publish to the npm `rc` dist-tag, and the stable lane hard-fails on any prerelease
  version so an rc can never land on `@latest`. Stable and rc tags also cut a GitHub
  Release whose body is the matching changelog section.

## [0.1.0] - 2026-08-04

First tagged release under the `relay-ide` name. This entry covers the
channel-workspace era — epics #1163 (Slack-style workspace chat), #1287 (navigation
spine), #1232 (agent profiles), #1242 (orchestration foundation), and #1308
(daily-driver trust), continuing the #1021/#1058 lineage — on top of the hub/node,
session, and capability substrate carried over from the pre-rebrand line.

### Channel workspace and sidebar

#### Added

- Channel conversation core: durable store, multi-sender protocol, WS fan-out (#1175)
- Channel timeline UI and DM-as-channel (#1178)
- `@`-mention routing: roster, spawn-on-first-mention, streamed replies (#1180)
- Backend thread support (#1186), thread-scoped context packets (#1195), thread panel with reply affordances (#1199)
- Slack-style timeline scroll model (#1197)
- Native image messages in the timeline (#1211)
- Mobile mission-control cockpit (#1216)
- Workspace identity spine: real IA workspace lanes, sentinel retirement, add-project rows (#1294)
- Channel-summary row hydration and cache coherence (#1295)
- Opaque channel identity decoupled from titles (#1296)
- Sidebar channel routing, nested threads with presence, collapse persistence (#1297)
- In-timeline agent presence row plus an OpenCode streaming flag (#1306)

#### Changed

- Cleared the v1 chat protocol and legacy sidebar debt; the UI is dark-only (#1174)
- Sidebar mechanics demoted behind an advanced surface (#1204)
- Legacy `ChatView` / web-session subtree retired (#1224)
- Channels are the only agent conversation surface (#1283)
- Pre-channel frontend islands deleted (#1300)

#### Fixed

- Hermes reply finalization, duplicate rows, presence, zero-row logging (#1183)
- Truthful terminal rows and a duplicate-free channel record (#1207)
- Channel tree data source unified across desktop and mobile (#1208)
- Agent detail cards render inside channels (#1225)
- WS catch-up budget prioritizes fresh rows over resync (#1280)
- Archived channels threaded into chat search (#1288)
- Palette channel selection opens the channel (#1289)
- Unread bootstrapped from `GET /channels` on sidebar mount (#1290)
- Cockpit escape hatches clear `activeChannelId` (#1291)
- New-chat button no longer no-ops after adding a project (#1302)

### Agent profiles and DM routing

#### Added

- `AgentProfile` actor model with a default-per-vendor mention resolver, so `@claude` and `@codex` are a vendor's default profile rather than its only contact (#1233)
- Initials-avatar component for profile identity (#1235)
- Profile-aware `@`-mention autocomplete with collision disambiguation (#1236)
- Per-profile config editor, CRUD route, and vendor gallery (#1275)

#### Changed

- Sender attribution re-keyed from the vendor framework to the profile Actor id (#1234)
- Channel binding re-keyed to the `AgentProfile` actor id (#1276)

#### Fixed

- DM messages route to the DM profile without requiring a literal mention (#1304)

### Orchestration

#### Added

- `spawnedBySessionId` session lineage (#1256)
- Scoped-actor `sessions.create` gateway verb for orchestrator worker spawn (#1258)
- Orchestrator peer ladder: single-channel echo (#1265), two-channel read and relay (#1267), spawn-and-instruct workers via `@`-mention (#1269)
- Scoped-actor mail loop, cwd session creation, chat-landing live sessions (#1270)
- Persistent orchestrator lifecycle backend spine (#1271)
- Operator route to designate a channel's persistent orchestrator (#1272)
- Operator/orchestrator UX: designate control and orchestrator badge (#1273)
- Cockpit orchestrator-to-workers lineage tree (#1274)

### Messages

#### Added

- Message hover toolbar, deep links, retry on failed rows, edit/delete, system-event coalescing (#1314)
- Full-text message search: FTS5 index, two-section sidebar results, palette category, jump-to-message (#1315)
- Cross-device read-state sync: hub-persisted last-read marks, unread stays client-derived (#1317)
- OS notifications, favicon badge, and title count while the tab is hidden (#1319)
- Mid-turn steering: queued-for-next-turn with an interrupt-and-send-now affordance (#1320)

### Agent runtimes

#### Added

- Persistent-subprocess Claude adapter over `stream-json`, with no Agent SDK dependency (#1176)
- Codex web sessions revived for channel mentions (#1182)

#### Fixed

- Codex reasoning content and terminal status on thought cards (#1210)
- `claudeArgs` no longer leak into non-Claude agent spawns (#1237)
- Codex `initialPrompt` driven as a native positional arg (#1240)
- `--add-dir` gated to Claude in multi-repo spawns (#1260)

### Self-update pipeline

#### Added

- Auto-restart under generic systemd supervision after a verified update (#1301)

#### Fixed

- `/update` detects the running install's package manager and verifies the update actually landed (#1286)

### Security and infrastructure

#### Added

- Hub/node security policy schema (#500)
- Hash-chained security audit log (#507)

#### Fixed

- `NO_PIN` auth bypass removed (#831)
- Runtime SQLite artifacts kept out of repo checkouts (#961)
- Hub health and session restore hardened (#1200)
- `web_sessions` agent transcript growth bounded (#1243)
- Per-connection WS send queues bounded and half-open sockets reaped (#1249)
- Recursive directory watch pruned per level, fixing a daily-hub event-loop wedge (#1249), with follow-up walker edge cases (#1261)
- Session-teardown resource-hygiene sweep (#1262)
- `sharp` lazy-loaded so CLI startup never eagerly loads its native binding (#1278)
- Startup fails fast when persistence cannot initialize instead of booting amnesiac (#1279)
- Event loop yielded during session resume so HTTP is served while sessions rehydrate (#1282)

[Unreleased]: https://github.com/donovan-yohan/relay-ide/compare/v0.1.0...nightly
[0.1.0]: https://github.com/donovan-yohan/relay-ide/releases/tag/v0.1.0
