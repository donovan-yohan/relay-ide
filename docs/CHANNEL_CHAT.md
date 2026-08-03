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
3. fall back to implicit DM routing when a human message resolves none;
4. start or reuse one private runtime per `(channel, profileActorId)`;
5. build a bounded context packet from durable channel history;
6. queue and deliver the turn to the provider adapter;
7. mirror the provider response into the originating channel or thread.

Implicit DM routing (step 3) is the routing half of "a DM is a channel with one
agent". A message with zero resolved mentions is routed as follows:

- DM channel, human sender → the default profile for the DM's provider, exactly
  as if the provider had been mentioned. Threads included: a thread reply in a
  DM routes implicitly too. Both DM composers therefore drop the `@ to mention`
  hint.
- DM channel, agent sender → nothing. An agent's own DM post cannot re-trigger
  the DM's agent; the mention self-filter cannot see a message with no mentions.
- Multi-party channel → nothing, silently (debug log only). Humans chat there
  without addressing an agent, so a system row would be spam.

A DM whose provider cannot be resolved at all posts one `nothing was routed`
system row per five-minute dedupe window, because in a DM there is nobody else
to answer and silence reads as the product being broken. That row is gated on
the trigger's sender kind, so an agent's own unroutable `@mention` never stamps
a failure under the human message that did route.

DM-ness itself is derived, not stored: `shared/dm-channels.ts` recomputes the
deterministic per-`(workspace, provider)` DM id and compares it to the topic's
own id, so both halves — the UI's DM affordances and the binder's routing —
read one pure derivation. A DM's agent is that provider's default profile,
matching the DM-per-provider id formula.

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

### Mid-turn steering

Posting to a channel whose bound profile is already mid-turn never opens a
second concurrent turn and never drops the message. The post joins that
binding's FIFO queue, and the queue drains on turn completion.

- **Queue (default).** Every human post that arrived while the agent was busy
  drains into ONE next turn. The newest of them is the trigger; the rest arrive
  as context rows of the same packet, because the packet is rebuilt from the
  durable message log. Three impatient messages cost one turn, not three.
- **Interrupt and send.** The post route takes an explicit `steering:
  "interrupt"` body field. It cancels the live turn through the same interrupt
  path the header control uses — the partial reply finalizes `interrupted` — and
  the new message triggers as soon as that turn releases. Steering is never
  inferred from message text.
- **Agent posts never steer.** Sender attribution is server-derived, so an
  agent (including a CLI-gateway actor) cannot cancel another agent's turn, and
  agent-authored triggers are never coalesced away. Agent fan-out stays bounded
  by the consecutive-agent-turn brake.
- **Queue cap.** The per-binding cap still bounds distinct queued turns. An
  over-cap post that would have coalesced with the queue tail supersedes it
  instead of being refused — same trigger, same packet — so fast operator typing
  is never announced as dropped. Anything the tail cannot represent (another
  thread, an agent-authored trigger) still produces the explicit drop row.
- **Observability.** The `channel-agent-status` event and the roster's
  `binding` object both carry `queuedCount`.
- **Restart.** The queue is in-memory turn-trigger state. A hub restart loses
  pending triggers but never loses messages — every queued post is already
  durable — and the operator re-triggers by sending again.

#### Steering in the UI

The composer is the steering surface. While a bound agent is mid-turn its bar
reveals two explicit controls — no menu, no inference:

- **queue** (also plain <kbd>enter</kbd>) posts with no steering field, so the
  message waits for the live turn.
- **interrupt & send** (also <kbd>cmd/ctrl</kbd>+<kbd>enter</kbd>) posts
  `steering: "interrupt"`, reusing the header control's black-square vocabulary.
  With no live turn the modifier is a plain send, never a silent variant.

The thread panel's composer inherits both, because a threaded reply queues on
exactly the same binding.

Two read-back affordances make the wait visible:

- the in-timeline presence row suffixes the agent's activity with
  `(n queued)`, resolved from `queuedCount` on the same lane its status came
  from (socket transition or roster snapshot, whichever is newer);
- a message the operator sent into a busy agent grows a dim chip reading
  `queued — <agent> is mid-turn`.

**The chip's signal.** Steering intent is deliberately not persisted, so the
durable row cannot say a message is waiting; the chip is client-side memory of
the send. It is created from the send-time agent status and retired by a
per-agent _drain generation_ derived from `queuedCount`: the generation advances
on any transition that reports an empty queue, which is exactly what the binder
emits when it splices the queued run out, immediately before the consuming turn
starts. A send snapshots the generation before its POST and keeps the chip only
while that snapshot is still current, so a turn that drains during the round trip
leaves no chip behind. Both imprecisions fail toward silence: a send that queued
can miss its chip, and one that was already consumed can never keep one.

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
