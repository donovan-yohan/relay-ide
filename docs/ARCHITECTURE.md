# Architecture

Relay is a channel-first collaboration hub over local and paired execution
nodes. The hub owns the browser application, durable conversations, profile
identity, routing, policy, and the stable CLI gateway. Nodes own local
processes, terminal execution, files, repositories, and worktrees.

## Product model

| Concept       | Meaning                                                      |
| ------------- | ------------------------------------------------------------ |
| Channel       | Durable conversation and ordered message history             |
| DM            | Deterministic channel targeting one agent profile            |
| Agent profile | Durable participant actor plus provider launch configuration |
| Runtime       | Private provider execution handle owned by a channel binding |
| Session       | Terminal/process execution handle, not a conversation        |
| Thread        | Replies rooted in a message inside the same channel          |
| Workspace     | Saved grouping and routing configuration                     |
| Node          | Local or paired machine that owns execution and paths        |

The conversation identity never depends on a provider runtime id. A runtime may
end or be replaced while the channel, profile actor, messages, and threads stay
stable.

## System shape

```text
browser clients
  ├─ channels, DMs, threads, profiles, roster, orchestration
  ├─ terminal/file/diff/artifact/settings surfaces
  └─ authenticated REST + WebSocket
          │
          ▼
Relay hub
  ├─ channel message/attachment stores
  ├─ channel fan-out, mention binder, agent bridge, private runtimes
  ├─ workspace topics, profiles, roster, WorkContexts
  ├─ auth, policy, audit, integrations
  ├─ stable CLI gateway
  └─ local node + paired-node router
          │
          ▼
execution nodes
  ├─ relay-pty terminals and agent CLIs
  ├─ filesystem and repository state
  └─ capability manifest + reverse node link
```

## Channel path

### Shared contract

`shared/channel-chat-protocol.ts` defines message identity, sender identity,
mentions, message parts, streaming/terminal status, snapshots, deltas,
completion events, reducer state, history merge behavior, and bounds.

`shared/agent-profile.ts` defines profile actor identity and built-in profile
ids. Provider ids describe execution adapters; profile actor ids describe
participants.

### Persistence

`server/channel-message-store.ts` owns `channel-chat.db`:

- messages ordered by channel-local sequence;
- source/client idempotency indexes;
- thread roots and replies;
- channel membership;
- channel/profile binding and provider resume state.

`server/channel-attachments.ts` owns sanitized image metadata and payloads.
Runtime data lives under the Relay config directory.

### HTTP and live events

`server/channel-chat-router.ts` exposes authenticated, capability-checked
channel operations:

- list/get channels;
- page channel history;
- search message history (`GET /channels/search`, FTS5-backed);
- read/write operator read-state (`GET /channels/read-state`,
  `PUT /channels/:id/read-state`);
- upload/read channel image attachments;
- read a thread;
- post a message or reply;
- edit a message (`PATCH /channels/:id/messages/:messageId`);
- delete a message (`DELETE /channels/:id/messages/:messageId`);
- retry a failed message (`POST /channels/:id/messages/:messageId/retry`);
- read the channel roster;
- designate an orchestrator;
- interrupt an agent;
- answer an approval.

Edit, delete, and retry are operator-only and archived channels refuse them.
Edits and deletes broadcast directly rather than through the post path, so they
never raise an agent turn.

`server/channel-hub.ts` owns live WebSocket fan-out on
`/ws/channels/:channelId`. SQLite is the catch-up buffer. The hub coalesces
deltas, bounds connect queues and snapshots, and forces sequence-based resync
when a client falls behind.

### Agent execution

`server/channel-agent-binder.ts` resolves profile mentions, owns one binding per
channel/profile pair, supplies bounded context, queues turns, and applies the
agent-turn brake.

`server/channel-agent-runtime.ts` owns private provider execution handles.
These handles are not public sessions, terminal tabs, or conversation
destinations.

`server/channel-agent-bridge.ts` reduces provider patches into channel-native
text, detail cards, images, and terminal states. It is the only presentation
bridge between provider execution events and channel messages.

Provider adapters implement `ProtocolAdapterV2` and emit `AgentPatchV2`.
Provider-specific payloads remain inside the adapter/extension boundary.

## Frontend path

The live conversation tree is:

```text
ChatHome
  └─ ChannelView
       ├─ ChannelTimeline
       │    └─ ChannelMessageRow
       │         ├─ AssistantMarkdown
       │         ├─ AgentDetailCard
       │         └─ ChannelImagePart
       ├─ ChannelComposer
       └─ ChannelThreadPanel
```

`useChannelChatSocket` combines REST history with channel WebSocket events,
reduces them through the shared protocol reducer, reconnects from the last
durable sequence, and exposes REST posting.

Zustand stores own browser-local navigation, unread, and live agent-status
state. TanStack Query owns server reads such as topics, profiles, rosters,
nodes, and integrations.

## Hub and node boundary

The hub is also a local node through `server/local-node.ts`. Paired nodes:

1. authenticate to the hub;
2. publish a capability manifest and heartbeat;
3. hold an outbound `/hub/node-link` WebSocket;
4. receive hub-mediated, capability-checked operations.

Nodes never address peer nodes directly. Cross-node work is hub-mediated and
authorized per leg. Paths are node-scoped; the hub does not pretend that a
remote checkout is a hub-local path.

Public terminal sessions use `relay-pty`/libghostty-vt. xterm.js renders
terminal bytes in the browser. Browser reconnect can reattach to a live Relay
process, but a Relay server restart cold-resumes saved metadata and scrollback
rather than supervising the child process across restart. Agents participate
through channels and DMs; their private channel runtimes are protocol-adapter
processes, not public terminal sessions.

## Stable external agent contract

External agent brains use the versioned CLI gateway:

```text
relay-ide v1 <resource> <action> --json
```

The contract is declared in `shared/cli-gateway-contract.ts` and projected
through the relay command manifest and action descriptors. Private browser
routes, node-link envelopes, provider adapters, and raw database tables are not
stable adapter APIs.

The gateway covers node discovery, session/process actions, files, channel
posting (`channels.post`), WorkContexts, context packets, artifacts, handoffs,
and bounded supervisor reads/actions as advertised by the installed command
manifest. `channels.post` is the only channel verb; channel reads (list,
history, search) are browser routes, not gateway verbs.

## Main code map

### Server

| Module                     | Responsibility                                              |
| -------------------------- | ----------------------------------------------------------- |
| `index.ts`                 | Composition root, auth, persistence boot, routers, upgrades |
| `channel-message-store.ts` | Durable channel log, members, bindings                      |
| `channel-attachments.ts`   | Sanitized native image storage                              |
| `channel-chat-router.ts`   | Channel REST API and controls                               |
| `channel-hub.ts`           | Live channel fan-out, catch-up, backpressure                |
| `channel-agent-binder.ts`  | Mentions, profile bindings, context, queues                 |
| `channel-agent-runtime.ts` | Private provider runtime lifecycle                          |
| `channel-agent-bridge.ts`  | Provider patches to channel messages/cards                  |
| `agent-profile-store.ts`   | Durable profile configuration                               |
| `agent-profile-router.ts`  | Profile CRUD/default routes                                 |
| `workspace-topics.ts`      | Channel/workspace metadata and routing defaults             |
| `sessions.ts`              | Public terminal/process session registry                    |
| `pty-handler.ts`           | `relay-pty` process and terminal lifecycle                  |
| `hub-node-registry.ts`     | Paired node identity and heartbeat state                    |
| `hub-node-router.ts`       | Hub-mediated node operations                                |
| `node-link-client.ts`      | Node-side reverse link                                      |

### Shared

| Module                      | Responsibility                      |
| --------------------------- | ----------------------------------- |
| `channel-chat-protocol.ts`  | Channel messages/events/reducer     |
| `agent-chat-protocol-v2.ts` | Provider adapter patch model        |
| `agent-profile.ts`          | Durable agent profile identity      |
| `workspace-topics.ts`       | Workspace/channel metadata contract |
| `cli-gateway-contract.ts`   | Stable CLI JSON schema              |
| `relay-node-protocol.ts`    | Internal hub/node protocol          |
| `control-state.ts`          | Process/tab control state           |

### Frontend

| Area                                    | Responsibility                         |
| --------------------------------------- | -------------------------------------- |
| `components/chat/Channel*`              | Conversation, thread, composer, images |
| `components/chat/AssistantMarkdown.tsx` | Markdown and code rendering            |
| `components/chat/AgentDetailCard.tsx`   | Rich collapsible agent output          |
| `hooks/useChannelChatSocket.ts`         | Channel history/live state             |
| `lib/stores/channel-activity.ts`        | Browser-local unread state             |
| `lib/stores/channel-agent-status.ts`    | Live profile status                    |
| `components/TopicSidebarShell.tsx`      | Channel and active-work navigation     |
| `components/WorkspaceArea.tsx`          | Terminal/file/diff/artifact surfaces   |

## Persistence and startup

Persistence services initialize before routes accept work. Required-store
failure stops startup rather than running without durable state. Channel store
startup repairs abandoned streaming rows to an honest terminal state and
cleans invalid bindings.

Config and SQLite files live under:

- `~/.config/relay-ide/` for installed/global Relay;
- `~/.config/relay-ide/dev/<slug>-<hash>/` for source development.

## Security boundaries

- Browser routes require authenticated cookies.
- CLI actors use scoped credentials and command-specific capabilities.
- Channel agent attribution is server-derived from its private runtime.
- Image bytes are decoded, bounded, sanitized, and content-addressed.
- Node routing is hub-mediated; a node credential cannot impersonate a peer.
- Audit stores metadata, hashes, and decisions rather than raw prompts,
  transcripts, secrets, or PTY input by default.

See [`SECURITY_POLICY.md`](SECURITY_POLICY.md) for the full policy.

## Architecture decisions

- [ADR-015](adrs/ADR-015-core-primitives-domain-agnostic.md) — core primitives
  remain domain-agnostic.
- [ADR-016](adrs/ADR-016-node-to-node-isolation.md) — all inter-node work is
  hub-mediated.
- [ADR-017](adrs/ADR-017-brain-as-peer-cli-session-events.md) — retained
  hub-level CLI boundary; its conversation ownership model is superseded by
  ADR-020.
- [ADR-018](adrs/ADR-018-command-mediated-handoff-supervisor.md) — handoff and
  supervision are command-mediated.
- [ADR-019](adrs/ADR-019-context-packet-storage-and-primitive.md) — context
  packets live in hub-owned durable storage.
- [ADR-020](adrs/ADR-020-channel-is-conversation.md) — current conversation and
  agent-runtime ownership model.
