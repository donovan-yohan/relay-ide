# Channel conversations

Relay's collaboration model is:

- **channel = conversation**
- **DM = channel with one agent profile**
- **agent = participant**
- **runtime = private execution handle**

There is no separate agent-chat destination. People and agents post durable
messages into the same channel timeline, and threads remain part of that
channel.

## User surface

`ChatHome` opens `ChannelView` for the selected channel. The live rendering
path is:

```text
ChannelView
  ├─ ChannelTimeline
  │    ├─ ChannelMessageGroup
  │    └─ ChannelMessageRow
  │         ├─ AssistantMarkdown
  │         ├─ AgentDetailCard
  │         └─ ChannelImagePart
  ├─ ChannelComposer
  ├─ ChannelThreadPanel
  └─ channel roster and orchestrator controls
```

`ChannelMessageRow` renders human, agent, and system rows. Agent prose uses
Markdown. Reasoning, tool calls, code, output, and diffs use collapsible detail
cards with syntax highlighting and diff tint. Streaming rows update in place;
terminal states include complete, truncated, interrupted, and failed.

`ChannelComposer` posts text and up to four sanitized image attachments. The
same composer is used for top-level messages and thread replies. Mention
suggestions come from the channel roster.

## Durable model

`shared/channel-chat-protocol.ts` defines the public message and event
contract:

- a channel-local, monotonically increasing `seq`;
- human, agent, or system sender identity;
- Markdown or text bodies;
- top-level or threaded placement;
- streaming and terminal message states;
- parsed mentions;
- native image parts;
- optional typed agent detail cards;
- source identifiers used for idempotency and attribution.

`server/channel-message-store.ts` owns `channel-chat.db` in the Relay config
directory. It stores:

- channel messages;
- channel members;
- channel-to-profile runtime bindings and provider resume state.

History is paginated and byte-bounded. Source and client-message uniqueness
constraints make replay and retries idempotent. Thread replies share the
channel sequence and carry their root message id.

`server/channel-attachments.ts` stores sanitized, content-addressed images
beside the config database. It validates decoded type and dimensions, strips
metadata through re-encoding, caps payload and pixel size, and serves
attachments through authenticated channel routes.

## Live delivery

`server/channel-hub.ts` owns per-channel subscribers and in-flight streaming
accumulators. The durable SQLite sequence is the replay buffer; the hub does
not keep a second event log.

Browser flow:

1. `GET /channels/:id` resolves current channel metadata.
2. `GET /channels/:id/messages` reads bounded history.
3. `/ws/channels/:id?sinceSeq=N` delivers a snapshot or catch-up followed by
   live events.
4. `POST /channels/:id/messages` writes human or authenticated agent messages.
5. The reducer in `shared/channel-chat-protocol.ts` detects gaps and requests
   catch-up.

The hub coalesces text deltas and applies socket watermarks. A lagging client
can reconnect from its last durable sequence instead of requiring an
unbounded in-memory queue.

Unread position is browser-local. `ChannelView` captures a channel's last-read
sequence and the activity store mirrors it to local storage; the durable
channel store does not claim cross-device read receipts.

## DMs and profiles

A DM is a deterministic channel targeting one agent profile. Built-in profiles
exist for supported providers, and users can create or edit profile
configuration through the profile store/router.

The profile actor id is the durable participant identity. Provider id, model,
permission mode, and other launch configuration decorate that actor; they do
not replace it. Multiple profiles from one provider remain distinct
participants.

Channel roster state is derived from profiles, provider availability, durable
bindings, and current runtime state. The UI can show spawning, thinking,
streaming, waiting, and idle status without exposing a private runtime as a
conversation.

## Mentions and private runtimes

`server/channel-agent-binder.ts` owns mention routing:

1. subscribe to newly posted channel messages;
2. resolve mentions against agent profiles;
3. start or reuse one private runtime per `(channel, profileActorId)`;
4. build a bounded context packet from durable channel history;
5. queue and deliver the turn to the provider adapter;
6. mirror the provider response into the originating channel or thread.

`server/channel-agent-runtime.ts` owns the private execution handle. A channel
agent runtime is intentionally absent from public session lists, terminal
WebSockets, workbench tabs, and session restoration. The binder is its
product-facing owner. Durable binding rows retain provider resume state so a
replacement runtime can continue the participant's provider context when the
adapter supports it.

`server/channel-agent-bridge.ts` is the presentation boundary between provider
patches and channel messages. It:

- attributes rows to the durable profile actor;
- streams assistant text into durable channel rows;
- converts reasoning/tool/code/output/diff items into bounded detail cards;
- attaches provider-produced images through the channel attachment store;
- finalizes incomplete streams honestly on interruption, error, or shutdown;
- deduplicates provider replays by source identity.

The provider adapter protocol remains internal execution infrastructure.
Conversation state and rendering are always channel-native.

## Threads

Thread replies use the root message id as `threadId` and
`parentMessageId`. `GET /channels/:id/threads/:rootMessageId` returns the root
plus bounded replies. `ChannelThreadPanel` opens beside the main timeline and
posts through the same authenticated message route.

Agent replies stay in the triggering thread. Detail-card rows may carry thread
placement for cold replay, but they are not counted as conversational replies.

## Orchestration and controls

A channel may designate one persistent orchestrator profile. The designation
route grants the orchestrator role through the operator-authenticated lane,
starts or reuses its private runtime, and exposes the role in the channel
roster.

Agent runtimes may create or operate public terminal workers through the scoped
actor gateway when their capability grant permits it. Those workers are
terminal/process execution only. Agent participants, orchestration, and durable
replies remain in channels and DMs; no worker terminal becomes a second agent
conversation.

Channel controls include:

- interrupt an active profile turn;
- approve or deny an in-channel approval request;
- inspect roster availability and live status;
- designate the channel orchestrator.

## Limits and failure behavior

- Message bodies and detail payloads are byte-bounded.
- History, snapshots, connect queues, turn queues, and detail caches are
  bounded.
- Mention routing has a consecutive-agent-turn brake so agents cannot fan out
  forever without a human or gateway post.
- Missing providers, queue overflow, approval requests, and runtime failures
  produce explicit system rows.
- Restart-abandoned streaming rows become `truncated`; completed history is
  retained.
- Archived channels reject new posts until restored.

## Acceptance paths

Changes to channel behavior should prove the live surface and the owning seam:

- `ChannelView → ChannelTimeline → ChannelMessageRow` for rendering;
- channel store/router/hub tests for persistence, pagination, replay, and
  backpressure;
- binder/bridge tests for mentions, profile identity, streaming, cards,
  images, threads, and failure states;
- Playwright channel fixtures for browser interaction and scroll anchoring.

An isolated card or Markdown fixture is useful component coverage, but it does
not prove the channel product path.
