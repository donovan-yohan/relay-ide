# Relay product boundary

Relay is a channel-first collaboration hub and execution control plane for
agentic development across devices. Channels are the human/agent conversation;
terminal, file, diff, artifact, and Active Work views expose the execution and
evidence behind that conversation.

Relay does not replace agent CLIs, GitHub, task systems, source control, node
filesystems, or process supervisors.

## Canonical nouns

| Noun            | Meaning                                             | Boundary                                                              |
| --------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| Channel         | Durable ordered conversation                        | Owns messages, threads, membership, and profile bindings              |
| DM              | Channel targeting one agent profile                 | Uses the same store, protocol, and UI as other channels               |
| Agent profile   | Durable participant actor and launch configuration  | Provider/runtime ids do not replace participant identity              |
| Runtime         | Private provider execution handle                   | Owned by the channel binder; never a chat destination or terminal tab |
| Session         | Public terminal/process execution handle            | Can be attached or controlled; does not own a conversation            |
| Node            | Local or paired execution device                    | Capability is not permission                                          |
| WorkContext     | Durable task/repo/session/artifact envelope         | Context spine, not a transcript or task database                      |
| TaskRef         | Link to an external issue, PR, or task              | External system remains authoritative                                 |
| Artifact        | Bounded evidence reference or Relay-produced output | Prefer refs/hashes/summaries over secret-bearing payloads             |
| CapabilityGrant | Scoped permission for an actor/client operation     | Separate from node capability discovery                               |
| AuditEvent      | Append-only security/control transition             | Stores compact metadata, not raw prompts or terminal input            |

Workspace topics provide channel metadata, grouping, display, and routing
defaults. They back the channel navigation model rather than defining a second
conversation surface.

## Product rules

- A channel is the conversation.
- Agent and human messages share the channel timeline.
- A thread remains inside its channel.
- A profile actor is stable across runtime replacement and provider resume.
- Terminal sessions and private channel runtimes are different contracts.
- Repo/worktree data is optional execution context, not universal identity.
- The hub owns routing, policy, durable channels, and federated views.
- Nodes own local processes and filesystem paths.
- The CLI gateway and browser are clients of the same Relay action contracts.

## Mobile

Mobile prioritizes:

- channels, DMs, unread state, and threads;
- agent status, approvals, interruption, and orchestration;
- bounded output, images, and artifacts;
- terminal attach when deeper control is required;
- explicit offline/stale state.

Relay does not attempt to turn a phone into a full desktop IDE. High-risk or
bulk editing workflows remain desktop/CLI work unless a dedicated mobile
surface is implemented and proven.

## Execution and control

Public terminal/process sessions carry node, cwd, optional repo/worktree
context, control state, and reconnect metadata. A browser can attach to the
same live session without creating a second process.

Private channel-agent runtimes exist only behind channel/profile bindings.
They expose provider patches to the binder/bridge, can receive scoped actor
credentials, and may retain provider resume state. They do not appear in
session lists, tabs, terminal sockets, or WorkContext session reads.

Control state and capability policy determine who may input, interrupt,
approve, kill, or hand back work. Raw PTY bytes are not a stable typed
agent-to-agent protocol.

## Context and evidence

`WorkContext` connects a channel-driven task to execution/evidence without
copying the channel transcript. Context packets, artifacts, handoff records,
and audit summaries are bounded and reference-oriented.

Channel mention context is assembled from the durable message log with explicit
row/byte limits. Agent output is written back to the channel; it is not inferred
later from terminal scraping.

## Hard boundaries

Relay must not:

- expose a private runtime as a conversation or browser tab;
- create parallel provider-specific chat UIs;
- treat node capabilities as authorization;
- silently route a remote operation to a local path;
- store raw secrets, provider auth, unbounded transcripts, or unbounded output
  in audit/evidence records;
- claim live child-process continuity across Relay server restart;
- require git identity for every channel, runtime, session, or WorkContext.

## Acceptance

A product slice is complete only when the live owning surface is proven:

- conversation behavior through `ChannelView` and the durable channel path;
- agent behavior through profile → binder → runtime → bridge → channel;
- execution behavior through the public session/terminal path;
- federation behavior against the addressed node;
- mobile behavior in the target browser/device when responsive tests are
  insufficient;
- security behavior through capability, attribution, and redaction tests.

See [`CHANNEL_CHAT.md`](CHANNEL_CHAT.md),
[`ARCHITECTURE.md`](ARCHITECTURE.md), and
[`SECURITY_POLICY.md`](SECURITY_POLICY.md).
