# ADR-017: Agent brains are hub-level peers of Relay sessions, not protocol clients

- **Status:** Accepted
- **Date:** 2026-05-16
- **Refs:** #506, #429, #430, #426, #470, #493, #423, #552, #569, ADR-015, ADR-016
- **Supersedes:** none

## Status update (2026-05-19)

The schema foundations enumerated under "Minimum CLI JSON schema changes
before #430" have largely shipped. The CLI gateway contract
(`shared/cli-gateway-contract.ts`) carries agent-shaped session peer identity,
`sessions.get`, control summary fields, `sessions.handBack` with
`latestSeenInterventionEventId`, bounded `sessions.interventions` reads, and
typed control-state errors (#511, #515, #527, #532, #516, #518, #520, #523,
#536). Generated Hermes/Claude/Codex tool definitions and their adapter smokes
landed in #527, #535, #546, and #549. Active Work (#552/#569) provides the
bounded federated read model that adapters use instead of the still-deferred
`events.*` channel.

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

**Active Work substitute (2026-05).** The deferred `events.*` channel has been
intentionally replaced for adapter consumers by the Active Work bounded-read
substrate (PR #569, see `docs/WORKBENCH_BOUNDARY.md`). Active Work exposes the
federated read model — sessions, control summaries, intervention markers, and
work-context envelopes — through bounded gateway verbs and the hub's federated
surface. Adapters wanting to react to control-mode or intervention changes
should poll Active Work and the bounded `sessions.interventions` / `sessions.get`
reads rather than waiting on `events.*`. The `events.*` verbs remain
deliberately deferred; Active Work covers the read-model use case that
motivated them.

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

## Minimum CLI JSON schema changes before #430 — shipped status

The minimum-schema items required before Hermes/Claude/Codex adapters could
generate tool definitions have largely shipped under #423/#429. Status as of
2026-05-19 (verify against `shared/cli-gateway-contract.ts` and
`shared/session-envelope.ts`):

1. [x] **Agent-capable session peer identity.** `SessionPeerIdentity` carries
   `kind: 'agent'` with adapter metadata
   (`shared/session-envelope.ts:47`, PRs #511, #515).
2. [x] **Session inspection.** `sessions.get` is a stable v1 verb
   (`shared/cli-gateway-contract.ts:682`, PRs #527, #532).
3. [x] **Control summary fields.** Session descriptors expose
   `controlMode`, `activeActors`, `activeWorker`, `lastInterventionAt`,
   `lastInterventionBy`, `lastInterventionEventId`, `controlFreshness`, and
   `controlReason` (PRs #516, #518).
4. [x] **Initial control-mode request.** `sessions create` accepts a
   policy-gated initial control-mode request and rejects with a typed policy
   error when denied (PRs #516, #518).
5. [x] **Hand-back ack.** `sessions.handBack` requires
   `latestSeenInterventionEventId` before resuming `agent-driven`
   (`shared/cli-gateway-contract.ts:920`, PR #520).
6. [x] **Bounded intervention reads.** `sessions.interventions` exposes
   bounded intervention metadata and asserts `rawPayloadAvailable: false`
   and `transcriptExportAvailable: false`
   (`shared/cli-gateway-contract.ts:869`, PR #523). Per-field redaction
   shapes on payload bodies remain open and will land as adapters surface
   concrete needs.
7. [x] **Typed stale-state errors.** Gateway error taxonomy carries
   `CONTROL_STATE_STALE`, `INTERVENTION_ACK_REQUIRED`,
   `INTERVENTION_ACK_STALE`, and `CONTROL_STATE_UNKNOWN`
   (PRs #527, #532, #536).
8. [ ] **Event subscription deliberately absent.** No `events.*` verb has
   been added to the generated schema; adapters consume Active Work
   (#552/#569) and bounded reads instead. This remains a hard boundary: no
   hidden `/hub/node-link` WebSocket dependency.

These were additive to the #423 MVP. With items 1–7 in place, Hermes, Claude,
and Codex adapter packages now generate tool definitions and run smoke tests
through the CLI gateway (PRs #527, #535, #546, #549). Item 8 stays open by
design; adapters reach for Active Work, not raw events.

## Adapter compatibility notes

### Hermes

Hermes is a first-class `agent` peer because it carries durable profile
identity and Kanban/session concepts outside Relay. The Hermes adapter is
thin: it translates Hermes tool calls to CLI invocations, parses JSON/NDJSON,
and lets Relay own session scope, control state, and hub policy (smoke in
PR #546; metadata event ingestion spike in PR #565). Hermes does not treat
Hermes Kanban task identity as Relay session identity; it passes correlation
metadata, and the Relay session envelope remains authoritative.

### Claude

Claude adapters generate tool-use definitions from the CLI JSON Schema bundle
(PR #535). Claude hook telemetry and Relay's existing Claude PTY/session
support are feature-layer integrations, not the brain-as-peer contract. A
Claude adapter owns a Relay session as `peerIdentity.kind: 'agent'`; it does
not speak the hook HTTP API or node-link WebSocket as its primary control
plane.

### Codex

Codex function schemas are generated from the same JSON Schema bundle as
Claude tools (PR #549). Codex's local transcript/JSONL telemetry is an
adapter/runtime concern; Relay control-mode and intervention state come from
#493 session summaries and bounded reads. Codex does not infer hand-back
safety from terminal output alone.

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
