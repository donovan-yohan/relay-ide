# Relay Security Policy Schema

Relay separates node capability discovery from hub-granted policy. A node manifest says what a node appears able to do right now; the hub ACL says what the hub is willing to route to that node. Manifest data is availability/probe evidence, never a grant.

Agent-authored static HTML/CSS evidence uses the constrained view artifact model in `docs/AGENT_VIEW_ARTIFACTS.md`; its MVP denies all declared runtime capabilities and renders only through an empty-sandbox iframe.

## Auth lanes and browser-session boundary

Relay auth is split into lanes. The current route inventory is checked into `server/auth.ts` as `AUTH_ROUTE_LANE_INVENTORY`; this section explains the policy boundary behind that source-of-truth table.

| Lane                      | Current use                                                                                  | Boundary                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser-session`         | Human browser/UI entry after PIN login and existing operator browser routes.                 | Protects the web UI from unauthenticated browser clients. Dev-instance flags do not satisfy this lane. It is not a fleet credential, node credential, or proof that another same-OS-user process is trusted.                                                                                                                                       |
| `scoped-actor-credential` | Delegated credentials for agents, local CLIs, and automation systems.                        | Issued by the scoped actor credential registry with explicit audience, expiry, capability bits, revocation handle, and node/session/work-context scope. It is not a browser login, node credential, or human impersonation token. Browser-session compatibility remains for local/dev callers until CLI gateway commands migrate in a later slice. |
| `node-credential`         | Node heartbeat and `/hub/node-link` reverse WebSocket.                                       | Issued through pairing, stored on the node, revocable by the hub, and never satisfied by a browser PIN/cookie or pair token.                                                                                                                                                                                                                       |
| `pair-token`              | One-time node bootstrap exchange at `POST /hub/pairing/exchange`.                            | Short-lived bootstrap material only. It mints a node credential; it does not authenticate browser, CLI, or steady-state node routes.                                                                                                                                                                                                               |
| `public-local-only`       | Setup, login, health, and similar routes that intentionally sit outside authenticated lanes. | Must not expose private session, repo, node, or credential state.                                                                                                                                                                                                                                                                                  |
| `denied`                  | Typed auth-lane failure bodies.                                                              | Failure payloads name accepted lanes and migration targets without returning secrets.                                                                                                                                                                                                                                                              |

The PIN and `token` cookie are therefore browser/UI authentication. They reduce drive-by browser access and support first-load local setup, but they cannot protect Relay from malicious processes already running as the same OS user: those processes can usually read local config, invoke local CLIs, attach to local sockets, or modify the checkout. Relay's federated security model relies on lane separation, node credentials, hub ACLs, capability policy, audit, revocation, and scoped actor credentials for non-browser actors rather than treating the browser PIN as global authorization.

Relay issue `#427` shipped the earlier trust-tier/capability/audit/confirmation backbone. Relay issue `#797` tracks the broader multi-node auth model. Relay issue `#798` wave 1 narrowed that work to route-lane inventory, browser-session terminology, and typed lane denials. Relay issue `#802` adds the scoped actor credential registry MVP; it deliberately does not migrate every CLI gateway command, implement node proof-of-possession, passkeys, TOTP, or new approval UX. Relay issue `#803` hardens node identity lifecycle semantics by separating stable node identity from replaceable credential records. Relay issue `#807` adds the high-risk approval hook contract for exact-operation challenges; it is still not MFA, passkeys/WebAuthn, TOTP, enterprise RBAC, or a broad approval-center UX. Relay issue `#813` adds the one-time operator handshake grant registry/audit foundation: a browser session may authorize the ceremony, but the `relay-ohg-v1` grant handle is a separate one-use lane and never becomes a reusable automation credential.

### Operator handshake grants

One-time operator handshake grants live in `shared/operator-handshake-grants.ts` and are documented in `docs/OPERATOR_HANDSHAKE_GRANTS.md`. They bridge browser-session ceremony authorization to a bounded, one-use `relay-ohg-v1.<grant-id>.<secret>` grant handle for a named actor, audience, capability set, scope, optional device binding, and optional session/work-context binding.

The browser session can authorize the ceremony, but it is not the reusable automation credential. A handshake grant is rejected from browser, scoped actor credential, pair-token, and node-credential lanes; those materials are likewise rejected as lane-mixed when presented as handshake grants. Successful validation consumes the grant, and replay/reuse denies with a typed reason.

Validation fails closed on malformed grant handles, unknown or wrong audience, unapproved grants, expiry, revocation, replay, actor/device/session mismatch, missing or wrong node/session/global-session/work-context/repo/path/task scope, unknown requested capability, and insufficient capability. High-risk capability grants require existing #807 exact-operation approval evidence before approval; otherwise the ceremony denies instead of minting a handle.

Operator copy must name what is delegated, who receives it, the audience, expiry/TTL, scope, device/session binding, and revoke path. Safe audit metadata is limited to grant id/jti, actor summary, issuer hash/display name, audience, capability bits, scope/params hashes, and correlation id. Raw grant handles, browser cookies, scoped actor tokens, pair tokens, node credentials, bearer headers, and secret-looking strings must not appear in logs, diagnostics, snapshots, audit payloads, CLI JSON, or browser JSON.

## Node identity lifecycle

Node identity is not the same thing as a node credential. The hub registry keeps a stable `nodeId` and identity summary for the node record, while credential records hold replaceable bearer material for heartbeat and `/hub/node-link`. Pairing creates both; reconnect proves the current credential; rotation replaces the credential while preserving the node identity; revocation keeps the identity as revoked and permanently rejects its credential; re-pairing after missing, malformed, mismatched, expired, revoked, or protocol-incompatible credentials creates a new node identity instead of reviving the old one.

### Key-bound node identity and proof-of-possession (#981)

Relay issue `#981` upgrades "reconnect proves the current credential" from bearer presentation to cryptographic proof-of-possession. On pairing a node creates or reuses a local ed25519 key pair and sends only the public key to the hub; the private key never leaves the node (`shared/node-identity-keys.ts`, stored 0600 at `~/.config/relay-ide/node-identity-key.json`). The hub binds the public-key fingerprint (`nkey_…`, derived from the canonical SPKI DER) plus algorithm to the issued credential record, alongside the existing trust tier, capability policy (ACL), expiry/rotation policy, workspace/repo scope, and audit metadata.

For a key-bound credential, the bearer token only _locates_ the credential; `/hub/node-link` (WebSocket upgrade) and the HTTP heartbeat additionally require a fresh, audience-bound, replay-protected proof in the `X-Relay-Node-Proof` header. The proof is a compact `header.payload.signature` assertion (DPoP-shaped) binding `nodeId`, `credentialId`, audience (`relay:node-link:v1` / `relay:node-heartbeat:v1`), an `iat` inside a ±5-minute freshness window, and a single-use `jti` enforced by an in-process replay cache. Verification fails closed with typed errors: bearer-only on a key-bound credential is `NODE_PROOF_REQUIRED`; a wrong key, stale, replayed, audience-mismatched, or credential-mismatched proof is `NODE_PROOF_INVALID` (with a precise `reasonCode`); revoked and expired credentials still fail as `NODE_REVOKED` / `NODE_CREDENTIAL_EXPIRED` before any proof work. Rotation preserves the stable node identity and carries the key binding forward (or rebinds to an explicit new key) while replacing the credential secret; revocation closes active links and rejects the old credential and proof. Legacy bearer-only credentials (paired with no public key) keep working on the bearer path — the new requirement applies only to key-bound credentials, which keeps the boundary additive rather than breaking already-paired nodes. The DPoP-shaped connect-time proof is the foundation; a server-issued-nonce challenge is a compatible future hardening behind the same contract.

This slice is the security foundation for the clean node pairing UX epic (#979); the hub pending-request API (#982), node device-code CLI (#983), and Settings → Nodes UI (#984) build on it.

The lifecycle states exposed to operators are:

| State             | Security meaning                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `active`          | The node has a valid active credential for heartbeat and `/hub/node-link`.                                                                                                                                                                                   |
| `rotating`        | A next credential exists and is provable, but the old credential remains active until heartbeat proof.                                                                                                                                                       |
| `rotation-failed` | Delivery failed or was marked failed; the previous credential remains active until an operator clears the rotation or retries safely.                                                                                                                        |
| `revoked`         | The node identity remains in registry history, active links are closed, and the credential is rejected without grace.                                                                                                                                        |
| re-pair required  | Authentication returns typed recovery errors such as `NODE_CREDENTIAL_MISSING`, `NODE_CREDENTIAL_MALFORMED`, `NODE_CREDENTIAL_MISMATCH`, `NODE_CREDENTIAL_EXPIRED`, `NODE_REVOKED`, or `REPAIR_REQUIRED`; the operator must run a fresh pair-token exchange. |

Browser auth is intentionally non-dependent. Browser PIN/cookie auth can authorize operator UI/API routes that mint pair tokens or request rotation/revocation, but it is not accepted by node heartbeat or `/hub/node-link`. Node credentials are likewise not browser, CLI, scoped actor, or human impersonation credentials.

SSH and Tailscale are bootstrap/reachability/binding signals only. They can help deliver install/pair commands, prove that an operator can reach a host, or provide host-binding evidence in diagnostics, but they are not the steady-state Relay application authorization model. Steady-state node authorization comes from the node credential, hub ACL/policy, audit, and revocation.

Node lifecycle audit and diagnostics must stay redacted. It is safe to emit `nodeId`, `credentialId`, `rotationId`, lifecycle state, recovery reason code, source diagnostic state, `observedAt`, stable `sourceFingerprint`, stable public-key fingerprint (`nkey_…`), lossy `displayHint`, and hashed/redacted scope metadata. It is not safe to emit raw pair tokens, raw node credential tokens, token hashes, node private keys or any PEM key block, raw proof signatures, browser cookies, confirmation tokens, scoped actor bearer material, raw forwarded headers, reverse-link private payloads, full env values, file bytes, terminal byte streams, full path inventories, raw tailnet IPs, full MagicDNS names, full hostnames, or arbitrary unredacted DNS/host strings. `redactNodeIdentityMaterial` (`shared/node-identity-keys.ts`) scrubs PEM key blocks and `secret_…` fragments while preserving public `nkey_…` fingerprints.

## Node source diagnostics

Relay records Tailscale/MagicDNS source diagnostics for node credential authentication. The feature is diagnostic by default: pairing, heartbeat, and `/hub/node-link` credential checks record whether the observed source matches the credential's expected source, but they do not deny an otherwise valid credential unless strict mode is explicitly enabled. Missing, malformed, expired, revoked, or mismatched credentials still fail normally; source diagnostics only annotate those failures.

Public and audit surfaces expose only this redacted shape:

| Field               | Meaning                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`             | Diagnostic state: `signal-unavailable`, `source-match`, `source-mismatch`, `same-credential-multiple-sources`, or `strict-deny`.                                  |
| `policy`            | `audit` by default, or `strict-deny` when the hub was started with strict source enforcement.                                                                     |
| `reasonCode`        | Typed reason such as `NODE_SOURCE_MATCH`, `NODE_SOURCE_MISMATCH`, `NODE_SOURCE_MULTIPLE_SOURCES`, `NODE_SOURCE_SIGNAL_UNAVAILABLE`, or `NODE_SOURCE_STRICT_DENY`. |
| `observedAt`        | Time the credential source was evaluated.                                                                                                                         |
| `sourceFingerprint` | Stable `src_<32 hex chars>` correlation handle for the normalized source. Omitted when no usable source exists.                                                   |
| `displayHint`       | Lossy operator hint such as `tailscale-ip:100.x.x.x`, `magicdns:ts.net:<suffix>`, `hostname:<suffix>`, or `no tailscale/magicdns signal`.                         |

State meanings:

| State                              | Security meaning                                                                                                                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal-unavailable`               | No usable socket/Tailscale source signal was available. Caller-provided source headers are not trusted as authoritative source evidence. Default policy allows and audits this; strict mode denies it when the credential already has a Tailscale/MagicDNS source binding. |
| `source-match`                     | The observed source matches the credential binding.                                                                                                                                                                                                                        |
| `source-mismatch`                  | A usable observed source does not match the credential binding. If the credential otherwise validates, default policy allows and audits it so operators can see topology drift or suspicious reuse.                                                                        |
| `same-credential-multiple-sources` | The same credential has appeared from multiple redacted source fingerprints. If the credential otherwise validates, default policy allows it but operators should treat it as suspicious copied/replayed credential evidence unless a topology change explains it.         |
| `strict-deny`                      | `RELAY_NODE_SOURCE_STRICT_DENY=1` is enabled and a reachable source mismatch or missing trusted source evidence for a source-bound credential was denied.                                                                                                                  |

Strict mode is an opt-in node-credential control:

```bash
RELAY_NODE_SOURCE_STRICT_DENY=1 relay-ide hub
```

It applies to node heartbeat and `/hub/node-link` credential authentication only. It does not implement Tailnet-only authorization, browser route approval, CLI actor-token migration, ACL redesign, or lifecycle semantics beyond the source check described here.

## Scoped actor credentials

Scoped actor credentials are delegated bounded capabilities for non-browser actors: `agent`, `cli`, and `automation-system`. They are separate from browser PIN/cookie sessions, node credentials, and one-time pair tokens. Human/operator identity can appear as issuer metadata, but a scoped actor credential must not be described or treated as "login as Donovan" bearer impersonation.

The MVP registry lives in `shared/scoped-actor-credentials.ts` and is intentionally a lifecycle primitive rather than full CLI gateway migration. It issues opaque `relay-sac-v1.<credential-id>.<secret>` bearer material, stores only a secret hash, and exposes public credential records without token material or `secretHash`. Registry callers must provide a bounded expiry (`expiresAt` or `ttlMs`), audience, actor, issuer, capability bits, and at least one explicit scope dimension.

Validation is fail-closed. Callers supply the expected audience, required `RelayCapabilityBit` values, and the operation scope. Validation rejects malformed credentials, unsupported actor types, unknown audiences, wrong audiences, expired credentials, revoked credential ids/jtis, missing required scope, wrong node/session/global-session/work-context scope, unknown requested capability bits, and insufficient capability grants. Unknown capability strings are never promoted to grants; requested operation bits must map to the closed enum in `shared/security-policy.ts`.

Revocation is in-process and immediate for future validations by credential id/jti. Expiry is required and checked on every validation. The MVP does not claim same-OS-user process isolation, proof-of-possession, MFA, enterprise RBAC, or public-hosting guarantees.

Audit helpers record issue, validate allow/deny, revoke, and expiry outcomes with reason codes, actor/issuer/audience metadata, credential id, required/granted/denied bits, correlation id, and hashed/redacted scope/params. Token-looking material is redacted before hashing or emission; raw bearer tokens, secrets, and secret hashes must not appear in logs, issues, diagnostics, registry snapshots, CLI output, browser JSON, or test snapshots.

### CLI gateway actor credential lane

The #805/#943 CLI gateway slices use scoped actor credentials for a narrow allowlisted lane, not as a general login token. Credentials minted for `audience: "relay:cli-gateway:v1"` may be passed only as explicit actor credentials (`--actor-token` or `RELAY_IDE_ACTOR_TOKEN`) to stable read command ids such as `nodes.list`, `sessions.list`, `sessions.get`, `work-contexts.get`, WorkContext artifact reads, and handoff artifact reads, plus the closed write allowlist for context packet writes (`context:write`), inbox writes (`inbox:write`), and artifact/handoff writes (`artifact:write`). The lane applies credential scope checks for requested session/global-session/work-context/repo/task ids when those scopes are present. Artifact id routes derive WorkContext/repo/task from stored artifact metadata before mutation or payload/public-summary access, so a credential scoped to one target cannot enumerate, read, or write another.

The lifecycle endpoints are hub operator APIs under `/cli-gateway/actor-credentials`: `POST` mints one token plus a public credential record, `GET` lists public records, and `DELETE /cli-gateway/actor-credentials/:id` revokes by credential id. Rotation is intentionally mint-new-then-revoke-old; this slice does not ship a separate rotate endpoint. The operator auth used to call these endpoints authorizes delegation, but the issued actor token is not a browser PIN/cookie, is not "login as Donovan," and does not pair or impersonate a Relay node.

Lane separation is fail-closed:

| Presented credential                          | Accepted here                                                                                                                                              | Rejected from                                                                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser PIN/session cookie                    | Browser UI, operator lifecycle endpoints such as actor credential mint/list/revoke, and legacy CLI gateway compatibility paths that have not migrated yet. | Scoped actor-token lane, node heartbeat, and `/hub/node-link`.                                                                                                                     |
| Node credential                               | Node heartbeat and `/hub/node-link`.                                                                                                                       | Browser UI/operator auth and the CLI actor-token lane.                                                                                                                             |
| Scoped actor token for `relay:cli-gateway:v1` | Only the CLI gateway read ids and the #943 write ids for context/inbox/artifact/handoff writes when capability and target scope match.                     | Browser auth paths, node auth paths, File RPC, supervisor/session-control/input/settings/webhook/repo-wide mutation, mismatched target scopes, and commands outside the allowlist. |

Typed CLI actor denials use stable reason codes such as `CLI_ACTOR_CREDENTIAL_MISSING`, `CLI_ACTOR_BROWSER_COOKIE_REJECTED`, `CLI_ACTOR_NODE_CREDENTIAL_REJECTED`, `CLI_ACTOR_ROUTE_UNSUPPORTED`, `CLI_ACTOR_MALFORMED_CREDENTIAL`, `CLI_ACTOR_WRONG_AUDIENCE`, `CLI_ACTOR_EXPIRED`, `CLI_ACTOR_REVOKED`, `CLI_ACTOR_MISSING_SCOPE`, `CLI_ACTOR_WRONG_SESSION_SCOPE`, `CLI_ACTOR_WRONG_GLOBAL_SESSION_SCOPE`, `CLI_ACTOR_WRONG_WORK_CONTEXT_SCOPE`, `CLI_ACTOR_UNKNOWN_CAPABILITY`, and `CLI_ACTOR_INSUFFICIENT_CAPABILITY`. Failure payloads may include safe credential ids, denied bits, the expected audience, and correlation ids, but never raw bearer strings, browser cookies, node credential material, or secret hashes.

### Standing runtime leases for bound agents (#1410)

Every bound channel agent runtime that Relay spawns as a child process carries a standing scoped actor credential, minted per `(channel, profile)` runtime by `server/orchestrator-credential-lifecycle.ts`. Ordinary bound agents get `session:read` + `context:read` only, pinned to their own `channelIds` and nothing else; the persistent channel orchestrator keeps its separate read/write lease. There is no `context:write` on the read lease — a bound agent answers through the channel bridge, never by posting with its own credential — and no `session:create:terminal`, which would turn a read handle into process execution. The lease is TTL-bounded by the registry clamp (15 minutes), rotates only when the adapter can re-receive environment (`refreshRuntimeEnv`), and is revoked when the runtime ends.

Delivery is environment injection into the spawned agent process (`RELAY_IDE_ACTOR_TOKEN`, `RELAY_IDE_PORT`, `RELAY_IDE_RUNTIME_ID`) and nothing else. A credential must never reach an agent through channel-visible text, prompt content, argv, or a provider config file. Gateway-launch providers with no child process therefore get no credential.

The stdio MCP facade mounted into such a runtime is a view of that same credential, never a second grant: it authenticates purely from inherited environment, and the mount spec carries a path and arguments only. Two accepted residual risks follow from that delivery mechanism and are recorded in `docs/MCP_HARNESS_RELAY_BRIDGE.md` § "Accepted residual risks": provider environment inheritance is indiscriminate, so every other MCP server that agent mounts also inherits the lease token; and self-hosted development resolves the facade from the checkout's own `dist/`, which agents can edit. Both are bounded by the same-OS-user trust domain this policy already declines to claim isolation within.

Relay issue `#177` remains the first-load/PIN explanation ticket. These docs clarify the security boundary, but closing `#177` should wait until the visible browser first-load copy also explains where the PIN comes from and how to reset it.

## Trust tiers

Trust tiers describe blast radius. They are not marketing labels and they do not imply safety by themselves.

| Tier      | Blast radius                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox` | Experimental or constrained node. Route only narrow read/session-safe operations unless an operator grants more.                                                                                 |
| `dev`     | Default legacy/private-infra node. Read/session-safe operations are allowed by default; destructive file/git/exec/preview surfaces stay off unless granted.                                      |
| `prod`    | Production or sensitive node. A prod overlay may make an otherwise-allowed high-risk bit require confirmation, but it must never turn an off bit or confirmation-required bit into silent allow. |

## Capability bits

Capability bits are a closed, protocol-versioned enum in `shared/security-policy.ts` (`RELAY_SECURITY_POLICY_VERSION = 1.0`). Unknown strings fail closed: they are dropped during ACL normalization and resolve to `deny` when evaluated.

Default legacy grants are intentionally boring:

- allowed: `session:read`, `session:create:terminal`, `session:attach`,
  `rpc:fs:list`, `rpc:fs:read`, `rpc:fs:tail`, `rpc:git:read`
- off unless explicitly granted: `session:control:kill`, `rpc:fs:write`, `rpc:fs:delete`, `rpc:git:write`, `pty:exec:arbitrary`, `preview:port-forward`

`session:control:kill` is intentionally separate from `session:attach`: attaching or streaming a session is not authority to terminate it. Pause/retry controls are not routed in this slice; when added, they need explicit high-risk control bits instead of reusing attach.

`rpc:fs:write` is now shipped (#428). The node executor writes via atomic rename (write-to-temp + `fs.rename`). Prod-tier nodes gate writes behind the exact-operation confirmation challenge — the hub returns `CONFIRMATION_REQUIRED` on the first POST; the caller must obtain an approved `confirmationToken` and re-POST the same operation with it. The CLI enforces a 1 MiB cap on base64-decoded content before the HTTP call.

## Exact-operation high-risk approval hook

The #807 MVP makes approval a one-time authorization for one canonical operation. It is not a blanket trust upgrade, not a new capability grant, and not permission for the actor to perform similar future work. A successful approval is redeemed once; a retry after denial, expiry, mismatch, or reuse starts from a fresh challenge.

The current high-risk classifier requires approval for these implemented families when they appear in the routed policy decision: cross-node session/node control, capability escalation (`node:acl:widen` / grant-style actions), shell or arbitrary PTY exec, file write/delete or boundary-crossing mutation, credential/secret export, node revoke/rotate/re-pair/destroy, destructive session control, and any otherwise-routed capability listed in `HIGH_RISK_CAPABILITIES`. Low-risk read and ref-only context/inbox operations stay silent-allow when policy allows them; unknown operations or unknown capability strings deny instead of prompting.

Challenge binding includes the requester auth-session hash, actor type/id hash, scoped credential id/jti hash when present, node id, session id, work-context id, intent/action/target, required and challenged capability bits, ACL/policy refs, trust tier, scope hash, canonical params hash, TTL, approval target, and a stable `contractHash`. The approval target defaults to a human approval. When a target id or session is present, the approver must match it; scoped/autonomous requesters also require a structured approver identity so they cannot self-approve through the same actor, credential, or session.

Safe metadata for operator lists, prompts, diagnostics, and issue handoffs is limited to challenge id/status, action, node/session/work-context ids, required/challenge bits, risk reason, created/expires/token-expires times, failed-redemption counts, reason code, message, `canonicalParamsHash`, `paramsHash`, `scopeHash`, `contractHash`, redacted identity hashes, and display names. Review prompts may show canonical params such as command/cwd, path/mode, expected hash, byte count, and content SHA-256 so a human can tell what they are approving; do not persist or paste raw params if they contain secret-looking values.

Failure modes are fail-closed:

| Case                                                                                                                  | Behavior                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Human denies                                                                                                          | Challenge becomes `denied`/`revoked`; no token is usable.                                                 |
| Challenge or token expires                                                                                            | Challenge becomes `expired`; the requester must repeat the operation to create a fresh challenge.         |
| Requester, node, intent, capability set, session, scope, or canonical params drift                                    | Redemption fails with context/parameter mismatch; repeated parameter mismatches invalidate the challenge. |
| Token is reused                                                                                                       | Redemption fails with `reuse_denied`; approvals are one-time only.                                        |
| Same browser/auth session, same autonomous actor, same scoped credential, or same requester session attempts approval | Approval is rejected as self-approval.                                                                    |
| Approval target does not match                                                                                        | Approval is rejected with `approval_target_invalid`.                                                      |
| Approval audit write fails                                                                                            | The approval token is invalidated; destructive/high-risk flows do not continue without audit.             |

The implemented approval transport is the existing authenticated hub confirmation surface: `GET /hub/confirmations`, `GET /hub/confirmations/:challengeId`, `POST /hub/confirmations/:challengeId/approve`, and requester-only `POST /hub/confirmations/:challengeId/requester-token`. The MVP may use the existing hub/browser confirmation components and mocked flows. Passkey/WebAuthn/TOTP, stronger human auth, multi-approver policy, and broad approval-center workflows are future auth-strength/UX work behind this same contract.

The approval hook is a contract and in-process enforcement path for routed high-risk decisions. It does not by itself add every future high-risk command surface; new routed commands still need explicit policy mapping, audit coverage, and contract tests before adapters expose them.

## Hash-chained security audit sink

Security audit entries are normalized in `shared/security-audit.ts` and persisted by `server/security-audit-log.ts` into `security-audit.db` under the Relay config directory unless a caller supplies a specific DB path. Each entry includes event id, timestamp, monotonic sequence, schema version, event type, decision, reason code, peer/node identity, trust tier, session id, intent, scope/params hashes, required/granted/denied bits, ACL/policy refs, correlation id, `prevHash`, and `entryHash`.

Event types cover grants, denials, challenges, approvals, expiry, revocation, rotation, failed redemption, same-session approval attempts, and #470 bridge events. Raw bearer tokens, pair tokens, confirmation tokens, full env values, file bytes, and terminal byte streams must be passed through the audit redaction helpers before hashing; the persisted entry stores hashes for scope/params rather than raw payload bytes. Confirmation audit entries carry the same exact-operation context as the challenge, including required/granted/denied bits and correlation id, without storing the redemption token.

Persistence uses a SQLite append-only table with an atomic insert transaction, update/delete rejection triggers, and a singleton tail checkpoint updated on every append. Verify with:

```bash
relay-ide audit verify --db ~/.config/relay-ide/security-audit.db
relay-ide audit verify --db ~/.config/relay-ide/security-audit.db --json
```

The verifier replays rows in sequence order and recomputes `prevHash` / `entryHash`, using SQLite row iteration so verification memory stays bounded by the largest row rather than total log size. It reports the exact first break location for gaps, row tamper, insert/reorder attacks, tail truncation relative to the stored checkpoint, and corrupt/partial storage. Hash chaining plus the DB-local checkpoint detects accidental corruption and post-hoc edits against the current DB file, but it is not remote attestation: a compromised hub/root account can still rewrite the whole history, recompute hashes, and rewrite the checkpoint unless future slices add external shipping or trusted timestamping. External SIEM, third-party timestamping, full PTY transcript recording, durable/distributed confirmation registries, and stronger approval auth are intentionally outside this slice.

Audit storage is intentionally unbounded in this slice: Relay does not yet enforce retention, rotation, or a maximum `security-audit.db` size. Operators must provision and monitor the config-directory storage accordingly; manual pruning or rotation will break the contiguous sequence/hash chain unless a future retention design preserves verifier semantics.

Audit write failure policy is fail-closed for prod trust tier or destructive/high-risk capability scope. Low-tier read-only degradation is allowed only as an explicit visible degraded state; silent audit bypasses are not acceptable.

## Scheduled credential rotation

Scheduled rotation is opt-in hygiene that reuses the rotation state machine and audit pipeline; it is not a policy enforcement source. When `credentialRotation.intervalMs` is set on the hub config to a positive value, an in-process scheduler scans paired nodes on each tick (default 60s, configurable via `credentialRotation.checkIntervalMs`) and triggers online rotation for every paired, non-revoked, currently-stable node whose active credential has been in use longer than `intervalMs`.

Offline nodes are skipped without throwing and audited with `CREDENTIAL_ROTATION_SCHEDULED_SKIPPED` (`reason: NODE_OFFLINE`). Nodes already mid-rotation are filtered before audit so the scheduler does not collide with operator-initiated rotations. Delivery failures call `failCredentialRotation`, keeping the previous credential active, and audit `CREDENTIAL_ROTATION_SCHEDULED_FAILED`. Successful triggers/deliveries audit `CREDENTIAL_ROTATION_SCHEDULED_TRIGGERED` and `CREDENTIAL_ROTATION_SCHEDULED_DELIVERED`. ACL/policy changes still apply immediately and do not wait for credentials to rotate.

A default cadence is intentionally not shipped; operators opt in by setting `credentialRotation.intervalMs` themselves. The scheduler is process-local: it stops on hub shutdown and does not persist tick state.

## Agent-profile gateway secrets

An agent profile may hold one write-only gateway credential: `hermesApiKey`, the `API_SERVER_KEY` for the Hermes multiplex profile that profile is bound to (#1453). It is a provider gateway credential, not a Relay auth lane — it is never a browser session, scoped actor credential, node credential, or pair token, and it authenticates Relay outbound to a local gateway rather than authenticating anyone to Relay.

Redaction is structural, not procedural. The value lives in its own `agent_profiles.hermes_api_key` column, outside the `profile_json` blob, and every profile read statement selects `hermes_api_key IS NOT NULL` rather than the value. An `AgentProfile` can therefore carry only `hermesApiKeySet: boolean`, and a read path added later cannot return the secret by omission. The single value read path is `AgentProfileStore.getGatewaySecret`, whose only caller forwards it into adapter `extra` for a bound runtime. It must not appear in logs, diagnostics, snapshots, audit payloads, CLI JSON, browser JSON, or error messages; rejections name the field, never the value.

The stored value is restricted to printable, space-free US-ASCII (max 4096 characters), so it cannot carry CR/LF into the `Authorization` header it becomes. The store DB is chmod'ed `0600` before WAL is enabled, best effort. There is no at-rest encryption: the hub has no key management, and `pinHash`, the GitHub access token, and the VAPID private key already live in a config-dir `config.json`.

Related open gap: agent-profile `envVars` are still persisted and returned raw (#1464).

## Operator visibility

The hub UI surfaces each paired node's trust tier, ACL allow/challenge/deny capability posture, scope, capability availability, and high-risk summary from the node summary returned by `/hub/nodes`. Confirmation prompts also show the selected node, trust tier, policy ref, required bits grouped by allow/challenge/deny/unknown posture, and keep canonical params behind a details disclosure instead of making raw JSON the only security context.

Audit visibility is intentionally minimal in this slice: the UI advertises the safe CLI verification path (`relay-ide audit verify --db ~/.config/relay-ide/security-audit.db`) rather than inventing a broad audit browser. There is no web audit dashboard, SIEM export, retention policy, or remote attestation claim yet.

## Hub ACL authority

Hub ACL state is stored with the node registry record. Each ACL can express:

- peer identity: node id, credential id, display name
- node tier: `sandbox | dev | prod`
- allowed bits and confirmation-required bits
- scope: node/workspace/repo/path scope metadata
- version/ref: schema version, policy version, ACL ref
- lifecycle metadata: created/updated, revocation, supersession

On upgrade, legacy paired-node records with no ACL are migrated to a default `dev` ACL before `/nodes` summaries or authenticated credential paths return the node. The migration is persisted back to the hub registry file.

Node manifests remain separate. If a node reports `git` as available, that does not grant `rpc:git:write`; if it reports `git` as unavailable, the hub ACL still records whether the policy would allow read/git operations once the capability exists. The policy evaluator must combine both facts later: capability available AND ACL grant.
