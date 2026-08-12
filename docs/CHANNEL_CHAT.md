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

External agents use the separate actor-authenticated NDJSON adapter:

```sh
relay-ide v1 channels subscribe --channel-id topic:general --after-seq 42 --json
```

It shares the hub's register-before-replay handoff and bounded subscriber set;
there is no second replay ring. Each frame reports the last safe `durableSeq`.
Only committed rows advance it, so text deltas can be rendered live without
moving the reconnect cursor past their owning row. Exact `channelIds` scope and
`context:read` are checked before registration, and revoked actor credentials
terminate established streams on their next validation interval.

The CLI output is a discriminated v1 frame stream: every `open`, `event`, and
`closed` frame has `schemaVersion: 1`, `channelId`, `sequence`, `occurredAt`,
and `durableSeq`;
`event` frames carry a required versioned channel-event payload, and `closed`
frames carry a required reason plus retryability. A bounded consumer stops
parsing immediately after its `--max-events` frame and cancels the upstream
reader; stdout backpressure is drained rather than treated as a dropped frame.

### Read state and unread

Unread is derived client-side; the _marker_ it derives from converges through
the hub. `ChannelView` captures a channel's last-read sequence into
`frontend/src/lib/stores/channel-activity.ts`, which is the fast path and
persists to local storage. The same store pushes the mark to
`PUT /channels/:id/read-state`, seeds from `GET /channels/read-state`, and
applies `channel-read-state` broadcasts on `/ws/events`.

The hub is a point of convergence, not a source of truth:

- **Monotonic up.** Merges only ever advance a mark. A device that is behind
  cannot pull another device's channel back to unread.
- **Clamp-epoch fence.** A recreated DM reuses its deterministic channel id, so
  stale hub marks are fenced by the same per-channel clamp epoch the
  channel-list seed uses; a fresh channel does not inherit a dead one's mark.
- **Forward-only convergence.** Reading on one device settles the badge on the
  others. Nothing marks a channel unread remotely.

Unread counts themselves are never stored — they are computed from the marker
against the durable sequence.

## Search

`GET /channels/search` queries an FTS5 virtual table
(`channel_messages_fts`) that `server/channel-message-store.ts` maintains as an
external-content mirror of the searchable subset of `channel_messages`, kept in
sync by insert/update/delete triggers. Operator text is translated into a MATCH
expression; terms with no letter or digit are dropped.

- **Refused vs. empty are distinguishable.** Blank text, no letter/digit, or a
  single term under the minimum length returns an explicit `unavailableReason`
  instead of an empty result set, so the client never prints "no matches" for a
  query the index never ran.
- **Visibility is an allowlist pushed into the query.** Archive state and titles
  live in `workspace_topics`, a separate database from the message log, so the
  visible-channel set is resolved first and passed into the index query.
  Filtering after the fact would let archived hits crowd out live ones.
- **Reach is the corpus, not the rail.** The allowlist is built from
  `listAllTopicIds()`, not the sidebar read model's capped `list()`. The rail's
  cap is a rendering budget; using it silently made older channels unreachable.
- `includeArchived`, `limit`, `channelId`, and `workspaceId` scope the search.

The UI surfaces results in two sidebar sections (channels and messages), as a
command-palette category, and as jump-to-message navigation into the timeline.

## Message mutation and retry

Edits and deletes are operator-only and durable, and neither can raise an agent
turn.

- `PATCH /channels/:id/messages/:messageId` rewrites the body in place. Same id,
  same `seq`, new body, `meta.editedAt` stamped. The seq space stays gap-free.
- `DELETE /channels/:id/messages/:messageId` stamps `meta.deletedAt`.
- Both broadcast directly through the hub rather than going through
  `postToChannel`, so mention-routing handlers never observe them. Editing a
  message that mentioned an agent does not re-trigger it.
- Sender attribution is server-derived on both routes: a body carrying `sender`
  or `source` is rejected outright rather than ignored, and a non-human sender
  is refused. An agent cannot edit or delete anyone's message, including its
  own.
- Archived channels refuse edit, delete, and retry.

`POST /channels/:id/messages/:messageId/retry` re-drives a failed row through
the binder. It writes a durable `retrying @…` system row and appends a whole new
agent turn, which is why an archived channel refuses it. A message that is not
retryable, or a binding that is already mid-turn, returns a typed reason code
(`CHANNEL_AGENT_BUSY` and friends) rather than silently doing nothing.

### Deep links

`buildChannelMessageLink` in `frontend/src/lib/url-nav.ts` produces
`/channel/<segment>#msg-<message id>`; `parseMessageAnchor` is its inverse.
Resolving an anchor that is not in the loaded window walks older history pages,
bounded by `ANCHOR_WALK_MAX_PAGES` (8) in `ChannelView.tsx`. Unbounded, a link
to a deleted or foreign message id would walk the channel to `seq` 1 on every
open; bounded, the worst case is a fixed number of page fetches and one toast.

## Notifications and badges

While the tab is hidden, unread activity raises an OS notification and marks the
favicon and title. The runtime lives in `frontend/src/lib/notify/`:

- `leader.ts` elects one leader tab, so N open tabs raise one notification
  rather than N.
- `os-notification.ts` owns permission state and delivery.
- `favicon-badge.ts` and `title-badge.ts` own the tab-level count.
- `signals.ts` and `producers.ts` derive what is worth announcing.

`notify-settings.ts` holds operator preferences (Settings → notifications) and
`notify-badge.ts` holds the derived count. Notifications read the same
client-derived unread state described under "Read state and unread" — they do
not introduce a second source of truth.

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

`server/channel-agent-binder.ts` owns message-to-agent routing:

1. subscribe to newly posted channel messages;
2. resolve explicit mentions against agent profiles;
3. for an unmentioned human message, resolve the DM recipient or the product
   channel's existing designated orchestrator;
4. start or reuse one private runtime per `(channel, profileActorId)`;
5. build a bounded context packet from durable channel history;
6. queue or steer and deliver the turn through the provider adapter;
7. mirror the provider response into the originating channel or thread.

Implicit human routing (step 3) follows this matrix:

- DM channel → the default profile for the DM's provider, exactly as if the
  provider had been mentioned. Threads included: a thread reply routes
  implicitly too. Both DM composers therefore drop the `@ to mention` hint.
- Non-DM product channel with a durable `role=orchestrator` binding → that
  designated profile. Delivery uses the exact same FIFO/native-steer path as an
  explicit mention, including thread placement and queue limits. If the hub
  restarted and its private runtime is gone, this first turn cold-resumes a new
  orchestrator-role runtime from the binding's provider session.
- Non-DM channel without a designated orchestrator → nothing, silently (debug
  log only). No role is created or upgraded by sending a message.
- Agent or system sender → no implicit route. Agent-authored explicit mentions
  keep the existing collaboration/brake behavior, but an unmentioned agent row
  can never loop back into the orchestrator.

Any explicit agent mention wins over these defaults and routes only to the
mentioned profile(s). This remains true when a durable pinned mention no longer
resolves, so Relay never silently substitutes a DM agent or orchestrator for the
operator's intended recipient.

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

### Delegation completion callbacks

An explicit agent-to-agent `@mention` creates a durable, per-routed-turn
callback edge from the delegator to the delegatee. The edge is scoped to the
channel and thread, original trigger message, requester and target profile,
target runtime, and target turn identity. It is Relay routing state, never a
synthetic chat row.

The directional invariant is: **delegation travels downward; completion travels
upward; completion never creates a reverse delegation.** The one-shot lifecycle
is `pending → satisfied → delivered → consumed`, with a separate terminal
`delivered → undeliverable` outcome when Relay cannot ever deliver the internal
callback; guarded SQLite transitions make late or duplicate provider terminal
patches inert. `undeliverable` retains the delegatee's terminal reason plus a
safe Relay delivery reason, is excluded from recovery/claims, and prunes under
the same bounded settled-history policy. A delivered callback remains
recoverable until the requester adapter resolves its typed-trigger acceptance;
hub startup re-offers any such volatile FIFO offer. Relay uses the same
deterministic recipient turn id and client-message id on every re-offer. Only
that post-accept CAS consumes the edge, so a crash before Relay calls the
adapter cannot lose it and a late Relay retry cannot fabricate a second Relay
wake. The generic provider adapter contract has no durable provider acceptance
receipt or declared external idempotency capability, however: a process crash
after an external provider accepts input but before Relay observes the promise
may produce an at-least-once external dispatch on recovery. Consumed rows retain
bounded idempotency history while unresolved parent/child ancestry is preserved.

- Completed, failed, interrupted, unexpected-disconnect, safe-idle fallback,
  and watchdog terminalization can satisfy an edge. A watchdog with no prose
  response explicitly carries `no-terminal-message`.
- A raw provider `idle` is not enough. Approval/waiting state keeps the edge
  pending until Relay's guarded terminal lifecycle observes a real boundary.
- Relay sends a typed internal completion trigger that references the delegatee
  final message and terminal reason. It does not add a row pretending the
  delegatee wrote an `@mention`. If the delegatee already explicitly returns to
  its requester in its final row, that ordinary route consumes the edge and
  suppresses the automatic duplicate.
- Nested delegation is durable fan-in: if B delegates C (or C and D) while
  handling A, B's first terminal stores its evidence but A waits. Each child
  completion wakes B once; only the last callback-triggered B continuation
  releases A. A callback-triggered response has no reverse edge unless it makes
  a new explicit downstream delegation.

Callback delivery uses the existing per-profile FIFO, so a busy requester is
queued behind its live turn. Downward callback edges are persisted before the
delegatee enters that FIFO; queue-cap rejection terminalizes that edge upward
instead of silently losing it. The consecutive agent-turn brake remains in
force for every normal mention route and admits child intent only after its
turn passes the brake.

An externally authenticated actor is not an installed requester profile. It
observes a mentioned agent's reply through the authorized durable channel
history/subscription surface; Relay does not provision a profile or launch a
runtime for its provider id. If a legacy/internal automatic callback names an
unavailable requester profile, Relay immediately terminalizes that callback as
`undeliverable` with `requester-profile-unavailable` rather than retrying it.
If SQLite cannot persist that terminal CAS, Relay makes a capped exponential
storage-write retry (not a requester/profile retry), then leaves the durable
row `delivered` and the channel archive-unsafe with an inspectable terminalization
failure reason plus one final diagnostic. It never claims `undeliverable` unless
the CAS actually landed.
For nested delegation, any upward ancestry that depends on that impossible
continuation terminalizes as `continuation-undeliverable`; Relay never invents
a reverse delegation or acceptance. Transient binding/adapter failures remain
on the recoverable delivery path. Correlated external run status is deliberately
separate work (#1391).

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
persists that role independently of the ephemeral runtime id, starts or reuses
its private runtime, and exposes the role in the channel roster.

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

- **Queue (default).** Human posts that arrived while the agent was busy drain
  into ONE next turn. The newest of them is the trigger; the rest arrive as
  context rows of the same packet, because the packet is rebuilt from the
  durable message log. Three impatient messages cost one turn, not three.
- **What never coalesces.** Coalescing folds older posts into a newer one's
  packet, so it only applies where that fold is lossless. A run stops at a post
  from another thread scope, an agent-authored post, a post whose sequence
  number is not strictly newer than the run's head, or a post carrying **image
  attachments** — the per-packet image budget is per packet, not per message, so
  an image-bearing post keeps one-trigger-one-turn and its own budget. Anything
  the run stops at simply drains on the following completion.
- **Re-queued sends never coalesce, in either direction.** A send retried after
  a transport failure is re-queued behind whatever arrived meanwhile, and the
  turn that displaced it has already advanced the binding's delivery cursor past
  its sequence number. Context rows are selected with `seq > lastDeliveredSeq`,
  so such a post cannot survive as a context row of anyone else's packet — it
  would be neither trigger nor context and would vanish. It therefore always
  triggers its own turn, where the packet footer renders it unconditionally,
  whether it sits at the head of a would-be run or in the middle of one. At the
  queue cap it is never superseded and never supersedes; that case takes the
  explicit drop row instead.
- **Interrupt and send.** The post route takes an explicit `steering` body
  field set to `"interrupt"`. It cancels the live turn through the same
  interrupt path the header control uses — the partial reply finalizes
  `interrupted` — and the new message triggers as soon as that turn releases.
  Steering is never inferred from message text.
- **Agent posts never steer.** Sender attribution is server-derived, so an
  agent (including a CLI-gateway actor) cannot cancel another agent's turn, and
  agent-authored triggers are never coalesced away. Agent fan-out stays bounded
  by the consecutive-agent-turn brake.
- **Queue cap.** The per-binding cap still bounds distinct queued turns. An
  over-cap post that would have coalesced with the queue tail supersedes it
  instead of being refused — same trigger, same packet — so fast operator typing
  is never announced as dropped. Anything the tail cannot represent — see "what
  never coalesces" above — still produces the explicit drop row.
- **Idempotent replay still steers.** The post route dedupes on
  `clientMessageId`, and the composer keeps that id after a failed send. A
  replay that carries `steering` therefore applies the interrupt to the
  already-persisted row rather than swallowing it; the message is not re-routed,
  because it is already queued. The replay skips a binding whose live turn was
  triggered by that same message: if it drained between the two posts, the turn
  now running IS the operator's answer, and cancelling it would be the opposite
  of what they asked for.
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
can miss its chip, and one that was already consumed can never keep one. Marks
are swept on every insert, so the client's memory of them is bounded by sends
still waiting rather than by session length.

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
