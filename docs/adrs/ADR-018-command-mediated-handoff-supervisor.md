# ADR-018: Command-mediated handoff and supervisor contract (superseded)

- **Status:** Superseded by ADR-020
- **Date:** 2026-05-25
- **Refs:** #718, #716, #717, #423, #426, #470, #493, #552, ADR-015, ADR-016, ADR-017, ADR-020
- **Supersedes:** none
- **Superseded by:** ADR-020

## Context

Relay now exposes a versioned CLI gateway and shared command manifest. That
creates a tempting but bad shortcut: map handoff, supervision, fanout, or
provider control to raw terminal bytes and hope the target harness interprets
them correctly.

That shortcut breaks Relay's safety model. Terminal panes, ACP/MCP transports,
and provider CLIs are substrate details. The Relay-owned command contract is
the stable API because it carries scoped capability hints, control-mode state,
redaction rules, audit summaries, and schema-generated adapter definitions.

## Decision

The durable part of this decision remains: stable adapter-facing operations
must be declared in `shared/cli-gateway-contract.ts` and projected through
`shared/relay-command-manifest.ts`; private transports and raw terminal bytes
do not become the source of truth.

ADR-020 supersedes the terminal-agent parts of this decision:

- Agent conversations exist only in channels and DMs. A durable channel profile
  actor identifies the participant; private runtime ids are implementation
  details.
- Public sessions are human-driven terminals. They do not launch provider
  agents, become agent/co-driven, or support hand-back.
- `supervisor.*` controls an explicitly addressed public terminal. It does not
  send a channel message, resume a provider conversation, or impersonate an
  agent.
- `handoffs.plan` may calculate a read-only plan and `artifacts.read` may return
  a bounded, passive artifact view. The former create/launch/resume/cancel
  handoff run lifecycle is unsupported.
- `workflow-runs.*` stores generic, redacted execution evidence. It does not
  own planner/worker roles, launch agents, or define conversation topology.

## Command classification

| Command family                                                           | Side effect       | Current boundary                                                                                                  |
| ------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `contract.*`, `nodes.manifest`                                           | read              | Local schema/capability output only.                                                                              |
| `nodes.list`, `sessions.list`, `sessions.get`, `work-contexts.get`       | read              | Bounded public terminal/context descriptors; no channel runtime ids or provider state.                            |
| `sessions.interventions`, `supervisor.snapshot`                          | read              | Bounded human terminal metadata; no keylogs, transcripts, provider state, or agent ownership transition.          |
| `sessions.attach`, `sessions.detach`, `sessions.renew`, `sessions.input` | terminal control  | Human-driven public terminal lifecycle/input only; never agent messaging.                                         |
| `supervisor.sendText`, `supervisor.sendKey`, `supervisor.submit`         | terminal control  | Typed, scoped terminal input with redacted audit evidence; never a channel-agent control plane.                   |
| `handoffs.plan`, `artifacts.read`                                        | passive read/plan | Bounded plan or artifact evidence only; no destination process creation, transfer application, or runtime launch. |
| `workflow-runs.*`                                                        | evidence          | Generic bounded workflow projection; no agent roles, participant roster, or orchestration launcher.               |
| `files.write`                                                            | write             | Scoped file write with policy/confirmation and payload-redacted audit.                                            |
| `sessions.stream`, `events.subscribe`                                    | stream            | Bounded output/metadata frames; no event publish in v1.                                                           |

## Boundaries

- Raw PTY input is distinct from typed supervisor actions. Both address a
  human-driven terminal; neither is an agent-to-agent API.
- Raw terminal command execution is not stable Relay API. If a new operation
  is needed, define a Relay command first and then adapt it to `relay-pty`.
- Provider-native state belongs to private channel runtimes and is not promoted
  as a public session resource.
- A handoff plan or artifact ref is evidence only. It cannot create a
  destination session, launch an agent, or resume a conversation.
- Workflow evidence may link public terminal ids and artifact/task refs, but it
  cannot encode planner/worker participant topology.
- Redacted artifact/context exchange carries refs, hashes, sizes, timestamps, and summaries by default. Raw prompts, transcripts, secrets, provider auth, and provider store rows are not stored in audit by default.

## Consequences

This keeps Command Center search, generated adapter tools, CLI gateway
behavior, and future ACP/MCP integrations aligned around one command registry.
Agent launch, continuation, approvals, and conversation state are implemented
only by the channel runtime/binder path. Public terminal APIs remain useful
operator tooling, while handoff and workflow surfaces remain bounded evidence
instead of a parallel agent orchestration system.
