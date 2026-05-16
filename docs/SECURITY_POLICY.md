# Relay Security Policy Schema

Relay separates node capability discovery from hub-granted policy. A node manifest says what a node appears able to do right now; the hub ACL says what the hub is willing to route to that node. Manifest data is availability/probe evidence, never a grant.

## Trust tiers

Trust tiers describe blast radius. They are not marketing labels and they do not imply safety by themselves.

| Tier | Blast radius |
| ---- | ------------ |
| `sandbox` | Experimental or constrained node. Route only narrow read/session-safe operations unless an operator grants more. |
| `dev` | Default legacy/private-infra node. Read/session-safe operations are allowed by default; destructive file/git/exec/preview surfaces stay off unless granted. |
| `prod` | Production or sensitive node. A prod overlay may make an otherwise-allowed high-risk bit require confirmation, but it must never turn an off bit or confirmation-required bit into silent allow. |

## Capability bits

Capability bits are a closed, protocol-versioned enum in `shared/security-policy.ts` (`RELAY_SECURITY_POLICY_VERSION = 1.0`). Unknown strings fail closed: they are dropped during ACL normalization and resolve to `deny` when evaluated.

Default legacy grants are intentionally boring:

- allowed: `session:read`, `session:create:terminal`, `session:create:agent`, `session:attach`, `rpc:fs:list`, `rpc:fs:read`, `rpc:fs:tail`, `rpc:git:read`
- off unless explicitly granted: `rpc:fs:write`, `rpc:fs:delete`, `rpc:git:write`, `pty:exec:arbitrary`, `preview:port-forward`

The schema exists before the full policy evaluator. Current routed surfaces still have their existing route-level checks; this slice adds the policy authority data model and legacy defaults so later gates have a safe source of truth.

## Hash-chained security audit sink

Security audit entries are normalized in `shared/security-audit.ts` and persisted by `server/security-audit-log.ts` into `security-audit.db` under the Relay config directory unless a caller supplies a specific DB path. Each entry includes event id, timestamp, monotonic sequence, schema version, event type, decision, reason code, peer/node identity, trust tier, session id, intent, scope/params hashes, required/granted/denied bits, ACL/policy refs, correlation id, `prevHash`, and `entryHash`.

Event types cover grants, denials, challenges, approvals, expiry, revocation, rotation, failed redemption, same-session approval attempts, and #470 bridge events. Raw bearer tokens, pair tokens, confirmation tokens, full env values, file bytes, and terminal byte streams must be passed through the audit redaction helpers before hashing; the persisted entry stores hashes for scope/params rather than raw payload bytes.

Persistence uses a SQLite append-only table with an atomic insert transaction and update/delete rejection triggers. Verify with:

```bash
relay-ide audit verify --db ~/.config/relay-ide/security-audit.db
relay-ide audit verify --db ~/.config/relay-ide/security-audit.db --json
```

The verifier replays rows in sequence order and recomputes `prevHash` / `entryHash`. It reports the exact first break location for gaps, row tamper, insert/reorder attacks, and corrupt/partial storage. Hash chaining detects accidental corruption and post-hoc edits against the current DB file, but it is not remote attestation: a compromised hub/root account can still rewrite the whole history and recompute hashes unless future slices add external shipping or trusted timestamping. External SIEM, third-party timestamping, full PTY transcript recording, credential rotation, confirmation registries, and evaluator gates are intentionally outside this slice.

Audit write failure policy is fail-closed for prod trust tier or destructive/high-risk capability scope. Low-tier read-only degradation is allowed only as an explicit visible degraded state; silent audit bypasses are not acceptable.

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
