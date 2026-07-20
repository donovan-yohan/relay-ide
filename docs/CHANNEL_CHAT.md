# Channel conversations

> **Status: current shipped architecture.** Verified 2026-07-20 against the
> channel store, router, hub, binder, adapters, React channel surface, mobile
> cockpit, and their tests. This document supersedes the retired
> `WEB_CHAT.md` session-centric design and the historical
> `CHAT_FIRST_SIMPLIFICATION.md` implementation ladder.

Relay's primary collaboration unit is a durable conversation, not an agent
process.

- **Channel = conversation.** Humans and multiple agents share one ordered
  timeline.
- **DM = channel.** A direct message is a workspace channel whose routing
  metadata identifies one agent participant.
- **Agent = participant.** Mentioning `@claude`, `@codex`, `@opencode`,
  `@hermes`, or a configured provider routes work to that participant. The
  backing adapter session is execution infrastructure and may be spawned,
  reused, rebound, interrupted, or recovered without changing channel identity.
- **Thread = channel-scoped branch.** Replies retain the channel's durable
  sequence while carrying `threadId` and `parentMessageId` relationships.

The desktop web UI pairs the conversation with terminal, file, diff, and
artifact surfaces. The mobile UI is a mission-control cockpit: it ranks work
that needs attention, shows agent presence, and offers bounded controls and
short replies. It is not a phone-sized editor.

## Current user path

1. `TopicSidebarShell` renders workspaces, channels, and DMs from one channel
   tree on desktop and mobile.
2. Selecting a channel writes `activeChannelId`; `ChatHome` mounts
   `ChannelView` in the primary pane.
3. `ChannelView` composes `ChannelTimeline`, `ChannelComposer`, and the optional
   `ChannelThreadPanel`.
4. A human post is written once through the channel router. `@mentions` are
   resolved by the server-side binder and delivered to the matching provider
   adapter.
5. Adapter patches are translated by `channel-agent-bridge.ts` into attributed,
   durable channel rows and streamed to connected browsers.

The default no-session landing is the topic/channel composer. Terminal sessions
remain first-class working surfaces, but selecting a terminal and selecting a
channel are separate navigation states; one must not silently render as the
other.

## Implementation map

| Concern                                                            | Current owner                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Workspace/channel identity                                         | `server/ia-store.ts`, `server/workspace-topics.ts`         |
| Durable messages                                                   | `server/channel-message-store.ts` (`channel-chat.db`)      |
| Message/thread protocol                                            | `shared/channel-chat-protocol.ts`                          |
| REST history, post, attachment, roster, interrupt, approval routes | `server/channel-chat-router.ts`                            |
| Live fan-out and catch-up                                          | `server/channel-hub.ts`, `/ws/channels/:channelId`         |
| Mention routing and per-agent binding                              | `server/channel-agent-binder.ts`                           |
| Bounded mention history                                            | `server/channel-context-packet.ts`                         |
| Adapter-patch translation                                          | `server/channel-agent-bridge.ts`                           |
| Browser conversation surface                                       | `frontend/src/components/chat/Channel*.tsx`                |
| Socket/reducer lifecycle                                           | `frontend/src/hooks/useChannelChatSocket.ts`               |
| DM identity helpers                                                | `frontend/src/lib/dm-channels.ts`                          |
| Mobile attention and presence                                      | `MobileCockpitAttentionLane.tsx`, `lib/state/cockpit-*.ts` |

## Durable message and live-stream contract

`channel_messages` is the replay source of truth. Each channel has gap-free
monotonic sequence numbers with a database uniqueness backstop. Rows carry
server-derived sender identity, message lifecycle status, optional thread
relationships, source provenance, and bounded message parts. Streaming replies
begin as a durable row, accept debounced partial updates, and finalize in place.
On boot, stale streams are finalized as truncated with a restart reason.

The `ChannelEventV1` WebSocket protocol supports snapshots, created rows,
streaming deltas, completed rows, and resync requests. The client reducer
quarantines malformed or out-of-order deltas and asks for catch-up instead of
guessing. Snapshots and history pages are byte-bounded; reconnect and unread
arithmetic use durable sequence ranges rather than an in-memory event ring.

Writes stay on REST (`channels.post`); the channel WebSocket is server-to-client.
Browser posts and scoped CLI-gateway posts converge on the same internal
`postToChannel` path. `clientMessageId` and source provenance make retries
idempotent.

## Agent participation

`channel-agent-binder.ts` owns the mention loop:

1. observe a posted message;
2. parse provider mentions;
3. single-flight spawn, reuse, or rebind one web adapter session for the
   `(channel, provider)` pair;
4. build a bounded context packet from durable channel history;
5. send the turn to the adapter;
6. translate adapter patches back into the channel through the bridge.

The per-binding queue is bounded. Delivery advances only after adapter send
acceptance, and deterministic turn ids make retries safe. Agent-to-agent
mentions are allowed, with a consecutive-agent-turn brake to stop runaway
fan-out. Interrupt and approval responses use explicit channel routes and
capability checks; waiting on a human approval pauses the watchdog rather than
force-draining the turn.

The browser roster is provider-oriented. It reports configured availability and
live binding state; it is not a persistent directory of immortal agent
identities.

## Provider sessions

Provider adapters implement `ProtocolAdapterV2`. Claude uses a persistent
`claude` stream-json subprocess per conversation, with warm reuse, idle
eviction, and resume metadata; it does not use the Anthropic Agent SDK. Codex
has a native adapter, while OpenCode and Hermes participate through their
registered adapter implementations. Provider processes can fail or restart;
the channel remains the durable conversation identity.

Single-node routing is the current channel constraint. The hub/node platform
can execute PTY work on remote nodes, but cross-node channel-agent binding is
not yet a general routing contract.

## Native images

The composer accepts up to four PNG, JPEG, GIF, or WebP files. The attachment
route validates type, count, and size, stores payloads under the configured
runtime directory, and records bounded `image` parts on the message. The
timeline renders those parts through authenticated channel attachment URLs.
Mention delivery passes image inputs to compatible provider adapters rather
than flattening them into prose.

Image payloads and channel text are private local runtime data. They are not
redacted before storage and must not be copied into public issues or evidence
artifacts by default.

## Mobile cockpit

The mobile channel tree and desktop sidebar consume the same navigation model.
`MobileCockpitAttentionLane` ranks approval/input needs, failures, running work,
and unread conversations. Presence derives from channel agent status and
roster attention. Operators can open a row, approve or reply in context, send a
bounded nudge, or interrupt eligible work. These controls call the same channel
contracts as desktop; there is no mobile-only mutation path.

## Compatibility boundary

The old session-centric `ChatView`/`Turn` tree is not the primary launch path
and new channel/DM creation does not use it. It is still a compatibility surface
for restored or API-created legacy `mode: 'web'` sessions, so it must not be
deleted until those sessions have a migration or explicit retirement policy.
Tests that mount `Turn` directly prove that component only; they do not prove
the live channel timeline.

The removed v1 sidebar/protocol paths and the retired `WEB_CHAT.md` must not be
presented as current architecture. Historical plans remain useful evidence but
do not override this document or the implementation.

## Security and privacy boundaries

- Message sender identity is derived from the authenticated lane, never from a
  client-provided sender object.
- Browser routes require the PIN-authenticated browser session; scoped gateway
  actors require the relevant `context:read` or `context:write` capability.
- Archived or derived topics reject writes.
- Channel bodies and images are stored raw in the hub runtime directory. Unlike
  WorkContext message envelopes, they do not pass through a redaction pipeline.
- Shared/multi-user visibility remains a separate privacy and authorization
  decision; current private-hub behavior must not be overclaimed as multi-tenant
  collaboration.

## Remaining work

- Migrate or explicitly retire legacy `mode: 'web'` sessions before deleting
  `ChatView`/`Turn` compatibility code.
- Generalize channel-agent routing across nodes with explicit locality,
  capability, and failure semantics.
- Complete live multi-provider dogfood evidence for each supported adapter as
  credentials and provider availability permit.
- Revisit retention, export, redaction, and visibility policy before shared or
  multi-user channels.
- Tauri desktop packaging remains backlog; the web app is the supported desktop
  surface today.
