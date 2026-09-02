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

### Channel Adapters

#### Added

- First-class Antigravity (`antigravity`) channel adapter driving the `agy` CLI
  in headless stream-json mode over stdin/stdout with streaming text, typed tool
  cards (`run_command`, file modifications, dynamic tools), token usage aggregation,
  interrupts via SIGINT, and session resumption (#1508)
- DeepSeek Harness is a built-in channel agent: mention `@dsh` (or a named dsh
  profile) to run the harness over the Agent Client Protocol as a private
  channel runtime, with streamed replies, reasoning, command, file, and tool
  cards, permission prompts you answer in the channel, a Stop button that
  really cancels the turn, and a conversation that survives a reconnect.
  Credentials come from the profile's `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`;
  attachments and structured questions are not offered on this lane (#1535)

#### Fixed

- The read-only dsh session list no longer offers `dsh --resume <id>` as a
  copyable resume command. No shipped dsh app accepts that flag, so the command
  always failed; dsh sessions now report that native resume is unavailable and
  point at the dsh channel agent instead (#1520)

### CLI help and channel commands

#### Fixed

- `relay-ide --help` now lists `login` and `logout`, and
  `relay-ide <command> --help` prints that command's own usage instead of the
  root page. `relay-ide login --help` documents the device-code flow and
  `relay-ide v1 --help` prints the full grouped gateway verb list with the
  `--json` requirement and the credential-resolution order (#1471)
- `relay-ide v1 channels get|history|roster|subscribe|post` now work on the
  hub's own machine without `relay-ide login`. Previously only `channels list`
  did: every command naming a channel was refused with a
  `CLI_ACTOR_WRONG_CHANNEL_SCOPE` error. On that machine the CLI can now read
  and post in any channel, matching the rest of the local-terminal trust
  boundary. Credentials issued to remote or delegated agents are unchanged and
  still reach only the channels they are scoped to (#1476)
- An expired `relay-ide login` credential file (`actor-token.json`) no longer
  shadows the boot-minted local hub token. When renewal of a stored login
  credential fails, the CLI logs a warning and falls through to the host-local
  token before failing, and automatically removes credentials expired beyond
  their renewal window (#1484)

#### Added

- `relay-ide v1 channels create --title <title>` creates a channel from the CLI
  (the ergonomic alias for `workspace-topics create`), and the `v1` usage line
  now advertises every wired channels verb — `list`, `get`, `history`,
  `threads history`, `roster`, `search`, `subscribe`, `run get`, and `post` —
  which were dispatchable but undiscoverable (#1472)

### Channel mentions

#### Fixed

- Mentioning a custom agent profile by its multi-word name (for example
  `@Tako Planner`) from the browser or the local CLI now stores the whole
  mention and the resolved profile id on the message row. Previously the row
  kept only the first word (`@Tako`) with no profile, so the stored mention
  disagreed with where the message was actually delivered and
  `relay-ide v1 channels subscribe --mention-target-id <profile id>` never
  matched those posts. Editing a message re-resolves its mentions the same
  way. The agent binder is now the single mention resolver for both the
  stored row and delivery, so the two cannot drift again (#1503)

#### Changed

- Vendor mentions such as `@claude` now also carry the resolved default
  `profileId` (`agent-profile:<vendor>:default`) in `channels post` and
  `channels history --json` output, and a named-profile mention carries its
  vendor `providerId`. As a result `--mention-target-id <vendor>` now matches
  mentions of every profile of that vendor, not only `@<vendor>`; filter on
  the profile id for an exact match. Rows written before this release are not
  rewritten (#1503)

### Hub-authoritative channel membership

#### Added

- Channels now keep a durable member list, and Relay records who admitted each
  member. Mentioning an agent adds it to the channel and credits whoever
  mentioned it, so a conversation carries its own roster instead of inferring
  one from who happened to speak. Anyone already in a channel can bring an
  agent in this way, including another agent (#1455)

#### Changed

- An external agent using a `relay-ide v1 ...` credential can now only read,
  search, subscribe to, or post in channels it belongs to; anything else is
  refused with a `CHANNEL_NOT_MEMBER` error. Channel listings and unscoped
  searches show only the agent's own channels. The browser, your own machine's
  CLI, and Relay's own agent runtimes are unaffected (#1455)
- Existing channels keep working through the change: everyone already taking
  part becomes a member automatically, and issuing an agent a credential for a
  channel now admits it to that channel. An agent still cannot reach a channel
  created after its credential was issued until someone mentions it there
  (#1455)

### Channel invites and removals

#### Added

- `relay-ide v1 channels members|invite|remove-member --json` manage who belongs
  to a channel from the terminal. `members` shows each participant with the time
  they joined and who admitted them; `invite` brings an agent profile in; and
  `remove-member` takes a membership away — closing the gap where an agent
  admitted to a channel could never be removed from it. Relay always records the
  inviter and remover from the caller's own credential, so the audit cannot be
  forged, and there is no flag to claim otherwise (#1455)
- Creating a channel now makes its creator the first member, so an agent that
  opens a channel from the CLI can immediately post in it (#1455)

#### Changed

- Who may remove whom: you in the browser, and your hub's own terminal, can
  remove any agent. An agent can remove only itself — leaving a channel it no
  longer needs — or an agent it invited, and never a person. A removal takes
  effect on the member's next request, and a subscription it already had open
  stops within about a second (#1455)
- Removing a person, or your hub's own terminal, is refused rather than
  silently doing nothing. Neither reaches channels through membership, so
  removing them would take a name off the list without taking any access away
  (#1455)
- A removed agent stays out until somebody invites it back or mentions it by
  name — including across restarts, and while Relay keeps running that agent's
  own background bookkeeping. Mentioning it is an invite, credited to whoever
  mentioned it, exactly as it is for an agent that was never in the channel
  (#1455)
- A channel accepts up to 128 members, so a looping agent cannot grow the list
  without bound. Removing someone frees a slot (#1455)

### Agent credentials that survive a restart

#### Added

- Every agent profile can now hold its own long-lived Relay credential, so an
  agent running somewhere else — a Hermes profile on another host, say — can
  talk back to Relay as itself. Mint it from Settings → Agents, or with
  `relay-ide v1 agent-profiles credential mint --id <profile> --json`. The token
  is shown once, when you create it, and is never retrievable afterwards; Relay
  keeps only a hash of it (#1455)
- Settings → Agents shows each profile's credential state, when it was issued
  and expires, and roughly when it was last used, with buttons to mint, rotate,
  and revoke. `relay-ide v1 agent-profiles credential status|revoke --json`
  answer the same questions from the terminal (#1455)

#### Changed

- A credential you mint for an agent profile now survives restarting Relay.
  Previously every credential Relay issued lived only in memory, so restarting
  the hub silently invalidated any token you had planted on another machine.
  Revocations survive a restart too — a revoked token stays revoked (#1455)
- What an agent profile's credential can reach is decided by which channels the
  profile belongs to, not by a channel list fixed when the credential was
  minted. So a channel created after the fact is reachable as soon as the
  profile is invited or mentioned there, with no re-minting. The profile is
  still refused any channel it is not a member of, and credentials issued to
  other agents are unchanged (#1455)
- Rotating a profile's credential revokes the previous one as it issues the new
  one, and deleting a profile revokes its credential. Neither leaves a working
  token behind (#1455)

### Planting an agent credential on the agent's own host

#### Added

- `install-profile-credential` plants a minted profile credential into an agent
  host's per-profile environment file, which is the last step in letting an
  agent on another machine talk back to Relay as itself:

  ```sh
  relay-ide v1 agent-profiles credential mint --id <profile> --json \
    | node dist/scripts/install-profile-credential.js \
        --profile-env ~/.hermes/profiles/<profile>/.env
  ```

  The token travels down the pipe, so it never appears in a command line, a
  shell history, or the script's output. Re-running it rotates the value in
  place rather than appending a second one, every other line of the file is left
  exactly as it was, a backup is taken first, and a file other users can read is
  refused rather than written to. The hub has to be on the same machine or
  reachable on its loopback port — `relay-ide v1` dials `127.0.0.1` only
  (#1455)

- `docs/references/hermes-multiplex-setup.md` now carries the end-to-end recipe
  for a Hermes profile: mint, plant, and the one line a turn needs in order to
  read the credential — plus what Hermes does and does not hand a tool from a
  profile's `.env` (#1455)

### CLI-only agent-profile setup

#### Added

- `relay-ide v1 agent-profiles list|get|create|update --json` configures agent
  profiles without opening the web UI — create a profile, bind it to a Hermes
  multiplex profile, and set or clear its gateway key from the terminal on the
  hub host. The key is never accepted as a bare command-line value; pass it with
  `--hermes-api-key-env <VAR>`, `--hermes-api-key-file <path>`, or
  `--hermes-api-key-stdin`, and it is never returned by any read. Profile writes
  require host-local operator authority, so an agent's own delegated credential
  cannot mint or rebind a profile (#1473)

### Long-running hub memory

#### Fixed

- A hub with an open channel stream no longer accumulates security audit
  entries for the life of the process. Relay re-checks the agent credential
  behind a channel subscription before every frame, and every successful check
  used to be recorded and kept forever — hundreds of KB a second on a busy
  stream, the same shape as the leak that once pushed a hub past 15 GB of
  memory. The audit log is now a bounded window of the most recent entries, and
  an unchanged repeated check updates the entry it repeats instead of adding a
  new one, so revocations and denials stay visible in it (#1485)
- The handshake-grant audit log no longer grows for the life of the hub either.
  Every grant a browser or CLI asks for, approves, redeems, denies, or revokes
  used to be recorded and kept forever, so a long-lived hub slowly accumulated
  entries it never read back. It is now the same bounded window of recent
  entries, with an unchanged repeated check folded into the entry it repeats
  (#1487)

### Startup performance

#### Fixed

- Launching Relay no longer fires a separate pull-request lookup for every
  repository. Branch PR and staleness badges are backfilled in one batched
  request, and navigating right after launch joins the pass already running
  instead of starting a second one — noticeably faster first load on hubs
  tracking many repos (#1456)

### Pull-request badge refresh

#### Fixed

- A burst of GitHub webhook activity no longer fires a separate pull-request
  lookup for every repository it touches. All of them are refreshed in one
  batched request, so PR and CI badges settle faster when several repositories
  update at once (#1457)

### Native session listing performance

#### Changed

- `sessions native list` and `sessions native get` now answer in milliseconds
  instead of seconds. Relay caches each provider transcript's summary until the
  file actually changes, reads providers concurrently, and resolves a session id
  straight to its transcript, so a repeat listing of ~1,000 Claude and Codex
  sessions returns in about 0.1 s instead of ~5 s and a single session read in
  under 50 ms instead of ~2.5 s. A transcript that has been appended to is
  re-read on the next listing, so results stay live (#1449)
- That speed now survives a hub restart. Relay keeps the transcript summaries in
  a small cache file beside its other data and re-checks each transcript's size
  and timestamps before trusting one, so the first `sessions native list` after a
  restart answers in about 0.3 s instead of ~5 s while a transcript that changed
  while the hub was down is still re-read. The cache is rebuildable and capped,
  and deleting it only costs one slow listing (#1459)

### Faster repo, project, and workspace-tree reads

#### Fixed

- Surfaces that list repos, projects, and workspace trees — session create, the
  node dashboard, and the environment picker — now open in milliseconds instead
  of stalling on a fresh git scan of every repo. The scan is shared between
  them, runs its git calls in parallel under a bounded ceiling, and refreshes
  immediately whenever a repo, branch, or worktree changes (#1448)
- The environment picker no longer computes dirty state, branch divergence, and
  worktree listings only to throw them away, and the worktree list loads
  noticeably faster (#1448)

### Typed channel delivery receipts

#### Added

- Addressed and mention-routed channel messages now emit additive,
  content-free `channel-delivery-receipt-v1` lifecycle events covering queue,
  runtime, policy, offline, watchdog, failure, and supersede outcomes. Recent
  receipts fan out on the existing channel event stream and are queryable with
  `GET /channels/:id/receipts` (exact message/target filters, channel-scoped
  `context:read` authorization). The orchestrator peer consumes typed receipts
  when available and retains its legacy text-ack fallback against older hubs
  (#1442).

### Antigravity CLI native-session support

#### Added

- Google's Antigravity CLI (`agy`) is now a supported native-session provider:
  `relay-ide v1 sessions native list/get/import/watch --provider antigravity`
  read the local `~/.gemini/antigravity-cli` store read-only. Listing groups
  `history.jsonl` by conversation; import normalizes brain transcripts
  (`USER_INPUT` / `PLANNER_RESPONSE` with thinking + tool calls + answers,
  typed tool steps, attributed gaps for unknown records); conversations backed
  only by opaque `.pb` artifacts list with an honest per-session signal and
  import their real user turns from history (#1439).
- Live watch streams appended brain-transcript records onto the scoped
  `native-sessions` topic within the poll interval, with durable byte cursors
  that survive restart without replay or gap. Resume argv is copyable only:
  `agy --conversation <id>`. No channel adapter yet — Antigravity cannot serve
  channel agents until that lands (#1439).

### CLI login and actor credential lifecycle

#### Added

- `relay-ide login`: one browser/PIN approval authorizes a machine for the
  scoped CLI actor lane. The CLI starts a short-lived one-time flow, prints a
  verification URL and human code (`XXXX-XXXX`), and polls; the hub serves an
  approval page (device name, requested capabilities, expiry) that requires
  PIN re-entry as the consent act. The minted scoped actor credential is
  delivered exactly once to the CLI and stored at
  `~/.config/relay-ide/actor-token.json` with `chmod 600` (#1435).
- `relay-ide login status` reports presence, actor id, capabilities, and
  expiry without printing token material; `relay-ide logout` removes the
  stored file and best-effort revokes the credential on the hub (#1435).
- `POST /cli-gateway/actor-credentials/renew`: the current valid actor token
  mints its own successor with the same actor/capabilities/scope
  (rotate-before-expiry). The predecessor is not revoked — it expires within
  its own TTL window — so a lost renew response cannot lock the CLI out, and
  explicit revocation still cuts access immediately (#1435).
- `v1` actor-lane commands now fall back to the stored `relay-ide login`
  credential when `RELAY_IDE_ACTOR_TOKEN`/`--actor-token` is unset
  (precedence: flag > env > file). Within 120 seconds of expiry the CLI
  transparently renews and atomically rewrites the file; revoked or expired
  credentials fail closed with guidance to run `relay-ide login` (#1435).

#### Changed

- Scoped actor credentials minted by the hub now default to a 30-day TTL,
  configurable via `cliGatewayActorCredentialMaxTtlMs` in `config.json`
  (previously fixed at 15 minutes); explicit per-issue TTLs above the ceiling
  are still rejected (#1435).

#### Fixed

- `relay-ide v1 sessions native watch` now marks its phase-one tail-start POST
  as CLI gateway v1, so scoped actor credentials — including credentials stored
  by `relay-ide login` — reach actor authentication instead of failing with a
  401 before session-scope validation (#1428, follow-up to #1437).
- The `relay-ide login` approval page parses browser form submissions again
  (the global JSON body parser cannot read urlencoded forms, so every PIN
  submit was silently empty) and the 'PIN required' / 'Invalid PIN' error
  paths now re-render the approval form with retry instead of a dead-end
  page; the page styling matches the hub's black terminal aesthetic (#1435,
  follow-up to #1437).

#### Fixed

- `relay-ide v1 sessions native import` works with scoped actor credentials:
  the import route is a POST but strictly read-only against provider stores,
  and it now sits on the actor read lane beside `watch` instead of failing
  with CLI_ACTOR_ROUTE_UNSUPPORTED (#1426, follow-up to #1429).

### Native session surface

#### Added

- DeepSeek Harness (DSH) native session state is real: a new `dsh` provider
  adapter detects the local `~/.dsh/sessions` store
  (`<project-slug>/session-<uuid>/session.jsonl.zstd`, concatenated zstd
  frames of JSONL), decodes multi-frame logs with graceful torn-tail handling,
  lists sessions scoped to a `cwd` with redacted previews and header-derived
  timestamps, imports transcripts into read-only `AgentSessionV2` read models
  (user turns from real user messages, reasoning evidence from
  `reasoning-chunks`, consolidated assistant messages; harness-internal
  injections and stream deltas stay attributed gaps), and returns bounded
  provider state snapshots (#1426).
- Live native-session tails cover DSH: a framed-zstd byte-cursor tailer
  re-decodes only newly appended complete frames (torn trailing frames wait
  until closed) and the `normalizeDshLiveEvent` normalizer maps
  `user/message`/`assistant/message`/`reasoning-chunks` onto the shared
  live-event vocabulary, everything else as attributed gaps;
  `sessions native watch --provider dsh` streams them like Claude/Codex/Pi,
  with durable cursor resume across hub restarts (#1426).

### Native session surface

#### Added

- Pi native session state is real: the Pi adapter now detects the local
  `~/.pi/agent/sessions` store (one cwd-slug bucket per working directory,
  per-session JSONL files), lists sessions with redacted previews and
  timestamps scoped to a `cwd`, imports transcripts into read-only
  `AgentSessionV2` read models with audit markers and FIFO truncation, and
  returns bounded provider state snapshots — previously it reported
  `unsupported` because local persistence was not yet verified (#1426).
- Live native-session tails cover Pi: a provider normalizer maps Pi's
  `session`/`message`/`model_change`/`thinking_level_change`/`compaction`
  JSONL records onto the shared live-event vocabulary, including
  `toolCall` blocks and `toolResult` messages; unmapped events stay
  explicit gaps. `sessions native watch --provider pi` streams them like
  Claude/Codex, with durable cursor resume (#1426).

#### Changed

- `canStreamLiveEvents`, `canImportTranscript`, and `canReadProviderState`
  are now `true` for the Pi adapter; its resume argv (`pi --resume <id>`)
  is unchanged (#1426).

### Native session surface (live tails)

#### Added

- Live native-session tail streaming (Claude and Codex): a generic offset-based
  JSONL tailer with durable per-session byte cursors survives hub restarts with
  no replay and no gap, normalizes raw provider events onto the shared live
  vocabulary (user/assistant/reasoning/tool-call/tool-result), and publishes
  redacted, size-bounded events on the new scoped `native-sessions` gateway
  topic. Partial trailing lines are held back until complete; rotation and
  truncation reset cleanly; unmapped events are published as explicit gaps and
  logged, never silently dropped (#1428).
- `relay-ide v1 sessions native watch --provider <p> --native-id <id> --json`
  streams normalized live events as newline-delimited gateway envelopes with
  cursor resume, max-events, and idle-timeout controls. The verb is read-only
  observation: it never writes to native sessions or injects input (#1428).
- `canStreamLiveEvents` is now `true` for Claude and Codex adapters. Pi stays
  honestly `false`: its RPC path has not been proven end-to-end (#1428).

#### Changed

- Gateway subscriptions to the `native-sessions` topic require `session:read`
  and validate scoped actor credentials against the native session id,
  failing closed for underscoped actors (#1428).

#### Fixed

- Scoped actor CLI credentials can subscribe to
  `relay-ide v1 events subscribe --topic native-sessions` again: the hub no
  longer remaps the expected `x-relay-cli-command` header for that topic,
  which made every legitimate CLI subscription fail with 401 UNAUTHORIZED.
  Session scoping is unchanged and still enforced by the sessionId grant
  check (#1428, follow-up to #1430).

### Native session surface (foundation)

#### Added

- List, read, and import native provider sessions (Claude, Codex, Pi) through
  one unified read-only surface: `relay-ide v1 sessions native list|get|import
--json`. The cross-provider adapter registry aggregates sessions from every
  installed adapter with graceful per-provider install status, so a missing or
  unsupported provider degrades to a diagnostic instead of breaking the
  aggregate response (#1427).
- Widen `NativeSessionProvider` to include `pi` alongside claude, codex, hermes,
  and opencode. The Pi adapter honestly reports `unsupported` because Pi is
  RPC-based and does not expose session history over its protocol or via local
  files — no data is faked (#1427).
- New CLI gateway scopes `sessions.native.list`, `sessions.native.get`, and
  `sessions.native.import` enforced via the existing actor-auth pattern
  (`requireCliGatewayAuthForActorCommand`); unauthenticated or underscoped
  requests fail closed (#1427).

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

### Hermes profile binding

#### Added

- A Hermes agent profile can now be bound to a named Hermes gateway profile, so
  that agent's turns, interrupts, and approvals all run against that profile
  instead of the gateway's default one — two agents in the same channel can hold
  two different Hermes profiles. Hermes agents with no binding are unchanged. A
  binding the gateway does not serve, or has no key for, now says which profile
  failed and what to fix on the channel row instead of a bare HTTP error (#1462)
- Settings can now set that binding: a Hermes agent profile carries a "hermes
  profile" field that routes the agent to a named gateway profile, and leaving
  it blank keeps using the gateway default. A name the gateway could never
  serve is refused inline before the profile can be saved, and every bound
  profile shows which Hermes profile it is on in the agent list (#1463)
- Each bound Hermes profile can now carry its own gateway API key, so a named
  Hermes profile with its own `API_SERVER_KEY` authenticates as itself instead
  of failing with a 401 against the default profile's key. The key is
  write-only: Settings shows only whether one is set and offers a clear action,
  and Relay never returns it once saved. Profiles with no key of their own, and
  unbound Hermes agents, keep using the gateway default key exactly as before
  (#1453)

### Zero-login CLI on the hub host

#### Added

- `relay-ide v1 …` now works from any terminal on the machine running the hub
  with no `relay-ide login` and no environment variable. The hub mints a
  local CLI credential at boot and stores it owner-only (`chmod 600`) in its
  config directory, keyed by port so several hubs coexist; the CLI picks it up
  for the loopback port it is dialing. The credential lives only in memory, so
  restarting the hub rotates it, and the stored credential expires within a day
  so a copied or backed-up file stops working on its own. A machine that is not
  the hub host still uses `relay-ide login`, and a caller without the file still
  gets the same 401 as before. Set `RELAY_IDE_DISABLE_LOCAL_ACTOR_TOKEN=1` to
  turn it off (#1467)

#### Changed

- The CLI now honors `RELAY_IDE_CONFIG` when resolving its config directory, so
  it points at the same hub a from-source or `dev:backend` launch is using
  instead of the installed hub's config (#1467)

#### Security

- File RPC now refuses every read, list, stat, tail, and write inside Relay's
  own config directories — and, for a hub pinned with `RELAY_IDE_CONFIG`, the
  config file and the credential files beside it — so a session scoped to your
  home directory can no longer hand an agent the PIN hash, a stored login
  credential, the node credential, or the node identity key. A running
  `tail --follow` is re-checked on every poll, so swapping the followed file
  for a link into the config directory stops the stream instead of leaking it
  (#1467)
- Diagnostics bundles now redact bare Relay credential tokens found in log
  text, not just ones behind an `Authorization: Bearer` prefix (#1467)
- `config.json` is written owner-only and an existing world-readable one is
  tightened on the next save; it carries the PIN hash (#1467)

### Agent browser

#### Fixed

- Installed copies of Relay now ship the browser-automation driver.
  `playwright` was only ever present in the development checkout, so
  `relay-ide-browser` and the agent browser tools answered "Playwright is
  unavailable" on any `npm install relay-ide`. It is now a declared runtime
  dependency, pinned with the rest of the tree. Chromium is still a separate
  download, and it has to be the build that Relay's pinned Playwright expects
  — a bare `npx playwright install` resolves whatever Playwright is newest and
  can still leave the feature unavailable (#1477)

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
