# ADR-0003: Hermes rich-client Session adapter is loopback dashboard JSON-RPC only

- Status: accepted
- Issue: #1141

## Context

Hermes exposes several unrelated integration surfaces. Its messaging/API gateway serves an OpenAI-compatible HTTP API, while the interactive rich-client Session protocol is TUI JSON-RPC over a dashboard-owned `/api/ws` WebSocket. Treating either as a generic Relay transport would blur the provider boundary, create accidental remote-control scope, and encourage use of browser credentials or profile storage as a transport credential.

## Decision

Relay owns a native Hermes adapter that accepts only `ws://` loopback dashboard `/api/ws` endpoints authenticated by the local dashboard's ephemeral token. It creates, lists, resumes, prompts, interrupts, and observes only the documented rich-client event subset. Events are mapped into neutral lifecycle/status/tool/approval/diagnostic categories with bounded, redacted previews. Hermes 0.18.2 injects an opaque request id into `clarify.request` before emission, and Relay uses that id for exactly one `clarify.respond` without retaining the question, choices, or answer.

The adapter has bounded request/frame/event/replay and pending-interaction limits. It returns typed responses for auth failure, connection loss, malformed frames, timeout, retry exhaustion, replay gaps, unsupported contract elements, and interaction races; excess pending interactions become visible redacted diagnostics without retaining another response target. Unknown events remain visible diagnostics rather than being silently dropped or mapped to a generic Relay fallback.

## Consequences

- One-node Relay can prove real Hermes rich-client control without starting a generic provider platform.
- Browser login/cookies, dashboard tickets, Hermes credentials, Relay node identity, profile databases, and transcripts remain separate.
- A remote dashboard, public browser-auth ticket flow, cross-node connection, persistence import, and generic Relay bridge require a later accepted issue and ADR.
- The independently evolving provider-neutral Session contract may integrate this adapter later, but this implementation does not depend on an unmerged provider branch.
