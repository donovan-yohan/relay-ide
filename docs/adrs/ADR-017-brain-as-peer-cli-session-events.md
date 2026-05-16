# ADR-017: Agent brains are hub-level peers of Relay sessions, not protocol clients

- **Status:** Accepted
- **Date:** 2026-05-16
- **Refs:** #506, #429, #430, #426, #470, #493, #423, ADR-015, ADR-016
- **Supersedes:** none

## Context

The #429 CLI gateway and #430 agent adapters are about to make Relay
primitives available to external agents such as Hermes, Claude, and Codex.
Without a precise contract, each adapter could accidentally encode a different
model:

- A brain as a thin command consumer with no durable relationship to sessions.
- A brain as a node credential that can drive other nodes.
- A brain as a WebSocket protocol client coupled to internal node-link events.
- A brain as a first-class peer that owns scoped sessions and observes stable
  session state through the gateway.

The fourth model is the only one that composes with the current architecture.
ADR-015 keeps core Relay primitives domain-agnostic. ADR-016 says every routed
operation is authorized as a hub-level requester, never as one relay-node acting
on another. #426 makes scoped, revocable sessions the trust unit.
#470/#493 define control-mode and intervention state on the Tab/session surface.
#423 defines the versioned CLI as the stable integration plane and keeps the
internal `/hub/node-link` WebSocket protocol free to evolve.

## Decision

External agent brains are **hub-level session peers**. They discover and act on
Relay through the versioned CLI gateway (`relay-ide v1 ... --json`), not by
speaking the internal WebSocket protocol and not by borrowing a relay-node
credential.

A brain may create, attach to, input to, detach from, and inspect Relay sessions
when its hub credential and the #426 session scope permit those actions. The
session, not the adapter process, is the durable unit of ownership,
revocation, audit correlation, control-mode state, and hand-back safety.

### Brain identity

A brain identity is the authenticated hub-level peer behind a CLI invocation or
adapter tool call. The stable contract should reuse existing identity shapes:

- #426 `SessionEnvelope.peerIdentity` records who created or owns the scoped
  session.
- #470/#493 `ControlActor` records who is currently driving or intervening in a
  Tab (`agent`, `human`, or `system`).
- Adapter metadata may identify the adapter family (`hermes`, `claude`,
  `codex`) and display label, but that metadata decorates the peer identity; it
  is not a separate node, Project, Workspace, or protocol actor.

Minimum schema implication before #430 adapters start: the #426 session
identity schema must be able to represent an agent peer without falling back to
`unknown`. Use an additive agent-shaped peer compatible with `ControlActor`, for
example:

```ts
type SessionPeerIdentity =
  | { kind: 'local-user'; id: string; displayName?: string }
  | {
      kind: 'relay-node';
      nodeId: NodeId;
      credentialId?: string;
      displayName?: string;
    }
  | {
      kind: 'agent';
      id: string;
      adapter: 'hermes' | 'claude' | 'codex' | string;
      displayName?: string;
      credentialId?: string;
    }
  | { kind: 'unknown'; id?: string; displayName?: string };
```

Adapters must not accept a free-form `--brain` or `--act-as` flag that lets a
tool caller impersonate another peer. The hub credential determines the peer;
adapter-provided labels are advisory metadata and must be validated or filled
by the hub-side credential/session registry.

### Session ownership

A brain-owned session is still a #426 session envelope:

- `sessionId` is node-local process/session identity.
- `globalSessionId` is the hub/node routing key, derived from `nodeId` and the
  node-local session id.
- `nodeId` names the execution host.
- `intent`, `scope`, `expiresAt`, and `revocable` determine what the brain may
  do for the lifetime of that session.
- `peerIdentity` names the hub-level creator/owner.
- `correlationId` / `auditId` connect CLI requests, hub audit rows, and future
  security logs.

The owner may attach/input/detach only through gateway verbs that validate the
current credential against the session owner and scope. A human browser may
still attach to the same Tab, but that changes control state; it does not make
the browser the creator of the scoped agent session.

This deliberately avoids a separate "brain session" concept. The process Tab,
the #426 session envelope, and the #470/#493 control-state summary are the
shared nouns.

### Control-mode interaction (#470/#493)

`controlMode` is the product ownership state of a Tab, separate from transport
`mode` (`pty` or `web`):

- `agent-driven`: an agent peer is the active worker.
- `human-driven`: a human peer is the active actor.
- `co-driven`: a human has touched an agent-driven Tab and both actors matter.

For brain-owned sessions, `sessions create` should be able to request an initial
`agent-driven` control state when policy permits. The response must expose the
same #493 control summary fields already used by session summaries:
`controlMode`, `activeActors`, optional `activeWorker`, `lastInterventionAt`,
`lastInterventionBy`, `lastInterventionEventId`, `controlFreshness`, and
optional `controlReason`.

Hand-back after human intervention must use #493's ack rule: when a brain
resumes `agent-driven` after human touch, the request includes the latest
intervention event id it observed. Stale, unknown, disconnected, or unacked
state returns a typed error rather than silently resuming the agent.

Capability decisions remain #427 policy. This ADR defines identity and contract
shape; it does not grant permission to set `agent-driven`, read intervention
history, or execute commands.

### Event subscription semantics

The stable v1 adapter contract is **query + command first**, not a broad event
bus:

1. A brain discovers available verbs with `relay-ide v1 --list --json`.
2. It discovers execution hosts with `nodes list` and `nodes manifest`.
3. It creates a scoped session with `sessions create`.
4. It streams PTY bytes with `sessions attach --mode ndjson` or uses
   non-streaming verbs such as `sessions input`, `sessions detach`, and future
   file/control verbs.
5. It inspects current ownership through session descriptors and bounded
   control/intervention reads.

The internal node-link `events` channel may carry `tab.mode-changed` and
`tab.intervention` envelopes, as reserved in `shared/control-state.ts` and
`docs/federated-relay.md`. Those event names are implementation vocabulary for
hub/node/browser routing. They are not, by themselves, a stable adapter API.

Deferred event-subscription work must be explicit before adapters rely on it:

- A versioned CLI event verb such as `relay-ide v1 events subscribe --session
<id> --types tab.mode-changed,tab.intervention --mode ndjson`.
- Cursor/resume semantics for missed events.
- Backpressure and `event-dropped` behavior.
- Redaction rules for intervention payloads.
- Capability checks for event types that expose human intervention metadata.

Until that lands, #430 adapters should poll bounded session/control reads or
consume only the PTY stream they explicitly attached to.

### How a peer brain discovers and acts on primitives

The adapter flow is intentionally boring:

```text
agent native tool/function call
  -> thin #430 adapter
  -> relay-ide v1 <verb> --json
  -> hub-level auth/session/scope check
  -> hub registry or hub-mediated node-link RPC
  -> JSON/NDJSON result back to the adapter
```

Important boundaries:

- Discovery comes from `v1 --list --json` and generated JSON Schema, not
  hand-written Claude/Codex/Hermes tool definitions.
- Node execution happens through hub-mediated routing. Per ADR-016, no adapter
  or node may request `actAsNodeId` or use a node credential to drive another
  node.
- Repo/worktree/project verbs remain feature-layer extensions per ADR-015 and
  #423 (`v1 ext.<ns> ...`), not part of the core brain/session contract.
- Internal WebSocket envelope names, stream ids, and routing details may change
  as long as the CLI JSON contract remains stable for the advertised major.

## Minimum CLI JSON schema changes before #430

Before Hermes/Claude/Codex adapter packages generate tool definitions, #429's
schema must include these stable pieces:

1. **Agent-capable session peer identity.** Session descriptors returned by
   `sessions create`, `sessions list`, and the required session-inspection verb
   can represent `peerIdentity.kind: 'agent'` with adapter metadata.
2. **Session inspection.** Add or reserve `relay-ide v1 sessions get --id
<sessionId> --json` so adapters do not overload `sessions list` or parse
   internal WebSocket state for one session.
3. **Control summary fields.** Session descriptors include the #493 summary
   fields: `controlMode`, `activeActors`, `activeWorker`,
   `lastInterventionAt`, `lastInterventionBy`, `lastInterventionEventId`,
   `controlFreshness`, and `controlReason`.
4. **Initial control-mode request.** `sessions create` accepts an optional,
   policy-gated `--control-mode agent-driven|human-driven` request, defaulting
   safely when omitted. The hub may reject with a typed policy error.
5. **Hand-back ack.** Add a control verb or a `sessions update-control` shape
   that requires `--latest-intervention-event-id <id>` when resuming
   `agent-driven` after human intervention.
6. **Bounded intervention reads.** Add or reserve a bounded read shape for
   recent intervention metadata with redaction fields. Do not expose raw
   keylogs or full terminal transcripts.
7. **Typed stale-state errors.** Extend the gateway error taxonomy for
   `CONTROL_STATE_STALE`, `INTERVENTION_ACK_REQUIRED`, `INTERVENTION_ACK_STALE`,
   and `CONTROL_STATE_UNKNOWN` (names may change during implementation, but the
   cases must exist).
8. **Event subscription explicitly absent or versioned.** Either omit event
   subscription from the generated schema, or add the future `events subscribe`
   verb with the full cursor/backpressure/redaction contract. Do not let
   adapters scrape `/hub/node-link` event envelopes as a substitute.

These are additive to the #423 MVP. The first seven are required before #430
adapters can safely treat Relay as a peer workspace substrate. The eighth is a
hard boundary: no hidden WebSocket dependency.

## Adapter compatibility notes

### Hermes

Hermes can be a first-class `agent` peer because it already has durable profile
identity and Kanban/session concepts outside Relay. Its adapter should still be
thin: translate Hermes tool calls to CLI invocations, parse JSON/NDJSON, and let
Relay own session scope, control state, and hub policy. Hermes must not treat
Relay Kanban task identity as Relay session identity; it can pass correlation
metadata, but the Relay session envelope remains authoritative.

### Claude

Claude adapters should generate tool-use definitions from the CLI JSON Schema.
Claude hook telemetry and Relay's existing Claude PTY/session support are
feature-layer integrations, not the brain-as-peer contract. A Claude adapter may
own a Relay session as `peerIdentity.kind: 'agent'`, but it should not speak the
hook HTTP API or node-link WebSocket as its primary control plane.

### Codex

Codex function schemas should be generated from the same JSON Schema bundle as
Claude tools. Codex's local transcript/JSONL telemetry is an adapter/runtime
concern; Relay control-mode and intervention state come from #493 session
summaries and bounded reads. Codex must not infer hand-back safety from terminal
output alone.

## Consequences

- #430 adapter packages stay small and stateless. They translate native tool
  calls to CLI invocations and parse stable JSON, rather than embedding hub/node
  protocol clients.
- Relay can revise internal WebSocket envelopes without breaking adapters as
  long as the CLI major-version contract holds.
- Brain-owned sessions become auditable and revocable with the same machinery as
  human/browser sessions.
- The decision adds a small schema requirement before #430: agent peer identity,
  `sessions get`, control summary fields, hand-back ack, and bounded
  intervention reads must be stable enough to generate tools.
- Event subscription remains deferred instead of accidentally implied by the
  internal `events` channel.

## Compliance and review

PRs in #429/#430 should be blocked if they:

- Add adapter code that opens `/hub/node-link` or browser event WebSockets
  directly instead of using `relay-ide v1 ... --json`.
- Add a CLI flag that lets an adapter impersonate another brain, node, or human
  peer (`--brain`, `--act-as-node`, `--owner`, etc.) without hub-side credential
  validation.
- Encode Claude-, Codex-, or Hermes-only tool schemas by hand instead of deriving
  them from the committed CLI JSON Schema.
- Treat repo/worktree fields as required for session identity.
- Treat `controlMode` as authorization. It is state; #427 policy decides
  permission.
- Expose intervention payloads as raw keylogs or terminal transcript export.

Revisit this ADR only if a concrete #430 adapter cannot be implemented through
the versioned CLI without losing required behavior. In that case, extend the CLI
contract first; do not bypass it with adapter-specific protocol clients.
