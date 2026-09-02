# Relay documentation

Everything under **Current** describes behavior present in the repository today.
Everything under **Historical and reference** is dated material kept for
traceability — snapshots, audits, and per-incident write-ups that were true when
written and are not maintained against the current tree. Git history holds
superseded plans and removed product models; the working tree does not use
historical design documents as product documentation.

Every doc listed here is linked from this index. If you add a doc, add a row.

## Current

### Start here

| Area                 | Source                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| User onboarding      | [`../README.md`](../README.md)                                                   |
| Release notes        | [`../CHANGELOG.md`](../CHANGELOG.md)                                             |
| Agent/repo map       | [`../AGENTS.md`](../AGENTS.md)                                                   |
| Channel model        | [`CHANNEL_CHAT.md`](CHANNEL_CHAT.md)                                             |
| Architecture         | [`ARCHITECTURE.md`](ARCHITECTURE.md)                                             |
| Frontend             | [`FRONTEND.md`](FRONTEND.md)                                                     |
| Visual system        | [`../DESIGN.md`](../DESIGN.md)                                                   |
| Backend patterns     | [`DESIGN.md`](DESIGN.md)                                                         |
| Quality              | [`QUALITY.md`](QUALITY.md)                                                       |
| Provider adapters    | [`provider-guide.md`](provider-guide.md)                                         |
| Security             | [`SECURITY_POLICY.md`](SECURITY_POLICY.md)                                       |
| Handshake grants     | [`OPERATOR_HANDSHAKE_GRANTS.md`](OPERATOR_HANDSHAKE_GRANTS.md)                   |
| Operator clients     | [`OPERATOR_CLIENT_CREDENTIALS.md`](OPERATOR_CLIENT_CREDENTIALS.md)               |
| Session durability   | [`SESSION_DURABILITY.md`](SESSION_DURABILITY.md)                                 |
| Terminal backend     | [`TERMINAL_BACKENDS.md`](TERMINAL_BACKENDS.md)                                   |
| Self-hosting         | [`SELF_HOSTING.md`](SELF_HOSTING.md)                                             |
| CLI gateway          | [`CLI_GATEWAY.md`](CLI_GATEWAY.md)                                               |
| CLI schemas          | [`cli-schema/`](cli-schema/)                                                     |
| Workbench boundary   | [`WORKBENCH_BOUNDARY.md`](WORKBENCH_BOUNDARY.md)                                 |
| Agent view artifacts | [`AGENT_VIEW_ARTIFACTS.md`](AGENT_VIEW_ARTIFACTS.md)                             |
| Handoff artifacts    | [`pipeline-handoff-artifact-template.md`](pipeline-handoff-artifact-template.md) |
| Repository context   | [`context-map.md`](context-map.md)                                               |

### Working in this repo

| Area                    | Source                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------- |
| Cross-session learnings | [`LEARNINGS.md`](LEARNINGS.md)                                                         |
| Review guidance         | [`REVIEW_GUIDANCE.md`](REVIEW_GUIDANCE.md)                                             |
| Review agent setup      | [`references/review-agent-setup.md`](references/review-agent-setup.md)                 |
| Manual QA pass          | [`references/qa-guide.md`](references/qa-guide.md)                                     |
| README screenshots      | [`assets/README.md`](assets/README.md) — spec for the shots the README still needs     |
| Agent browser checks    | [`references/agent-browser-verification.md`](references/agent-browser-verification.md) |
| Dead code and critique  | [`references/dead-code-and-critique.md`](references/dead-code-and-critique.md)         |

### Hub, node, and operations

| Area             | Source                                                                         |
| ---------------- | ------------------------------------------------------------------------------ |
| Hub/node package | [`RELAY_HUB_NODE_PACKAGING.md`](RELAY_HUB_NODE_PACKAGING.md)                   |
| Node bootstrap   | [`RELAY_NODE_BOOTSTRAP.md`](RELAY_NODE_BOOTSTRAP.md)                           |
| Pairing UX       | [`ADD_NODE_PAIR_DEVICE_UX.md`](ADD_NODE_PAIR_DEVICE_UX.md)                     |
| WSL2             | [`WSL2_RELAY_NODE_SUPPORT.md`](WSL2_RELAY_NODE_SUPPORT.md)                     |
| Federated dev    | [`FEDERATED_DEV.md`](FEDERATED_DEV.md)                                         |
| Federation       | [`federated-relay.md`](federated-relay.md)                                     |
| Deployment       | [`references/deployment.md`](references/deployment.md)                         |
| Devbox hub       | [`references/devbox-hub-deploy.md`](references/devbox-hub-deploy.md)           |
| Dogfood recovery | [`references/dogfood-recovery.md`](references/dogfood-recovery.md)             |
| Hermes multiplex | [`references/hermes-multiplex-setup.md`](references/hermes-multiplex-setup.md) |

## Historical and reference

Dated material, not maintained against the current tree. Read the date before
trusting a claim.

| Area                     | Source                                                                                               | Status                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Boo substrate audit      | [`BOO_PHILOSOPHY.md`](BOO_PHILOSOPHY.md)                                                             | Gap audit against the `coder/boo` direction. Aspirational by design — verify against code before citing.                      |
| Bug analyses             | [`bug-analyses/`](bug-analyses/)                                                                     | Per-incident write-ups, dated in the filename. Historical; see [`bug-analyses/index.md`](bug-analyses/index.md).              |
| Refactor audits          | [`refactor/`](refactor/)                                                                             | One-off audit snapshots, dated in the filename. Historical.                                                                   |
| Design-system assets     | [`design-system/`](design-system/)                                                                   | Extracted palette/type CSS and the logo asset. Reference; `../DESIGN.md` is authoritative.                                    |
| Endpoint perf            | [`references/endpoint-perf-baseline-2026-08-29.md`](references/endpoint-perf-baseline-2026-08-29.md) | Interactive HTTP latency baseline measured on the prod hub, 2026-08-29. Dated snapshot; re-measure before citing. Epic #1446. |
| Prime Agent harness plan | [`PRIME_AGENT_HARNESS_A_GRADE_PLAN.md`](PRIME_AGENT_HARNESS_A_GRADE_PLAN.md)                         | Completeness audit and plan for the prime-agent channel adapter. Historical roadmap.                                          |

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
