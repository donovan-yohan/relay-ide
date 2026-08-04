# Backend design

Relay's TypeScript backend uses a composition-root architecture:
`server/index.ts` initializes required stores and wires single-purpose modules,
routers, WebSocket upgrades, auth, policy, and shutdown.

## Core decisions

- Channels own conversation history.
- Agent profiles own participant identity.
- Private channel-agent runtimes own provider execution.
- Public sessions own terminal/process execution.
- SQLite stores initialize before the server accepts work.
- The hub owns routing and policy; nodes own local paths and processes.
- Stable agent integrations use the versioned CLI/action contract.
- Interactive terminals use `relay-pty`/libghostty-vt.

## Configuration and state

Configuration precedence:

1. CLI flags
2. environment variables
3. config file
4. defaults

Global state lives under `~/.config/relay-ide/`. Source development uses an
isolated path under `~/.config/relay-ide/dev/`. The checkout is not the runtime
database directory.

Durable stores use schema-versioned migrations and fail startup when a
required store cannot initialize. Channel messages and bindings live in
`channel-chat.db`; attachments use their own store and content-addressed
payload directory.

## Channel conversations

`ChannelMessageStore` owns ordered rows, members, threads, idempotency keys, and
profile bindings. The channel hub owns live subscribers and streaming
accumulators. SQLite is the replay/catch-up buffer.

The channel router applies browser or scoped actor auth plus `context:read` /
`context:write` capability checks. Agent attribution is server-derived from
the private runtime; callers cannot forge an agent sender with request JSON.

The binder resolves mentions to profiles, creates/reuses a private runtime,
assembles bounded context, queues the turn, and invokes the adapter. The bridge
reduces provider patches into durable channel rows and rich detail cards.

## Private agent runtimes

`ChannelAgentRuntime` is intentionally not a public `Session`. It is:

- held in the channel runtime manager;
- owned by one channel/profile binding;
- absent from session lists and terminal routes;
- destroyed when its binding/runtime ends;
- recreated with stored provider resume state when supported.

Provider adapters implement `ProtocolAdapterV2`. Adapter capabilities,
environment refresh, interruption, approvals, provider session ids, and patch
lifecycle remain internal runtime contracts.

## Public sessions and terminals

Public sessions are terminal process handles with cwd, node, optional
repo/worktree context, display/control state, and bounded scrollback. Agents do
not own public sessions; they participate in channels through private
`ChannelAgentRuntime` handles.

`relay-pty` owns interactive child-process execution. xterm.js is the browser
renderer. Browser reconnect can reattach while the Relay server and child
remain live. Relay server restart cold-resumes saved terminal
metadata/scrollback; it does not preserve the old child process.

Scrollback is capped and evicted FIFO. Writes/resizes after session reaping fail
closed rather than throwing through the socket.

## Hub and nodes

The local hub is also a node. Paired nodes authenticate independently and hold
an outbound reverse link. The hub:

- tracks heartbeat/capability state;
- authorizes each routed operation;
- aggregates federated reads;
- routes terminal/file/session operations to the owning node.

A node never receives another node's credential or acts as another node.

## Auth and policy

- Browser clients authenticate with the Relay PIN cookie.
- Hooks use per-runtime or per-session scoped tokens.
- CLI actors use scoped credentials and advertised capabilities.
- High-risk node actions pass through policy and confirmation lanes.
- Audit rows store compact ids, decisions, hashes, and redaction metadata.

## Images

Channel image ingress:

1. accepts bounded multipart uploads;
2. decodes bytes to determine actual format;
3. rejects unsupported types, excessive bytes, or excessive pixels;
4. strips metadata by re-encoding;
5. content-addresses the sanitized payload;
6. persists a typed channel image part.

Terminal paste remains a separate session input feature and must not be used as
channel image storage.

## Services

The background hub runs under launchd on macOS or a user systemd service when
available on Linux. Service install/status/logs/uninstall are exposed by the
CLI. Node service support is capability-detected, including WSL2 variants.

## Extension rules

- Add a focused module instead of expanding `index.ts` with domain logic.
- Put shared wire/schema types under `shared/`.
- Keep provider-native behavior inside adapter modules.
- Add storage migrations through the owning store's version runner.
- Bound every history, stream, queue, attachment, and agent-output path.
- Put tests at the interface that owns the invariant.

See [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`CHANNEL_CHAT.md`](CHANNEL_CHAT.md), and
[`provider-guide.md`](provider-guide.md).
