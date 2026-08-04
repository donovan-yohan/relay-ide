# ADR-017: Agent brains use Relay's hub-level command boundary

- **Status:** Partially superseded; CLI boundary retained
- **Date:** 2026-05-16
- **Updated:** 2026-07-26
- **Refs:** #423, #426, #429, #430, #470, #493, #552, #569, ADR-015,
  ADR-016, ADR-020
- **Superseded by:** ADR-020 for agent identity, conversation ownership, and
  runtime lifecycle

## Context

Relay exposes stable, capability-gated primitives to external agents such as
Claude, Codex, OpenCode, and Hermes. Those agents must not speak the private
hub/node WebSocket protocol, borrow a node credential, or depend on
provider-specific browser state.

The original version of this ADR described an agent brain as the owner of a
public agent session. That ownership model is no longer current. ADR-020
establishes the channel as the only conversation boundary, the profile actor as
the durable participant identity, and `ChannelAgentRuntime` as a private
execution handle.

## Current decision retained from ADR-017

External agents discover and act on Relay through the versioned CLI gateway:

```text
agent native tool/function call
  -> thin provider integration
  -> relay-ide v1 <verb> --json
  -> hub authentication, capability, and scope checks
  -> Relay-owned command implementation
  -> JSON or bounded NDJSON result
```

- The CLI/action manifest is the stable integration plane.
- The internal `/hub/node-link` protocol is not an agent API.
- Node execution remains hub-mediated. A node never acts as another node.
- Authenticated actor identity comes from the credential, not caller-supplied
  `--brain`, `--act-as`, or display metadata.
- Bounded reads, typed commands, redaction, and audit remain preferable to raw
  transcript or PTY scraping.

## Ownership model superseded by ADR-020

The following current rules replace the old brain-owned-session model:

1. A channel owns durable conversation history, membership, threads, and
   message ordering.
2. A DM is a deterministic channel with one agent profile.
3. An agent profile actor is the durable participant identity.
4. The channel binder owns a private `ChannelAgentRuntime` and may recreate it
   from stored provider resume state.
5. A private runtime is not a public `Session`, Tab, route, or conversation.
6. Public session creation is terminal-only and uses `relay-pty`.
7. `sessions create`, including routed node creation, rejects agent session
   types and the retired `mode: "web"`.
8. Agents can use scoped CLI commands to inspect or operate on permitted
   terminal sessions, WorkContexts, artifacts, files, and other Relay
   primitives; that does not turn the agent itself into a public session.

## Identity and authorization

An authenticated agent remains a hub-level actor. Actor credentials may carry
an agent-shaped peer identity for authorization and audit:

```ts
type AgentPeerIdentity = {
  kind: 'agent';
  id: string;
  adapter: string;
  displayName?: string;
  credentialId?: string;
};
```

That peer identity is distinct from:

- the profile actor that appears in a channel timeline;
- the private runtime id used by the channel binder;
- a public terminal session id;
- a node credential.

Credentials determine the actor and permitted scope. Provider labels are
advisory metadata and never authorize impersonation.

## Session and control boundaries

Public sessions represent terminal/process execution. Their descriptors may
carry node, cwd, repo/worktree context, control state, durability, and audit
identity. Agents may inspect or operate on those terminal sessions when their
credential permits it.

`controlMode` describes who controls a public terminal Tab. It does not model
channel conversation ownership and does not expose the private channel-agent
runtime. Hand-back and intervention acknowledgement remain public-terminal
control rules.

## Event and read-model boundaries

The gateway exposes bounded, versioned reads and event topics. Consumers use
Active Work, session descriptors for public terminals, WorkContexts, inbox,
artifacts, and channel commands instead of the private node-link event stream.

Public session events describe terminal sessions only. Agent participation and
agent output are observed through channel membership, roster, messages, and
channel status events.

## Consequences

- Provider processes can restart without changing the conversation identity.
- The public session API no longer creates standalone or routed agent chats.
- Generated agent tools may still include terminal/session commands, but their
  schemas are terminal-only.
- Provider integrations stay internal to the channel runtime and cannot require
  a provider-specific browser conversation.
- Documentation must use channel/profile/runtime terminology for agent
  participation and session terminology for public terminal execution.

See [ADR-020](ADR-020-channel-is-conversation.md) for the authoritative
conversation and runtime ownership decision.
