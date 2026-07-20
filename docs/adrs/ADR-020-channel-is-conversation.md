# ADR-020: Channel is the durable conversation

- **Status:** Accepted
- **Date:** 2026-07-20
- **Refs:** #1163, #1165, #1166, #1167, #1170, #1171, ADR-017
- **Supersedes:** session-centric web chat as Relay's primary collaboration model

## Context

Relay historically treated one web-mode agent session as one conversation.
That coupled user-visible history and navigation to a provider process: adding a
second agent meant adding another chat, recovering a process threatened the
conversation identity, and desktop/mobile clients could not share one durable
multi-party timeline.

Relay now has a durable channel store and protocol, workspace topics, provider
adapters, server-side mention routing, threads, image parts, and a channel-first
React surface. The architectural identity needs to be explicit so future work
does not rebuild session-shaped chat beside it.

## Decision

1. A **channel is the durable conversation**. It owns ordered messages,
   threads, membership/routing metadata, and attachment refs. Read position is
   currently a client-local projection over the durable sequence.
2. A **DM is a channel specialization**, not a second message or UI protocol.
3. An **agent is a participant**. A provider session is a replaceable execution
   binding for `(channel, provider)` and is not the conversation id.
4. Human and scoped gateway writes converge on the same server-owned post path;
   sender identity is derived from authentication.
5. Adapter events cross a server-side bridge into durable channel rows. Browser
   clients read durable history and receive live projections; they do not own
   the canonical transcript.
6. Channels remain hub-owned. Provider execution is single-node for the current
   binding contract; any cross-node extension must preserve channel identity and
   make locality/capability/failure semantics explicit.
7. Legacy `mode: 'web'` sessions are compatibility state only. They may remain
   readable until migrated or retired, but new product work must target the
   channel path.

## Consequences

- Process restart, adapter replacement, or agent rebinding does not create a new
  conversation.
- Desktop, mobile, and CLI clients can project the same durable timeline and
  action contracts.
- Multi-agent collaboration, threads, and DMs reuse one storage and transport
  model.
- Channel retention, redaction, export, and shared visibility are hub data-policy
  decisions; they cannot be delegated implicitly to provider transcripts.
- A test that mounts legacy `ChatView`/`Turn` does not prove channel behavior.
  Channel features require evidence through `ChannelView`/`ChannelTimeline` or
  the channel router/protocol seams.
