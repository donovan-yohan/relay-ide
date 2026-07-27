# ADR-020: The channel is the conversation

- **Status:** Accepted
- **Date:** 2026-07-26
- **Refs:** #1163, #1165, #1166, #1167, #1178, #1198, #1232, #1242
- **Supersedes:** competing conversation ownership models

## Context

Relay needs one durable collaboration identity that survives provider process
replacement, browser reconnect, node changes, and multi-agent participation.
Provider runtime ids and public terminal sessions are execution identities;
neither can safely own shared conversation history.

The repository already implements a durable channel log, channel WebSocket
protocol, profile actors, DMs, threads, mention routing, rich agent rows, native
images, orchestration, and private agent runtimes.

## Decision

The channel is Relay's only conversation boundary.

1. A channel owns ordered durable messages, membership, threads, and profile
   bindings.
2. A DM is a deterministic channel targeting one agent profile.
3. Human and agent messages share the same message contract and timeline.
4. The durable profile actor is the participant identity.
5. A private `ChannelAgentRuntime` is an execution handle owned by the channel
   binder. It is not a public session, tab, route, or conversation.
6. Public `Session` objects represent terminal/process execution and may be
   linked to channel work without owning its transcript.
7. Provider patches become channel-native text, images, and typed detail cards
   through the channel bridge.
8. New collaboration behavior must prove the live channel component and
   persistence paths.

## Consequences

- Provider runtimes can be replaced or resumed without changing the
  conversation id.
- Multiple profiles from one provider remain distinct participants.
- Threads, mentions, images, streaming, approvals, and orchestration use one
  durable protocol.
- Public session APIs and terminal WebSockets do not expose private channel
  runtimes.
- Provider adapters stay internal and cannot require a provider-specific
  browser conversation.
- Documentation and tests use channel terminology for collaboration and
  session/runtime terminology only for execution.

## Enforcement

The decision is enforced by:

- `shared/channel-chat-protocol.ts`;
- `server/channel-message-store.ts`;
- `server/channel-chat-router.ts`;
- `server/channel-hub.ts`;
- `server/channel-agent-binder.ts`;
- `server/channel-agent-runtime.ts`;
- `server/channel-agent-bridge.ts`;
- `ChannelView → ChannelTimeline → ChannelMessageRow`;
- channel store/router/hub/binder/bridge/component/e2e tests.

A test that renders a reusable card or Markdown component alone does not prove
channel behavior.
