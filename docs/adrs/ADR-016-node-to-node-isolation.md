# ADR-016: Node-to-node isolation invariant; all inter-node traffic flows through the hub

- **Status:** Accepted
- **Date:** 2026-05-12
- **Refs:** #421, #317, #416
- **Supersedes:** none

## Context

The relay fleet pairs an arbitrary number of relay-nodes to a single
relay-hub. Each node:

- Knows the hub URL and its own persistent credential.
- Opens an outbound WebSocket to `/hub/node-link` (#416).
- Receives hub-initiated PTY attach (#418), heartbeat, and (planned) RPC
  envelopes over the reverse link.

Nodes today have no peer addressability. They do not learn other nodes'
hostnames, credentials, or endpoints. The hub authenticates each link
independently and routes envelopes by `nodeId`. This property already exists
implicitly in the protocol.

Future work will pressure this property:

- Aggregating fleet-wide views (e.g., "search across all paired nodes").
- File transfer between two paired hosts via the hub.
- Orchestration where one node's job-output triggers work on another node.
- Agent dispatch verbs ("run this on whichever node is best").

Each of those is reasonable, but a naive implementation that lets one node
ask the hub to "execute on behalf of peer node X" creates a lateral
movement vector: a compromised node would gain a foothold on every other
paired node. Tailscale ACLs and OS-level credentials mitigate transport
exposure, but only an architectural invariant at the application layer
prevents an in-protocol back door from being added later.

## Decision

Inter-node operations are not first-class. Relay-nodes never address peer
nodes, and the hub does not expose a protocol surface that lets one node
request execution on behalf of another.

### Invariant (must hold)

1. A relay-node's outbound link carries traffic for that node only. Its
   credential authenticates exactly one node identity.
2. The hub never proxies a request from node A so that node B sees node A
   as the requester. Hub-side authorization always identifies the requester
   as a hub-level peer (a browser session, a CLI-gateway invocation, an
   agent adapter), never as another relay-node.
3. Aggregation verbs that touch multiple nodes (search, list, dispatch) run
   as hub-mediated fan-out. The hub authorizes each per-node leg
   independently with hub-level credentials. Per-node legs cannot reference
   peer node responses as authorization.
4. Future cross-node features (file copy, job triggers, etc.) are
   implemented as two independent hub-issued operations (read from node A,
   write to node B) chained at the hub level, not as a single envelope that
   names two nodes.
5. The hub does not synthesize or relay credentials for one node to be used
   in another node's context.

### Out of scope of this ADR

- Transport-layer security (TLS, Tailscale ACLs). Those are defense-in-depth
  layers below this invariant. This ADR is the application-layer rule.
- Multi-hub federation. If multiple hubs federate in the future, the same
  invariant applies at each hop.
- Operator UX for cross-node workflows. The invariant constrains the
  protocol and routing, not how users see fleet-wide views.

## Consequences

- **Positive.** A compromised node's blast radius is bounded by the node
  itself. The compromised node cannot impersonate or drive peer nodes
  through the hub.
- **Positive.** Hub-side authorization stays uniform: every routed request
  has a hub-level identity. Audit log entries (see #427) carry one
  unambiguous requester per operation.
- **Positive.** Cross-node features remain composable via the hub's
  primitives without inventing a "node-acts-as" surface that would couple
  authorization to the node identity space.
- **Negative.** Some operations cost one extra hub hop (e.g., file copy
  between nodes flows browser/CLI → hub → node A read → hub → node B
  write, rather than node A → node B direct). Acceptable for the security
  property gained.
- **Negative.** Future "agent on node A wants to call a tool on node B"
  scenarios must be expressed as hub-mediated dispatch, which means agents
  on nodes do not have a back-channel to peers. This is intentional.

## Compliance and review

- `/adr:review` should fail PRs that:
  - Add a protocol field naming a peer node in an envelope sent by a node.
  - Add a hub-side route that takes "actAsNodeId" or accepts a node
    credential as authorization for routing to a different node.
  - Add node-side outbound calls that target peer relay-nodes or
    fleet-internal addresses (Tailscale peer endpoints, hub-mediated
    cross-node URLs, etc.). Outbound calls to external services (agent
    CLIs reaching their providers, Playwright fetching public URLs per
    ADR-011, package registries, etc.) are not constrained by this ADR.
- This invariant is referenced by #427 (security backbone) and #429 (CLI
  gateway). PRs in those epics must demonstrate compliance.
- Re-evaluate this ADR only if a concrete operational need cannot be met by
  hub-mediated composition, and only after a documented threat-model review.
