# Relay documentation

These documents describe behavior present in the repository today. Git history
holds superseded plans and removed product models; the working tree does not use
historical design documents as product documentation.

## Start here

| Area               | Source                                           |
| ------------------ | ------------------------------------------------ |
| User onboarding    | [`../README.md`](../README.md)                   |
| Agent/repo map     | [`../AGENTS.md`](../AGENTS.md)                   |
| Channel model      | [`CHANNEL_CHAT.md`](CHANNEL_CHAT.md)             |
| Architecture       | [`ARCHITECTURE.md`](ARCHITECTURE.md)             |
| Frontend           | [`FRONTEND.md`](FRONTEND.md)                     |
| Visual system      | [`../DESIGN.md`](../DESIGN.md)                   |
| Backend patterns   | [`DESIGN.md`](DESIGN.md)                         |
| Quality            | [`QUALITY.md`](QUALITY.md)                       |
| Provider adapters  | [`provider-guide.md`](provider-guide.md)         |
| Security           | [`SECURITY_POLICY.md`](SECURITY_POLICY.md)       |
| Session durability | [`SESSION_DURABILITY.md`](SESSION_DURABILITY.md) |
| Terminal backend   | [`TERMINAL_BACKENDS.md`](TERMINAL_BACKENDS.md)   |
| Self-hosting       | [`SELF_HOSTING.md`](SELF_HOSTING.md)             |
| CLI gateway        | [`CLI_GATEWAY.md`](CLI_GATEWAY.md)               |
| Workbench boundary | [`WORKBENCH_BOUNDARY.md`](WORKBENCH_BOUNDARY.md) |

## Hub, node, and operations

| Area             | Source                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------- |
| Hub/node package | [`RELAY_HUB_NODE_PACKAGING.md`](RELAY_HUB_NODE_PACKAGING.md)                           |
| Node bootstrap   | [`RELAY_NODE_BOOTSTRAP.md`](RELAY_NODE_BOOTSTRAP.md)                                   |
| Pairing UX       | [`ADD_NODE_PAIR_DEVICE_UX.md`](ADD_NODE_PAIR_DEVICE_UX.md)                             |
| WSL2             | [`WSL2_RELAY_NODE_SUPPORT.md`](WSL2_RELAY_NODE_SUPPORT.md)                             |
| Federated dev    | [`FEDERATED_DEV.md`](FEDERATED_DEV.md)                                                 |
| Federation       | [`federated-relay.md`](federated-relay.md)                                             |
| Deployment       | [`references/deployment.md`](references/deployment.md)                                 |
| Devbox hub       | [`references/devbox-hub-deploy.md`](references/devbox-hub-deploy.md)                   |
| Dogfood recovery | [`references/dogfood-recovery.md`](references/dogfood-recovery.md)                     |
| Browser checks   | [`references/agent-browser-verification.md`](references/agent-browser-verification.md) |

## Product invariants

- A channel is the durable conversation.
- A DM is a channel with one agent profile.
- Agents are participants identified by durable profile actors.
- Agent runtimes are private execution details, not public sessions or chat
  destinations.
- Public sessions are terminal-only and use `relay-pty`.
- New conversation UI work lands in the live channel component tree.
- The hub owns conversation history, routing, profiles, policy, and
  federation; nodes own local execution and filesystem paths.
- `relay-pty` is the supported interactive terminal backend.
- The stable external agent surface is `relay-ide v1 ... --json`.

## Architecture decisions

Accepted decisions live in [`adrs/`](adrs/):

- ADR-015 — domain-agnostic core
- ADR-016 — node-to-node isolation
- ADR-017 — CLI boundary retained; conversation ownership superseded by ADR-020
- ADR-018 — command-mediated handoff and supervision
- ADR-019 — context-packet storage
- ADR-020 — current conversation and agent-runtime ownership model

When docs and source disagree, verify the implementation and tests, then fix
the docs in the same change. Do not add a redirect or historical compatibility
document for a removed product surface.
