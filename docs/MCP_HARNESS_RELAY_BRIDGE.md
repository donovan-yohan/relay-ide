# MCP Harness ↔ Relay Bridge

## Decision

Build a hybrid with a versioned **Relay MCP control-plane facade** over Relay's
canonical command manifest, provider-specific **connector/outbox data planes**,
and a separate **isolated Relay-under-test control plane**. These are different
products with different authority, data, and proof requirements:

1. **External harness bridge.** A Codex, Claude Code, ChatGPT, or custom
   harness may explicitly register/connect an external conversation with Relay,
   select an approved source node and adapter, receive a scoped lease, post in
   an existing Relay channel, and later obtain a truthful Relay continuation
   packet. A connector—not a model tool call per message—mirrors permitted
   provider events into Relay.
2. **Relay development control.** An agent developing Relay may provision and
   drive an isolated authenticated hub, then observe durable semantic results
   and real browser E2E evidence. This is not normal Relay usage and must never
   borrow the daily-driver browser PIN or cookie.

The bridge must make neither false promise: MCP does not expose a host's
complete conversation transcript, and a terminal execution `Session` is not a
channel conversation. In Relay vocabulary, **a channel is a conversation**;
public `Session` remains terminal execution.

## Why now

The MCP `2026-07-28` revision retires transport handshakes and
`Mcp-Session-Id`: every request carries its version, client metadata, and
capabilities. It supports explicit state handles, an optional Tasks extension,
and HTTP routing headers. That fits a Relay gateway that already treats its
versioned CLI manifest as the adapter-facing substrate. It does _not_ turn MCP
into a transcript bus, a trusted identity assertion, a terminal-control
channel, or a browser automation framework.

Primary evidence:

- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
  confirms the stateless protocol core, removal of protocol session ids, MRTR,
  Tasks, subscriptions, headers, and the Tier-1 SDK release.
- [MCP architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)
  defines tools/resources/prompts, per-request discovery metadata, optional
  streamable HTTP, and explicitly says MCP does not dictate how a host manages
  LLM context.
- [Tasks extension](https://modelcontextprotocol.io/seps/2663-tasks-extension)
  defines task creation, poll/update/cancel, terminal lifecycle, and routing by
  `Mcp-Name: taskId`; it also says task progress/message notifications are not
  supported on the subscription stream.
- [HTTP header standard](https://modelcontextprotocol.io/seps/2243-http-standardization)
  requires modern clients to mirror method/name (and marked parameters) in
  headers and requires body-processing servers to reject disagreement.
- [OpenAI MCP documentation](https://developers.openai.com/codex/mcp/)
  confirms MCP support in the ChatGPT desktop app, Codex CLI, and IDE extension
  for stdio/Streamable HTTP with Bearer and OAuth authentication; its public
  docs do not promise host-transcript export or `2026-07-28` extension support.
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
  confirms Streamable HTTP, Bearer/OAuth/CIMD, and the provider-specific
  server-to-Claude `claude/channel` capability. It does not document a generic
  feed of all current-session turns to MCP servers.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) document lifecycle
  events and common `session_id`/`transcript_path` hook context; [Claude
  sessions](https://code.claude.com/docs/en/sessions) document local JSONL
  persistence, retention, and the ability to disable persistence.

## Capability matrix

| Need                              | MCP 2026-07-28 confirms                                                | Relay must provide                                                         | Host/provider dependency                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Discover a bridge                 | `server/discover`, per-request capabilities                            | `relay-mcp/v1` tool/resource catalog and version negotiation               | Host must connect/configure the server.                                                                        |
| Durable cross-call identity       | No transport session; application can mint explicit handles            | Opaque Relay conversation-registration handle, cursor, job ids             | Agent must retain/pass handles.                                                                                |
| Register an external conversation | Tools can receive explicit arguments                                   | Registration record, authorization, idempotency, retention/redaction       | Provider session ref is opaque and voluntary.                                                                  |
| Mirror conversation turns         | Tool calls/results only                                                | Connector/outbox import, ordered event store, and explicit fallback append | No standard host transcript/event export. Needs provider hook/app-server/outbox or an explicit agent fallback. |
| Continue later                    | Resources/tools can return context                                     | Deterministic WorkContext resume packet/handoff                            | Native provider resume only if a provider adapter verifies account/access.                                     |
| Long reviewer/E2E job             | Optional Tasks extension with poll/update/cancel                       | Relay-owned job state and `wait`/read evidence tools                       | Feature-detect Tasks; current public Codex/Claude host docs do not establish support.                          |
| Live change feed                  | `subscriptions/listen` for opted-in supported notifications; no replay | Cursor-bearing Relay resources/events; re-read after reconnect/gap         | Host must advertise/listen; never rely on it for raw terminal output.                                          |
| Secure remote access              | OAuth; CIMD is the preferred client-registration path                  | Scoped, short-lived Relay credentials and capability enforcement           | Host must complete OAuth or inject a managed lease.                                                            |
| Human-like Relay E2E              | Nothing                                                                | Isolated hub/bootstrap and browser automation fixtures                     | Browser automation is a separate capability, not MCP.                                                          |

### Non-assumptions

- `_meta.clientInfo` is diagnostic metadata, not identity or authority.
- Tasks are not a general streaming primitive; a successful admission is not a
  completed review or E2E result.
- MCP subscriptions have no replay; a dropped listener must re-read Relay state.
- Claude's `claude/channel` is server-to-Claude notification plumbing, not
  bidirectional transcript mirroring. No equivalent automatic host-turn export
  is established by the public Codex/ChatGPT docs.
- Relay must support a negotiated legacy MCP mode until target-host
  interoperability proves `2026-07-28`; server support alone does not prove the
  host's current protocol or extension support.

## Alternatives and selected division of labor

| Surface                                 | Best role                                                                          | Do not use it for                                                                                  | Decision                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| MCP facade                              | Portable discovery, consented connect/register, scoped command access, status/jobs | Passive transcript interception, PTY bytes, browser emulation, or canonical completion persistence | Adopt, thin over the command manifest.                                                                |
| Stable CLI gateway                      | Canonical Relay command semantics and adapter parity                               | Host-specific transcript capture                                                                   | Keep as the internal boundary; MCP calls it rather than forks it.                                     |
| Provider-native hook/app-server adapter | Capture supported provider events and verify native continuation                   | Cross-provider generic behavior                                                                    | Preferred external-conversation data plane, one provider at a time.                                   |
| Local connector/sidecar with outbox     | Read a permitted local event source and push normalized records to Relay           | Relay receiving arbitrary filesystem paths or broad provider DB access                             | Preferred where a supported provider event API/hook is absent.                                        |
| Read-only transcript file               | Development/prototype fallback with explicit fragility                             | Authority, complete history, or durable native resume                                              | Permit only with consent, schema fingerprint, rotation/truncation handling, and degraded status.      |
| Direct provider/session DB scraping     | None by default                                                                    | Production synchronization or authorization                                                        | Prohibit unless a provider sanctions a narrow interface and a separate security decision approves it. |
| Isolated Playwright test driver         | Real authenticated Relay UI proof                                                  | Normal external harness communication                                                              | Adopt for Relay development through local CLI/test-driver; do not expose it on remote MCP.            |

**Selected hybrid:** MCP is the permissioned control plane. After a successful
`connect/register`, Relay selects or receives a named provider connector. That
connector owns a narrow provider-side source and pushes an ordered, redacted
outbox into Relay through Relay-owned node routing. The CLI gateway remains the
canonical Relay boundary, and the isolated Playwright lane supplies
human-emulation proof. Explicit
`append_external_event` calls are a fallback for providers with no usable
connector, not the normal mirroring architecture.

### Thin falsification experiment before broad investment

Build no transcript importer first. In a private isolated hub, implement only
`server/discover` plus `relay.conversations.register_external`,
`relay.conversations.get`, and `relay.jobs.get` backed by existing command
dispatch. Run a matrix from current Codex CLI/desktop, Claude Code, and one
custom TypeScript SDK client: OAuth or pre-minted test lease, discovery,
register retry idempotency, channel-scope denial, and polling. Record negotiated
protocol and advertised extensions. The experiment fails if a host cannot use
the chosen auth/Streamable HTTP path or MCP-to-gateway parity is not exact; in
that case retain direct CLI/provider adapters and defer the MCP transport.

## Current-state audit and root causes

| Observed result                                                                                      | Root cause                                                                                                                            | Required correction                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw Bearer yielded `UNAUTHORIZED` / `CLI_GATEWAY_OR_BROWSER_AUTH_REQUIRED`                           | Gateway requests additionally require `x-relay-cli-gateway: v1`; the official CLI also supplies actor-token and exact-command headers | Expose one documented MCP authorization lane that creates the canonical gateway request. Do not ask agents to reverse engineer headers.                 |
| A scoped actor token cannot drive PTY WebSocket control                                              | Actor credentials are intentionally not terminal-control credentials                                                                  | Keep it fail-closed. Use a dev-only test principal plus browser/E2E API path; never extend external bridge authority to arbitrary PTY input.            |
| Local `POST /sessions` can enter legacy `CONTROL_STATE_UNKNOWN`, while routed creation is fresh      | Creation/control freshness paths are inconsistent                                                                                     | Normalize initialization or return a typed waitable readiness result. Do not make a caller race attach/input.                                           |
| Direct and supervisor input reject uncertain control state                                           | Correct fail-closed terminal-control boundary                                                                                         | Preserve it. Test harness must await explicit readiness or use a human-driven browser attachment.                                                       |
| `sessions.wait` was mistaken for reviewer completion                                                 | It is a bounded raw-output text predicate, not semantic lifecycle proof                                                               | Add semantic job/evidence status and a completion predicate over it; retain `sessions.wait` only as terminal diagnostic support.                        |
| Reviewer output appeared after apparent timeout                                                      | PTY observation is asynchronous/bounded and files were checked too early                                                              | Persist review artifacts and terminal job state before notification; add cursor/polling and final artifact re-read to the harness.                      |
| Existing CLI contract declares only `channels.post`                                                  | Actor-auth HTTP routes implement channel reads, but those reads are not stable gateway commands                                       | Expand the canonical command manifest first; MCP may expose only declared commands.                                                                     |
| Actor credential scope has no `channelIds` dimension and channel routes do not enforce it            | A generic scoped actor could potentially escape its intended conversation boundary                                                    | Add/require channel scope or a channel-to-WorkContext binding on list/get/history/threads/roster/post, plus negative escape tests, before MCP exposure. |
| `scripts/orchestrator-peer.ts` logs in using `--pin` / `RELAY_PEER_PIN` and retains a browser cookie | It is a PIN-carrying prototype/migration target, not a remote-harness design                                                          | Replace with one-time grant redemption or a pre-minted short lease. Daily PIN/cookie never enter agent config, env, logs, or artifacts.                 |
| `dev:self` did not bypass authentication                                                             | Correct current security posture                                                                                                      | Preserve production auth. Provide explicit isolated test bootstrap instead of weakening `dev:self`.                                                     |
| Current E2E isolation works                                                                          | Isolated config/path/ports already prevent daily-hub interference                                                                     | Reuse it as the only base for development harnesses; no daily-driver restart/credential reuse.                                                          |
| No MCP server exists                                                                                 | Relay has a CLI/gateway substrate but no MCP transport facade                                                                         | Add one adapter layer; do not create an alternate evidence or command ledger.                                                                           |

## Domain model for external conversations

Do not overload `WorkContext.SessionRef`, public terminal `Session`, inbox, or
the existing channel roster to represent an outside-provider conversation.
Create a durable `ExternalConversationRegistration` record and a Relay-owned
`relayConversationId`:

```ts
type ExternalConversationRegistration = {
  id: string; // registration id, opaque externally
  relayConversationId: string; // stable Relay conversation identity
  channelId: string; // durable channel (the conversation)
  workContextId: string; // linked atomically; never SessionRef
  sourceNodeId?: string; // set only after Relay-approved connector enrollment
  provider: 'codex' | 'claude-code' | 'chatgpt' | 'custom';
  providerRef: { protectedRefId?: string; opaqueRefHash: string };
  actor: { id: string; issuer: string; issuerSubjectHash: string };
  sync: {
    owner: 'agent' | 'provider-adapter' | 'operator';
    mirrorMode:
      | 'manual'
      | 'agent-invoked'
      | 'provider-adapter'
      | 'outbox'
      | 'none';
    connector?: { id: string; schemaFingerprint: string; leaseId: string };
    writerProvenance: 'connector-verified' | 'agent-invoked-unverified';
    sourceCursor?: string;
    lastRelaySequence: number;
  };
  continuation: {
    mode: 'relay-resume-packet' | 'relay-handoff' | 'provider-native';
    reason?: string;
  };
  retention: { policy: string; expiresAt?: string; redactionProfile: string };
  createdAt: string;
  updatedAt: string;
  version: number;
};
```

Registration atomically creates/links the WorkContext and channel where that is
authorized. Reuse existing channel durable sequence/history and
`clientMessageId` dedupe; reuse WorkContext Message append-only/redacted
external references. A WorkContext resume packet remains bounded and excludes
raw transcript, so it is the default continuation truth. Inbox is an
alert/request surface, not a substitute conversation. Workspace topics may
provide the workspace's dev channel but do not replace this registration.

### Ordered import invariant

Each imported external event has `(registrationId, sourceEventId)` uniqueness,
a provider cursor, and Relay's server-authoritative channel sequence. The
transaction either appends the event and advances the cursor or returns the
existing append result. Cursor compare-and-swap detects reorder/gap; a gap
produces an explicit `sync-gap` state rather than silently inventing order.
Persist only redacted provider references and permitted normalized message
content. Raw provider transcripts/tokens/cookies are forbidden from diagnostics,
events, audit, and generic artifacts.

### Connector/outbox data plane

MCP registration performs consent and persists an unpaired registration as
`manual`/`agent-invoked` with no connector lease. Later `enroll_source` asks
Relay capability discovery for an eligible source node; Relay selects and sets
the approved `sourceNodeId` and adapter. The caller cannot invent a node id;
MCP does not pass every turn through the model. The hub dispatches only through Relay-owned node routing;
the caller cannot supply a filesystem path or speak private node-link. A selected
connector holds an exclusive, renewable registration lock and pushes a versioned
outbox batch to Relay's canonical import command. A batch includes connector
id/version, schema fingerprint, registration id, checkpoint cursor, source event
ids, idempotency key, and an explicit `complete|partial|gap|rotated|truncated|
source-node-lost` source signal. Relay validates the lease, lock, schema
compatibility, cursor CAS, and redaction before atomically appending it.

Connector recovery is specified, not inferred: persist checkpoints only after
Relay acceptance; on restart re-read from the accepted cursor; on source-node
loss, revoked/expired lease, file rotation/truncation, or unrecoverable gap mark
degraded and request a bounded reconciliation/fullness decision. A read-only
transcript file is a fragile connector source and must fingerprint its format,
cap its reads, handle rotation/truncation, and never be accepted as proof of
complete history. Relay never accepts arbitrary file paths or broad provider-DB
credentials from a remote harness.

For a conversation not already attached to a paired node, registration creates
no connector lease. A separate authenticated `enroll_source` handshake first
lists eligible Relay-owned source nodes, then binds the provider, protected
provider reference, registration, source identity, and installed adapter to one
approved local node. Only after that node/adapter proves the binding may Relay
issue a per-registration connector lease. If discovery, pairing, adapter
approval, or proof is unavailable, the registration remains truthfully
`manual`/`agent-invoked`, not `outbox`.

Adapter trust tiers are: **(1)** provider-supported event API/app-server,
**(2)** lifecycle hook plus transcript checkpoint, **(3)** explicit
export/import, and **(4)** direct DB tailing, experimental and no-go by default.
Claude Code hook plus checkpoint is therefore the first adapter candidate; it
must report `persistence-unavailable` rather than pretending to mirror when
local session persistence is disabled. The actual provider-native resume ref
belongs only in protected provider-bound state (`protectedRefId`); ordinary
registrations, logs, and artifacts retain a hash/availability status only. A
hash alone cannot resume a provider session.

Only an accepted per-registration connector lease may write events marked
`connector-verified` or claim `provider-adapter`/`outbox` provenance. An actor
credential using fallback append is always `agent-invoked-unverified`; it cannot
advance adapter checkpoints or enable provider-native resume. Channel/UI status
and continuation packets retain this distinction rather than upgrading it later.

### Honest continuation semantics

Default continuation is `relay-resume-packet` or `relay-handoff`: a caller can
continue the _work_ with durable Relay context, evidence, and channel history.
`provider-native` is available only after the provider adapter proves the same
provider account/access and reports a successful native import/resume. A failed
or unavailable provider import leaves the Relay continuation valid and records
the typed reason; it must not imply the original chat can be reopened.

## Proposed MCP facade

### Boundary

Implement `relay-mcp` as a thin Streamable HTTP facade generated from or
checked against `shared/relay-command-manifest.ts` /
`shared/cli-gateway-contract.ts`. It invokes the same command handlers and
serializes the same typed results, errors, audit, redaction, and capability
checks as `relay-ide v1 ... --json`. It must not scrape browser WebSockets,
speak private `/hub/node-link`, duplicate channel persistence, or create an
MCP-only evidence model.

The facade declares support for the modern protocol but dispatches according to
the requested/supported version. It uses `server/discover`, validates
`Mcp-Method`, `Mcp-Name`, and schema-marked `Mcp-Param-*` values before
dispatch, and emits cache metadata where required by the selected MCP version.
The exact host protocol/extension set is feature-detected and recorded in a
safe connection diagnostic, never guessed from host brand.

### First stable tools

Tool names are illustrative; each needs a manifest command and JSON schema
before it becomes MCP-visible.

| Tool                                               | Input essentials                                                                                            | Result / invariant                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `relay.conversations.register_external`            | provider, opaque external ref, workspace, optional project/title, mirror/continuation mode, idempotency key | Registration/channel/WorkContext created or returned atomically as manual/agent-invoked with no connector lease. Never returns secrets.   |
| `relay.connectors.enroll_source`                   | registration handle, Relay-discovered source node id, source/adapter attestation                            | Separately authorizes provider/protected-ref/registration/source binding before a connector lease exists.                                 |
| `relay.conversations.append_external_event`        | registration handle, source event id, source cursor, normalized/redacted event, client message id           | Explicit agent fallback only. Exactly once by registration+event; rejects gap/reorder with typed state.                                   |
| `relay.connectors.status`                          | registration handle                                                                                         | Selected adapter, lease/lock state, schema fingerprint, checkpoint, fullness/gap and degraded reason.                                     |
| `relay.conversations.get`                          | registration/Relay conversation handle                                                                      | Sync status, safe channel/WorkContext refs, retention and truthful continuation availability.                                             |
| `relay.conversations.continuation_packet`          | registration handle, bounded packet options                                                                 | Deterministic Relay resume/handoff packet; native ref only when verified.                                                                 |
| `relay.channels.post`                              | declared canonical channel post input, idempotency key                                                      | Existing channel semantics/capability checks.                                                                                             |
| `relay.channels.{list,get,history,threads,roster}` | stable command-shaped input with channel/WorkContext scope                                                  | Added to manifest before exposure and channel-scope checked.                                                                              |
| `relay.jobs.start_review`                          | target/head/diff digest, reviewer profile, exact task specification                                         | Returns Relay `jobId`; admission is explicitly nonterminal.                                                                               |
| `relay.jobs.get` / `relay.jobs.wait`               | job id, last event cursor, timeout                                                                          | Durable semantic state plus artifact/evidence refs. `wait` returns `timeout`, `gap`, or a terminal state—never raw terminal-text success. |

Suggested registration schema excerpt:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["provider", "externalRef", "workspaceId", "idempotencyKey"],
  "properties": {
    "provider": { "enum": ["codex", "claude-code", "chatgpt", "custom"] },
    "externalRef": { "type": "string", "minLength": 1, "maxLength": 1024 },
    "workspaceId": { "type": "string" },
    "projectId": { "type": "string" },
    "title": { "type": "string", "maxLength": 200 },
    "mirrorMode": {
      "enum": ["manual", "agent-invoked", "provider-adapter", "outbox", "none"]
    },
    "continuationMode": {
      "enum": ["relay-resume-packet", "relay-handoff", "provider-native"]
    },
    "idempotencyKey": { "type": "string", "minLength": 16, "maxLength": 256 }
  }
}
```

No external tool can call `sessions.input`, `supervisor.*`, private agent
runtimes, browser-cookie routes, or node-link APIs. The general facade may
read/compose declared Relay commands; terminal control remains a separate,
human-driven and explicitly capability-gated product surface.

### Completion and event contract

`relay.jobs.start_review` creates a Relay-owned job record and durable
artifact location before launching work. It transitions through
`queued → starting → running → waiting-input → succeeded|failed|cancelled|timed-out`.
Its terminal result includes source ref, exact head/diff digest where relevant,
artifact ids, and an evidence cursor. It is idempotent by request key.

If both peers advertise `io.modelcontextprotocol/tasks`, map this record to a
Tasks extension handle and support `tasks/get`/`tasks/cancel` (and update where
appropriate). Otherwise `relay.jobs.get`/`wait` is canonical. Model
subscriptions are a cache-invalidation/notification optimization: a listener
re-reads the job resource after a cursor gap or reconnect. Persisted job state,
not an SSE/PTY stream or a compaction summary, decides completion.

## Authentication and threat boundaries

### External harness bridge

1. Remote `relay-mcp` is an OAuth protected resource. Publish protected
   resource/authorization metadata and use CIMD where the host supports it;
   retain DCR compatibility only as needed. An OAuth access token is permitted
   only in the `Authorization` header and in-memory request context for its
   short lifetime: never persist, configure, prompt, return, log, artifact, or
   forward it. Exchange produces short-lived, issuer-bound Relay actor leases
   with explicit capabilities, workspace, WorkContext, and **channel** scope.
2. A one-time Relay operator handshake grant may bootstrap a narrowly scoped
   lease only after the established ceremony validates actor, audience,
   capability, TTL, and bindings. The grant is consumed; it is neither a
   browser login nor a reusable actor token.
3. The daily-driver PIN, browser session cookie, `RELAY_PEER_PIN`, legacy actor
   token, OAuth refresh token, and grant secret must never be present in an MCP
   config, prompt, tool result, event, log, artifact, or test fixture.
   `orchestrator-peer.ts` is explicitly migration-only until it stops doing
   PIN/cookie automation.
4. A scoped actor credential must include `channelIds` or derive allowed
   channels from a bound WorkContext. Enforce it at list/get/history/threads/
   roster/post—not just at tool discovery—and prove forbidden sibling channel
   reads/writes fail.
5. The bridge's normal scopes exclude terminal input and server lifecycle.
   `clientInfo`, a provider label, and a claimed external session id do not
   elevate authority. Provider-native import/resume must reauthorize against
   the provider adapter.

### Isolated Relay-under-test lane

1. `dev:self` remains authenticated. A developer starts an isolated config,
   database/runtime root, loopback endpoint, and test workspace using existing
   E2E isolation conventions; it is visibly not the daily hub.
2. A local developer-approved bootstrap issues a single-run, short-TTL test
   principal/lease for that isolated instance. The test capability set is
   explicit: fixture creation, channel operation, semantic observation, and
   browser automation setup are separated from destructive reset/teardown.
3. Browser E2E uses a human-like browser client against the real authenticated
   isolated app. Local CLI/test-driver controls provision/read evidence; they
   are not a privileged alternative to browser actions or PTY control. A local
   MCP wrapper can be considered later, but is not part of remote `relay-mcp`.
4. Local/routed public session readiness returns a typed fresh/blocked state.
   Tests wait for it rather than retrying input over `CONTROL_STATE_UNKNOWN`.
5. Teardown accepts only the isolated instance handle and records cleanup. It
   refuses broad paths, the daily hub, and expired/foreign handles.

### Local-only `relay-ide dev-harness` contract

The current agent-browser helper is insufficient. Add local CLI commands—kept
outside remote MCP and raw PTY control—for `start`, `status`, `browser open`,
`browser action`, `browser assert`, `browser screenshot`, semantic `await`,
`evidence`, and `teardown`, all with `--run <opaque-handle> --json` after
`start`. `start` returns only the opaque handle, exact loopback origin, expiry,
and allowed actions, never credentials. Capabilities split fixture seed,
browser observe, browser action, semantic await/evidence read, and destructive
cleanup. Every command validates its handle, exact origin, isolated config root,
and action capability; it refuses remote/non-loopback origins, the daily hub,
foreign/expired handles, arbitrary file selectors, raw PTY input, and
unredacted secrets. Evidence stores safe action/assertion summaries, origin,
exact head, and artifact ids; screenshots/logs use existing redaction. The
browser driver performs real authenticated UI actions, while `await` reads
Relay-owned semantic state rather than terminal text.

## Phased implementation plan

Each slice is independently mergeable and targets `nightly`. Review the exact
head through an independent Codex or Claude reviewer before expensive CI; batch
valid findings and perform one focused re-review after fixes.

### Slice 0 — contract and security prerequisites

**Intent:** make existing HTTP capabilities honest gateway commands and close
channel-scope escape before any MCP listener exists.

- Extend `shared/relay-command-manifest.ts`,
  `shared/cli-gateway-contract.ts`, and `shared/cli-gateway-runtime.ts` with
  channel read verbs and schemas, source-compatible CLI wiring, and stable
  typed errors.
- Extend `server/cli-gateway-actor-auth.ts` and `server/channel-chat-router.ts`
  so actor leases carry/enforce a channel or WorkContext-derived channel scope.
- Mark/rework `scripts/orchestrator-peer.ts`; remove PIN/cookie-based harness
  advice and route future bootstrap through operator grants/short leases.
- Add contract/negative tests in `test/cli-gateway-contract.test.ts`,
  `test/cli-gateway-actor-auth.test.ts`, `test/channel-routes.test.ts`, and
  `test/orchestrator-peer.test.ts`.

**Gate:** an actor allowed on channel A cannot enumerate, read history/roster,
thread, or post to channel B; no undocumented actor-auth HTTP path is exposed
by a declared bridge command.

### Slice 1 — external conversation registration and ordered import

**Intent:** introduce Relay-native durable identity without corrupting terminal
or WorkContext semantics.

- Add shared types/schema and a migration/store module near
  `server/channel-message-store.ts`, `server/workspace-topics.ts`, and the
  WorkContext persistence owner. Name it explicitly for external conversation
  registrations; do not mutate `SessionRef`.
- Add canonical commands/routes, then CLI wiring, for registration/get/
  connector-status/outbox-import/continuation. Link new channel + WorkContext +
  registration atomically; retain explicit append only as a fallback.
- Reuse WCM append-only/redaction and channel `clientMessageId` rules. Store
  only hash/opaque provider refs and bounded normalized events.
- Tests: idempotent and concurrent registration; exclusive connector lock;
  duplicate/reordered/gapped source events; restart/rotation/truncation recovery;
  retention/redaction; revoked lease; enrollment proof failure; actor-vs-
  connector provenance; provider-import failure; and handoff-only continuation
  truth.

**Gate:** race/restart/source-node loss cannot create duplicate channels,
reassign a provider ref, silently reorder an event, accept a changed connector
schema without migration, or claim native provider continuation.

### Slice 2 — isolated test bootstrap and semantic completion

**Intent:** replace ad hoc local PIN/cookie/PTY review bootstrap with a secure
development harness.

- Reuse existing E2E config isolation from `package.json`, test fixtures, and
  runtime config helpers such as `server/runtime-state-paths.ts`; add a
  dev-only bootstrap/control module rather than weakening `npm run dev:self`.
- Add isolated test principal/lease mint, job lifecycle persistence, exact
  artifact/evidence references, cursor-aware `get`/`wait`, and terminal
  readiness diagnostics. Keep `sessions.wait` documented/tested as raw output
  matching only.
- Focus likely files: `server/sessions.ts`, `server/session-control-api.ts`,
  `shared/supervisor-actions.ts`, `server/features/workflow-run-router.ts`,
  `server/features/work-context-artifact-router.ts`, and targeted new
  `server/features/dev-harness-router.ts` / shared types.
- Tests: fresh routed/local creation; direct/supervisor fail-closed control;
  job terminal evidence after delayed file write; timeout/gap/reconnect;
  non-daily-instance/origin refusal; action-capability split; lease expiry;
  screenshot/evidence redaction; and teardown scope.

**Gate:** a test agent can create and observe an isolated authenticated hub
without knowing the daily PIN, while no agent credential can take over an
arbitrary PTY.

### Slice 3 — `relay-mcp` transport facade

**Intent:** expose only the canonical, scoped domain contract through MCP.

- Add a dedicated MCP server/transport module (for example
  `server/mcp/relay-mcp-server.ts`) and registration in `server/index.ts`.
  Use the official TypeScript MCP SDK; do not hand-roll JSON-RPC framing.
- Bind tool definitions mechanically to the command manifest. Add modern
  `server/discover`, `_meta` version/capability handling, Streamable HTTP,
  OAuth protected-resource metadata/CIMD, strict standard/parameter header
  validation, and safe legacy compatibility.
- Start with registration/connect/status, continuation, scoped channel verbs,
  and jobs. Keep outbox import behind a connector credential; keep all dev
  bootstrap, raw terminal, and private hub/node controls out.
- Tests: SDK conformance/manifest drift, header/body mismatch, unauthenticated
  and wrong-audience lease, channel-scope escape, 2026 negotiation fallback,
  tool idempotency, redaction, and no secret in tool responses/logs.

**Gate:** every exposed MCP action maps to exactly one manifest command and
produces identical authorization/error semantics to CLI/API usage.

### Slice 4 — optional Tasks/listen plus provider adapters

**Intent:** improve interop without making a host-specific feature mandatory.

- Advertise/use Tasks only after client capability detection. Map task polling
  to canonical Relay job state; retain `relay.jobs.get/wait` universally.
- Expose resource updates/subscriptions as invalidation hints with cursor/gap
  documentation, never as transcript or terminal streaming.
- Add provider adapter/outbox interfaces first. Add Codex/Claude/ChatGPT native
  integration only when each provider provides a supported event/export/resume
  authority and tests it; retain agent-invoked append as the degraded fallback.
- Create a compatibility matrix driven by real host integration runs, pinned
  client versions, negotiated protocol, auth flow, Tasks/listen result, and
  provider-native resume result.

**Gate:** a missing extension or provider adapter degrades to normal
registration/polling/handoff without loss of truth or unexpected privilege.

## Acceptance and evaluation gates

### External harness bridge

- Registration is idempotent across retries and concurrent callers, atomically
  links the intended channel and WorkContext, and never creates a terminal
  `Session` surrogate.
- An unpaired registration returns manual/agent-invoked with no connector lease;
  only later approved enrollment upgrades it. A caller-invented node id is
  rejected rather than selecting or binding a connector.
- Event import has exactly-once `registrationId + sourceEventId`, source cursor
  compare-and-swap, explicit gap/reorder state, and server-authoritative channel
  sequencing.
- Connector tests cover approved-node-only dispatch, exclusive ownership lock,
  version/schema fingerprint drift, restart, source-node loss, rotation,
  truncation, gap/fullness, and revoked lease; none accepts an arbitrary client
  path or provider database credential.
- Redaction/retention tests prove opaque provider refs are safe and raw
  transcripts/tokens/cookies do not enter logs, event frames, audit, or
  artifacts.
- Channel access tests prove every read and write respects issuer, capability,
  workspace/WorkContext, and per-channel scope.
- A provider unavailable/denied import gives a useful deterministic Relay
  resume/handoff packet and a typed native-resume failure reason.
- Enrollment binds a Relay-discovered paired node, source identity, protected
  provider ref, registration, and approved adapter before a connector lease;
  loss leaves truthful manual/agent-invoked status.
- Fallback append remains visibly actor-authored/unverified, cannot claim
  connector provenance or native resume, and this survives UI/continuation read.
- MCP/CLI parity test enumerates the exposed tool set and fails on manifest or
  schema drift. Header mismatch, unauthorized lease, wrong audience, expired
  grant, and channel escape all fail closed.

### Relay-under-test lane

- An agent starts one isolated authenticated instance, obtains only a
  short-lived test lease, creates a channel/test actor, performs browser E2E,
  and obtains persisted semantic evidence/artifacts.
- `dev-harness` tests cover opaque handle, exact-origin/local-only and daily-hub
  refusal, action-capability split, redaction, expiry, semantic await/evidence,
  screenshot, and teardown.
- No test invokes the daily hub, reads a browser cookie/PIN, changes global
  config, or restarts the daily-driver hub.
- A local/routed session's readiness is visible before input; deliberate stale
  state yields typed block rather than an unsafe retry.
- Job results remain observable after delayed output/artifact persistence,
  restart/reconnect, and subscription gap. A compaction summary is never test
  authority; final filesystem/artifact/state reads are.
- Existing focused checks remain fast, then exact-head `npm run check`,
  `npm test`, relevant E2E, and CI run for behavior/security/protocol changes.

## Review protocol and evidence

For each security/protocol slice, the implementer delegates a **broad,
read-only adversarial review** to an independent Codex or Claude session that
did not write the change. The review must record the exact commit SHA, manifest
digest, tested threat boundaries, findings, disposition, and artifact refs.
Self-declared model/session ids are insufficient provenance. Batch accepted
findings once; then ask a focused reviewer to inspect only changed hunks and
immediate contracts. Any behavior/security/protocol head change starts a fresh
targeted QA/review artifact chain; old evidence remains history and is marked
stale.

Required evidence includes command plus exit code, exact head, test instance
id (not secret), browser/E2E artifact id, job/artifact state, reviewer
provenance, and cleanup result. Store it through canonical WorkContext/handoff
artifacts, not raw PTY transcript files.

## Stop conditions

Do not ship the external bridge if any of these remains true:

- channel-scoped actor authorization is absent or bypassable;
- a bridge operation relies on the browser PIN/cookie or exposes terminal
  control;
- channel reads are MCP-exposed without stable manifest commands;
- ordered import lacks retry/idempotency/gap behavior;
- connector dispatch permits an unapproved source node, lacks lock/schema/
  checkpoint recovery, or hides loss/rotation/truncation/fullness degradation;
- provider-native resume is represented as available without verified adapter
  evidence;
- task/subscription availability is assumed rather than negotiated;
- test bootstrap can address the daily hub or cannot prove isolated cleanup;
- a security/protocol exact-head lacks the required independent review and
  targeted verification evidence.

## Rollout and compatibility

1. Ship no listener in Slice 0/1. Exercise new canonical commands locally and
   in CI under actor-scope/redaction tests.
2. Land isolated dev harness behind explicit local test configuration and run
   it in Relay's own E2E lane before enabling any remote bridge.
3. Introduce `relay-mcp` disabled by default, loopback/private-network first,
   with OAuth/CIMD configuration and audit dashboards. Keep a kill switch that
   disables MCP routing without affecting hub/channel operation.
4. Begin with connector/outbox mirroring and Relay resume packets where a
   provider supports it; retain explicit agent-invoked append as fallback.
   Publish support as `manual`/`agent-invoked`/`adapter-verified`, not a broad
   “synced” claim.
5. Enable remote operators by allowlisted issuer/scopes and use telemetry that
   records only safe command/result metadata. Add Tasks/listen after real host
   compatibility tests; retain polling/legacy protocol fallback.
6. Promote provider-native resume one provider at a time after account binding,
   consent, failure handling, and integration evidence. Revoke leases and keep
   legacy CLI gateway behavior stable throughout.

## Out of scope

- Replacing Relay's channel/WorkContext or terminal/session architecture.
- Importing arbitrary historical third-party transcripts by scraping provider
  databases or browser storage.
- Turning `rlm()` admission, PTY output, MCP subscriptions, or compaction
  summaries into an unverified completion authority.
- General remote terminal control, automation against the daily hub, or PIN
  distribution to agents.
