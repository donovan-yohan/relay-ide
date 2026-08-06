# Changelog

All notable changes to Relay are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

| Channel           | Trigger                       | npm dist-tag |
| ----------------- | ----------------------------- | ------------ |
| Stable            | `vX.Y.Z` tag on `master`      | `latest`     |
| Release candidate | `vX.Y.Z-rc.N` tag on `master` | `rc`         |
| Nightly           | any push to `nightly`         | `nightly`    |

Only stable and release-candidate versions get a section here; nightly builds are
stamped automatically and are not release-noted. See
[docs/references/deployment.md](docs/references/deployment.md) for the release
workflow.

## [Unreleased]

### Channel workspace and sidebar

#### Added

- Create and name new folders directly in the local Add Project browser (#1338)
- `@agent/` opens a provider-aware command palette for channel controls,
  including Codex Fast Mode, model, and reasoning-effort changes (#1344)

#### Changed

- The new-chat composer now lets operators create normal channels, and DMs cannot be designated as orchestration channels (#1337)
- Mid-turn channel sends now steer Codex and Claude at their native safe tool
  boundary by default, while harnesses without that primitive retain a clearly
  labelled FIFO queue fallback

#### Fixed

- Existing Codex channel conversations now recover after a hub/runtime restart,
  and user message bubbles no longer collapse into character-by-character
  wrapping (#1339)

## [0.1.1] - 2026-08-05

This is the first public release of the channel era, branded v0.1; it ships as
`0.1.1` because npm's `0.1.0` was consumed by the 2026-04 package rename.

Everything in this section shipped on `@nightly` only, before this release. The
last tagged release is `v3.19.0` (2026-03-28), and `0.1.0` was published from
`nightly` on 2026-04-03 carrying the package rename, so the whole line since
`v3.19.0` lands here.

The entries below itemize the channel-workspace era — epics #1163 (Slack-style
workspace chat), #1287 (navigation spine), #1232 (agent profiles), #1242
(orchestration foundation), and #1308 (daily-driver trust), continuing the
#1021/#1058 lineage — plus older security and data-location changes that anyone
upgrading needs to know about. The rest of the ~860 commits merged since `v3.19.0`
(the `relay-pty` terminal backend, the CLI gateway, WorkContext and handoff
artifacts, the evidence dashboard, node pairing, workspaces and topics, and the
chat-first pass) also shipped only on `@nightly` and is not itemized here.

### Channel workspace and sidebar

#### Added

- Channel conversation core: durable store, multi-sender protocol, WS fan-out (#1175)
- Channel timeline UI and DM-as-channel (#1178)
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

- Terminal thinking summaries without detail no longer show a non-interactive
  disclosure arrow; thinking cards with detail remain expandable.
- Hermes reply finalization, duplicate rows, presence, zero-row logging (#1183)
- Truthful terminal rows and a duplicate-free channel record (#1207)
- Channel tree data source unified across desktop and mobile (#1208)
- Historical duplicated Claude replies are healed on hub start even when the
  database already passed the schema version that first shipped the repair, the
  operator's unread mark now follows the messages the repair renumbers instead
  of skipping the tail of the channel, and every pass logs its result instead of
  staying silent when it removes nothing (#1209)
- Agent detail cards render inside channels (#1225)
- WS catch-up budget prioritizes fresh rows over resync (#1280)
- Palette channel selection opens the channel (#1289)
- Unread bootstrapped from `GET /channels` on sidebar mount (#1290)
- Cockpit escape hatches clear `activeChannelId` (#1291)
- New-chat button no longer no-ops after adding a project (#1302)
- A chat you create with an explicit repo or terminal target now runs in the
  workspace you just selected, instead of in the project of whatever terminal
  was still open (#1303)
- Agent presence no longer sticks on "thinking"/"streaming"/"waiting" after an
  agent's runtime dies without a clean finish: every teardown path now ends in a
  terminal idle for the header chip and the in-timeline presence row, posts still
  queued behind the dead agent are released with a system row instead of staying
  counted against it, and a busy status that has gone stale with nothing bound is
  retired on the client (#1307)

### Agent profiles and DM routing

#### Added

- `@`-mention routing: roster, spawn-on-first-mention, streamed replies (#1180)
- `AgentProfile` actor model with a default-per-vendor mention resolver, so `@claude` and `@codex` are a vendor's default profile rather than its only contact (#1233)
- Initials-avatar component for profile identity (#1235)
- Profile-aware `@`-mention autocomplete with collision disambiguation (#1236)
- Per-profile config editor, CRUD route, and vendor gallery (#1275)

#### Changed

- Sender attribution re-keyed from the vendor framework to the profile Actor id (#1234)
- Channel binding re-keyed to the `AgentProfile` actor id (#1276)

#### Fixed

- DM messages route to the DM profile without requiring a literal mention (#1304)

### Agent runtimes and orchestration

#### Added

- Persistent-subprocess Claude adapter over `stream-json`, with no Agent SDK dependency (#1176)
- Codex web sessions revived for channel mentions (#1182)
- `spawnedBySessionId` session lineage (#1256)
- Scoped-actor `sessions.create` gateway verb for orchestrator worker spawn (#1258)
- Orchestrator peer ladder: single-channel echo (#1265), two-channel read and relay (#1267), spawn-and-instruct workers via `@`-mention (#1269)
- Scoped-actor mail loop, cwd session creation, chat-landing live sessions (#1270)
- Persistent orchestrator lifecycle backend spine (#1271)
- Operator route to designate a channel's persistent orchestrator (#1272)
- Operator/orchestrator UX: designate control and orchestrator badge (#1273)
- Cockpit orchestrator-to-workers lineage tree (#1274)

#### Fixed

- Codex reasoning content and terminal status on thought cards (#1210)
- `claudeArgs` no longer leak into non-Claude agent spawns (#1237)
- Codex `initialPrompt` driven as a native positional arg (#1240)
- `--add-dir` gated to Claude in multi-repo spawns (#1260)

### Messages

#### Added

- Message hover toolbar, deep links, retry on failed rows, edit/delete, system-event coalescing (#1314)
- Full-text message search: FTS5 index, two-section sidebar results, palette category, jump-to-message (#1315)
- Cross-device read-state sync: hub-persisted last-read marks, unread stays client-derived (#1317)
- OS notifications, favicon badge, and title count while the tab is hidden (#1319)
- Mid-turn steering: queued-for-next-turn with an interrupt-and-send-now affordance (#1320)

#### Fixed

- Archived channels threaded into chat search (#1288)
- Message search no longer freezes the hub on a broad query. A prefix that would
  expand across too much of the transcript is now declined before the index is
  read, and any search that outruns its wall-clock budget is abandoned instead of
  holding the server; both answer "type more characters" rather than a misleading
  "no matches". Ordinary searches are unchanged. (#1316)
- A recreated DM whose stored read marker outlived the old channel now repairs
  itself from the hub's answer: the unread dot returns with the next message,
  and later read marks reach your other devices again instead of being swallowed
  (#1318).

### Self-update and releases

#### Added

- Auto-restart under generic systemd supervision after a verified update (#1301)
- Release-candidate install channel: `npm install -g relay-ide@rc` gets a stable-shaped build that is soaking before it becomes the default install. `vX.Y.Z-rc.N` tags publish to the npm `rc` dist-tag and cut a prerelease GitHub Release; the stable lane refuses any prerelease version, so an rc can never land on `@latest`
- `CHANGELOG.md` as the release-note source of truth. Stable and rc tags cut a GitHub Release whose body is the matching changelog section, and a tag with no matching section fails before anything is published

#### Changed

- Rewrote the README — the npm landing page — for the 0.1.1 product: a real
  first-run quickstart (hub, PIN, add project, new chat, `@mention`), the
  execution-workbench boundary stated up front, the shipped message layer
  (search, edit/delete, retry, deep links, read sync, notifications, steering),
  the three install channels with a `CHANGELOG.md` pointer, and a corrected CLI
  list. `relay-ide --help` now documents `node update` and the `sessions`
  command family, so the README's "run `--help` for the exact set" holds. (#1327)

#### Fixed

- `/update` detects the running install's package manager and verifies the update actually landed (#1286)

### Security and infrastructure

#### Added

- Hub/node security policy schema (#500)
- Hash-chained security audit log (#507)

#### Fixed

- Hub health and session restore hardened (#1200)
- `web_sessions` agent transcript growth bounded (#1243)
- Per-connection WS send queues bounded and half-open sockets reaped (#1249)
- Recursive directory watch pruned per level, fixing a daily-hub event-loop wedge (#1249), with follow-up walker edge cases (#1261)
- Session-teardown resource-hygiene sweep (#1262)
- `sharp` lazy-loaded so CLI startup never eagerly loads its native binding (#1278)
- Startup fails fast when persistence cannot initialize instead of booting amnesiac (#1279)
- Event loop yielded during session resume so HTTP is served while sessions rehydrate (#1282)

#### Security

- `NO_PIN` auth bypass removed (#831)
- Runtime SQLite artifacts kept out of repo checkouts, so session state stops landing in a tracked working tree (#961)

## [0.1.0] - 2026-04-03

Package renamed from `claude-remote-cli` to `relay-ide` and first published under
the new name. Published from `nightly` without a git tag, so there is no release
tag to link — the npm version is the record.

[Unreleased]: https://github.com/donovan-yohan/relay-ide/compare/v0.1.1...nightly
[0.1.1]: https://github.com/donovan-yohan/relay-ide/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/relay-ide/v/0.1.0
