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

- Issue revocable, expiring Relay operator-client credentials for non-browser
  human clients. The separate `relay:operator-client:v1` lane supports the
  existing stable channel list/get/history/post/subscribe surface with optional
  exact channel scope, only `context:read`/`context:write`, server-derived human
  attribution, safe subscription revalidation, metadata-only lifecycle views,
  and one-time handshake-grant or authenticated-operator issuance.
- Let a still-valid operator-client credential renew itself through
  `POST /operator-client-credentials/renew`: the successor copies client,
  device binding, capabilities, channel scope, and originating grant (grant
  revocation still cascades), while the old token expires naturally so a lost
  renew response can never lock a client out.
- Search durable message history in a complementary right rail while channel
  navigation and threads remain visible. Active channels with resolved human
  metadata seed an editable exact `in:<channel>` scope; unresolved or global
  entry points remain truthfully unscoped, and mobile search uses a dismissible
  full-screen panel. Agent responses can also collapse completed activity into
  compact summaries for a responses-first reading mode (#1402)
- Route unmentioned human messages in product channels to the durably
  designated orchestrator, including cold resume after hub restart, through the
  existing queue and native-steer paths; explicit mentions remain authoritative
  (#1353)
- Run Prime Agent as a built-in terminal and channel provider through its native RPC mode (#1340)
- Run Pi as a built-in terminal and channel provider through its native JSONL RPC mode (#1349)
- Discover Prime Agent model and live-evidenced reasoning controls from the
  connected runtime in the `@agent/` command palette (#1345, #1377)
- Create and name new folders directly in the local Add Project browser (#1338)
- Start project-scoped channels and direct messages from per-project sidebar
  add controls, with an explicit project selector in New Chat (#1347)
- `@agent/` opens a provider-aware command palette for channel controls,
  including Codex Fast Mode, model, and reasoning-effort changes (#1344)
- In agent DMs and their thread composers, bare `/model` and `/effort` are
  discovered generically from the DM provider's live exact-default-profile
  catalog and apply to the exact DM profile without posting a channel message;
  agent chat rows show immutable per-turn model and effort attribution when
  exposed by the provider
- Inspect provider-visible reasoning in provider-neutral collapsible turn details,
  with a persisted collapsed or expanded default for new summaries (#1361)
- Publish canonical, exact-head pipeline handoff review evidence through the
  existing WorkContext artifact and CLI surfaces (#1368)
- Expose stable CLI gateway commands for scoped channel list, get, history,
  thread-history, roster, and post access (#1372)
- Stream scoped channel replies through a durable, resumable
  `channels.subscribe` CLI gateway contract without per-message blocking waits
  (#1389)
- Add a local stdio `relay-mcp` façade with a closed eight-command channel
  allowlist, environment-only credentials, bounded subscriptions, and public
  provider-diagnostic redaction (#1399)
- Add bounded server-side semantic filters to durable channel subscriptions so
  agent consumers can wait for principal or terminal replies without receiving
  detail/tool traffic, while preserving safe resume cursors (#1390)
- Correlate concurrent routed channel posts, replies, and terminal lifecycle
  updates through durable provider-neutral asynchronous run and target ids;
  idempotent post retries return the original run (#1391)
- Deliver durable, exactly-once upward completion callbacks for explicit
  agent-to-agent channel delegations, including restart recovery, busy-agent
  FIFO queueing, nested child fan-in, and explicit-return de-duplication (#1359)
- Reversibly archive idle channels from the active conversation header, with
  inline confirmation and the existing older-channel restore path (#1382)
- Add durable named conversations with isolated thread-scoped agent runtimes,
  controls, and recent activity navigation (#1386)

#### Changed

- The new-chat composer now lets operators create normal channels, and DMs cannot be designated as orchestration channels (#1337)
- Mid-turn channel sends now steer Codex and Claude at their native safe tool
  boundary by default, while harnesses without that primitive retain a clearly
  labelled FIFO queue fallback
- Agent context packets went on a token diet: threaded turns now deliver only
  messages since the agent's last turn instead of re-sending the whole thread
  window (a fresh runtime still gets the root and orientation window), DMs get a
  direct-conversation header instead of the multi-party one, empty delivery
  counts disappear, mid-turn steering messages drop the envelope, and every
  packet carries a machine-readable `[relay channel-id=… trigger-seq=…]` line
  agents can use with `relay-ide v1 channels post` (#1408)

#### Fixed

- Allow a grant-backed operator-client issue request that omits `scope` to
  inherit a validated, exact channel-only grant scope, while malformed,
  wildcard, non-channel, and broader requests continue to fail closed.
- Filtered channel subscriptions now resume without duplicate delivery by
  applying streamed catch-up state replacements to already-known messages
  (#1398)
- Terminalize completion callbacks to unavailable requester profiles as durable,
  inspectable `undeliverable` rows instead of repeatedly retrying or spawning a
  fabricated external requester runtime; scoped external actors continue to
  observe replies through durable channel history/subscriptions (#1392)
- Keep Settings and Add Project scrolling inside their intended panes so modal
  content cannot become displaced in an unreachable hidden scroll offset (#1384)
- Make reasoning status styling exhaustive, distinguish nested-only designation
  conflicts from unknown 409s, and lock every channel provider to a shared
  launch-command, profile-PATH, and environment-sanitization matrix (#1368)
- Channel mention packets now exclude blank tool, reasoning, status, and system
  activity rows, report shown/filtered counts, and use a smaller prose window
  so real conversation is not displaced by empty activity (#1358)
- Bound each mention-context SQLite statement to the newest 256 raw candidates
  and label summaries as lower bounds when older channel or thread history is
  omitted (#1358, #1368)
- Enforce one durable channel orchestrator with a transactional first-writer
  conflict and a partial unique index, including safe legacy repair (#1365, #1368)
- Designate-orchestrator failures now show actionable inline conflict or retry
  feedback instead of failing silently (#1352)
- Designation errors now retire when the roster confirms an orchestrator and
  stay bounded without collapsing the mobile channel header (#1352)
- Long channel drafts now grow to a conversation-pane-relative cap instead of
  inner-scrolling after six lines, while preserving most of short mobile
  timelines (#1355)
- Existing Codex channel conversations now recover after a hub/runtime restart,
  and user message bubbles no longer collapse into character-by-character
  wrapping (#1339)
- Keep all-archived workspaces empty in the active channel list instead of
  resurrecting their WorkContexts as derived ghost rows (#1382)

### Agent runtimes

#### Added

- Agents can now look up channel history themselves. Every bound agent runtime
  receives a scoped read-only credential for its own channel, channel search is
  available to in-scope agents through the gateway (`relay-ide v1 channels
search`), and Claude channel agents get the Relay MCP facade mounted
  automatically so history, threads, and roster lookups work without asking a
  human to paste context. Codex agents get the same credential for the CLI;
  their MCP mount is deliberately skipped because Codex starts MCP servers with
  a stripped environment the credential cannot reach (#1410)

#### Fixed

- Pi and Prime Agent no longer silently drop a message queued behind an active
  turn when the session ends. The queued send now reports the failure instead of
  reporting success, so the channel retries and re-offers the message rather
  than marking it delivered and never sending it
- Codex and Hermes agents now receive the profile system prompt and Relay's
  collaboration contract, so a channel agent behaves the same whichever harness
  runs it. Hermes sends that prompt as one byte-stable block on every turn;
  OpenCode profiles still cannot be given one on this transport, and Relay no
  longer implies otherwise (#1409)
- Interrupting a Hermes agent no longer wipes the conversation: the next message
  continues from the last completed response instead of starting a
  context-free one (#1409)
- OpenCode channels no longer claim to resume after a restart. A restarted
  OpenCode session reports the truth up front rather than silently answering
  from an empty history (#1409)
- A failed turn now ends exactly once on Hermes, OpenCode, and attached
  OpenCode, carrying its error text, instead of leaving a turn that never
  visibly finishes or finishes twice (#1411, #1412)
- Tool approvals no longer stay actionable forever when an agent session
  disconnects while one is outstanding. Every provider now cancels the
  outstanding request on its own wire and marks the approval card cancelled with
  the reason, so a reopened channel never shows live-looking Allow/Deny controls
  for a session that is gone (#1407)
- Reap owned agent process trees after channel-runtime failure or replacement,
  report aggregate runtime resource health, and let operators explicitly release
  idle channel agents (#1019)
- Apply Codex model, reasoning-effort, and Fast Mode controls through stable
  turn overrides, stop advertising unimplemented Claude controls, and pass
  profile effort into Claude launches (#1375)
- Discover Prime Agent model controls from the current RPC runtime before
  advertising them, show thinking only for explicit live model metadata, and
  keep fresh-session and compaction controls hidden pending a capability source (#1377)
- Agent profiles whose launch command is missing now appear unavailable in channel rosters and mention palettes, and spawn races report an actionable configuration error instead of raw `ENOENT` (#1357)
- Codex reasoning cards now show expandable provider-generated summaries when available, and no longer show inactive expand chevrons when no summary exists
- Terminal-style text field block cursors now align with the input content line
  and remain aligned while the text scrolls.

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
