# Relay Security Policy Schema

Relay separates node capability discovery from hub-granted policy. A node manifest says what a node appears able to do right now; the hub ACL says what the hub is willing to route to that node. Manifest data is availability/probe evidence, never a grant.

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

- allowed: `session:read`, `session:create:terminal`, `session:create:agent`, `session:attach`, `rpc:fs:list`, `rpc:fs:read`, `rpc:fs:tail`, `rpc:git:read`
- off unless explicitly granted: `session:control:kill`, `rpc:fs:write`, `rpc:fs:delete`, `rpc:git:write`, `pty:exec:arbitrary`, `preview:port-forward`

`session:control:kill` is intentionally separate from `session:attach`: attaching or streaming a session is not authority to terminate it. Pause/retry controls are not routed in this slice; when added, they need explicit high-risk control bits instead of reusing attach.

The schema exists before the full policy evaluator. Current routed surfaces still have their existing route-level checks; this slice adds the policy authority data model and legacy defaults so later gates have a safe source of truth.

## Hash-chained security audit sink

Security audit entries are normalized in `shared/security-audit.ts` and persisted by `server/security-audit-log.ts` into `security-audit.db` under the Relay config directory unless a caller supplies a specific DB path. Each entry includes event id, timestamp, monotonic sequence, schema version, event type, decision, reason code, peer/node identity, trust tier, session id, intent, scope/params hashes, required/granted/denied bits, ACL/policy refs, correlation id, `prevHash`, and `entryHash`.

Event types cover grants, denials, challenges, approvals, expiry, revocation, rotation, failed redemption, same-session approval attempts, and #470 bridge events. Raw bearer tokens, pair tokens, confirmation tokens, full env values, file bytes, and terminal byte streams must be passed through the audit redaction helpers before hashing; the persisted entry stores hashes for scope/params rather than raw payload bytes.

Persistence uses a SQLite append-only table with an atomic insert transaction, update/delete rejection triggers, and a singleton tail checkpoint updated on every append. Verify with:

```bash
relay-ide audit verify --db ~/.config/relay-ide/security-audit.db
relay-ide audit verify --db ~/.config/relay-ide/security-audit.db --json
```

The verifier replays rows in sequence order and recomputes `prevHash` / `entryHash`, using SQLite row iteration so verification memory stays bounded by the largest row rather than total log size. It reports the exact first break location for gaps, row tamper, insert/reorder attacks, tail truncation relative to the stored checkpoint, and corrupt/partial storage. Hash chaining plus the DB-local checkpoint detects accidental corruption and post-hoc edits against the current DB file, but it is not remote attestation: a compromised hub/root account can still rewrite the whole history, recompute hashes, and rewrite the checkpoint unless future slices add external shipping or trusted timestamping. External SIEM, third-party timestamping, full PTY transcript recording, credential rotation, confirmation registries, and evaluator gates are intentionally outside this slice.

Audit storage is intentionally unbounded in this slice: Relay does not yet enforce retention, rotation, or a maximum `security-audit.db` size. Operators must provision and monitor the config-directory storage accordingly; manual pruning or rotation will break the contiguous sequence/hash chain unless a future retention design preserves verifier semantics.

Audit write failure policy is fail-closed for prod trust tier or destructive/high-risk capability scope. Low-tier read-only degradation is allowed only as an explicit visible degraded state; silent audit bypasses are not acceptable.

## Scheduled credential rotation

Scheduled rotation is opt-in hygiene that reuses the rotation state machine and audit pipeline; it is not a policy enforcement source. When `credentialRotation.intervalMs` is set on the hub config to a positive value, an in-process scheduler scans paired nodes on each tick (default 60s, configurable via `credentialRotation.checkIntervalMs`) and triggers online rotation for every paired, non-revoked, currently-stable node whose active credential has been in use longer than `intervalMs`.

Offline nodes are skipped without throwing and audited with `CREDENTIAL_ROTATION_SCHEDULED_SKIPPED` (`reason: NODE_OFFLINE`). Nodes already mid-rotation are filtered before audit so the scheduler does not collide with operator-initiated rotations. Delivery failures call `failCredentialRotation`, keeping the previous credential active, and audit `CREDENTIAL_ROTATION_SCHEDULED_FAILED`. Successful triggers/deliveries audit `CREDENTIAL_ROTATION_SCHEDULED_TRIGGERED` and `CREDENTIAL_ROTATION_SCHEDULED_DELIVERED`. ACL/policy changes still apply immediately and do not wait for credentials to rotate.

A default cadence is intentionally not shipped; operators opt in by setting `credentialRotation.intervalMs` themselves. The scheduler is process-local: it stops on hub shutdown and does not persist tick state.

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
