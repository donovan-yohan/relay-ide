# Spike: Cross-node copy contract

> **Status:** Spike — design doc, no implementation
> **Date:** 2026-05-20
> **Issue:** [#679](https://github.com/donovan-yohan/relay-ide/issues/679)
> **Parent epic:** [#616](https://github.com/donovan-yohan/relay-ide/issues/616)
> **Refs:** [#683](https://github.com/donovan-yohan/relay-ide/issues/683)
> **ADRs:** [ADR-016](../adrs/ADR-016-node-to-node-isolation.md)

---

## tl;dr

- Defer broad bidirectional sync. Relay does not yet have a single-writer
  story, merge-conflict UX, or partial-failure recovery model for mirrored
  folders.
- Safe v1 subset: one explicit regular-file copy from `(sourceNodeId,
sourcePath)` to `(destNodeId, destPath)`, with `mode: 'create' |
'overwrite'`, no append, no directory recursion, a bounded per-file cap,
  hash/snapshot-based source preconditions, and hash-based overwrite
  preconditions.
- Authorize it as two grants: `rpc:fs:read` on the source node and
  `rpc:fs:write` on the destination node. Do not add a new cross-node bit for
  v1.
- Audit it as one composite `copy` intent whose manifest records both the
  source read and destination write, while the actual node protocol still stays
  two independent hub-issued operations per ADR-016.

---

## 1. Why broad sync is deferred

True sync looks simple until it has to be safe. Relay has deliberately kept
node-local filesystems node-local: paths are scoped to a `Node`, worktrees are
`WorktreeInstance`s on one machine, and ADR-016 says cross-node features must be
hub-mediated compositions rather than node-to-node protocol shortcuts.

Bidirectional folder sync is deferred because the core ownership questions are
unanswered:

| Problem                  | Why it blocks broad sync now                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single writer            | Relay cannot yet say which node owns canonical content when two nodes edit the same path. Without that, sync silently creates split-brain worktrees.                         |
| Conflict UX              | There is no product surface for previewing, choosing, or merging conflicts across nodes. "Last writer wins" is unacceptable for code, config, and agent-generated artifacts. |
| Partial failure recovery | Mirroring a tree can fail after some files land, after metadata changes, or after one node goes offline. Relay has no resumable transaction log for that.                    |
| Secret/cache boundaries  | A broad folder walk will eventually hit `.env`, provider auth, git metadata, caches, transcripts, or ignored build outputs unless every root has an explicit policy.         |
| Path identity            | `/Users/donovan/project` and `/srv/relay/project` are not the same identity. Exact path mirroring makes machine-specific assumptions look global.                            |

The remaining hard problems are worth solving in a dedicated handoff/snapshot
model, not hidden inside a copy helper. Until Relay can present an explicit
plan, single-writer/conflict policy, excludes, byte count, and recovery state,
large sync should stay out of scope.

ADR-016 is the architectural guardrail: future file copy between nodes is two
independent hub-issued operations — read from node A, write to node B — not a
node A request that can drive node B directly. That keeps compromised-node blast
radius bounded and leaves the hub as the only place that composes policy.

---

## 2. One-shot copy contract

The safe subset is a single bounded file copy with explicit conflict behavior.
It is a product-level operation composed by the hub; it does not require a new
node envelope that names two nodes.

### Operation shape

```ts
type CrossNodeCopyMode = 'create' | 'overwrite';

interface CrossNodeCopyRequest {
  source: FileResourceRef & { intent: 'read' };
  dest: {
    nodeId: string;
    path: string;
    mode: CrossNodeCopyMode;
    /** Required for overwrite; absent for create. */
    expectedHash?: string;
  };
  /** Hard operation cap. Recommended v1 default: 1 MiB unless policy raises it. */
  maxBytes: number;
  /** Optional WorkContext/task/session correlation, not authorization. */
  workContextId?: string;
  correlationId?: string;
}
```

`FileResourceRef` already carries the source `nodeId`, absolute node-scoped
`path`, `capturedAt`, optional size/hash/mtime hints, optional repo/worktree
binding, and optional `maxBytes`. Those hints are not authority, but they are
preconditions when present: the hub must re-validate them through File RPC before
acting and return a first-class stale-source/source-changed conflict if the live
source no longer matches the ref that was minted.

### Semantics

1. Validate both node ids are paired and online enough for live RPC.
2. Validate both paths are absolute node-scoped paths accepted by the existing
   File RPC path rules. Do not infer path mapping or mirror roots here.
3. Evaluate source `rpc:fs:read` and destination `rpc:fs:write` grants before
   starting either leg.
4. `lstat` the source without following symlinks. It must be a regular file,
   `size <= maxBytes`, and match any expected source snapshot metadata carried
   by the request/ref.
5. Read the source file into a bounded hub-side buffer while computing SHA-256.
   Before attempting any destination write, compare the computed hash to any
   expected source `sha256`/snapshot hash from the ref or handoff plan.
6. `lstat` the destination path/parent without following symlinks:
   - `mode: 'create'`: destination must not exist.
   - `mode: 'overwrite'`: destination must exist as a regular file and its
     current SHA-256 must equal `expectedHash`.
7. Write the destination with the existing atomic file-write behavior
   (temp file + rename). The destination path is not observable until the full
   bytes and hash verify.
8. Emit one composite audit envelope with the manifest, byte count, hashes, and
   final outcome.

### Source snapshot preconditions

Dry-run/handoff planning must capture the expected source artifact identity for
every file it plans to apply: node id, path hash, size, mtime/captured-at hints
when available, and a SHA-256 content hash or explicit snapshot id. Apply is not
allowed to silently copy "whatever is there now." It must validate the live
source against the captured source metadata/hash/snapshot identity before the
destination write. If the source changed, disappeared, became too large, or
changed kind, the operation returns a typed conflict such as
`COPY_SOURCE_CHANGED`/`COPY_SOURCE_STALE` and leaves the destination untouched.

### Conflict behavior

| Condition                                                     | Result                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `create` and destination exists                               | `COPY_DEST_EXISTS`; no read/write beyond cheap stat is required. |
| `overwrite` and `expectedHash` missing                        | `COPY_EXPECTED_HASH_REQUIRED`; no write.                         |
| `overwrite` and destination hash differs                      | `COPY_DEST_CHANGED`; no write.                                   |
| Source hash/snapshot metadata differs from the captured ref   | `COPY_SOURCE_CHANGED`/`COPY_SOURCE_STALE`; no destination write. |
| Source exceeds `maxBytes`                                     | `COPY_SOURCE_TOO_LARGE`; no destination write.                   |
| Source or destination is a directory/symlink/unsupported kind | `COPY_UNSUPPORTED_KIND`; no traversal or symlink following.      |

There is intentionally no `append`. Append makes partial writes observable,
complicates retry, and is not needed for the handoff substrate. If a later log
collection feature needs append-like behavior, it should design that as a
separate artifact/log protocol.

---

## 3. Capability shape

Cross-node copy needs two independent grants for one user intent:

| Leg               | Required bit   | Scope                                           |
| ----------------- | -------------- | ----------------------------------------------- |
| Source read       | `rpc:fs:read`  | source node + source path/read scope            |
| Destination write | `rpc:fs:write` | destination node + destination path/write scope |

The hub composes the policy decision. Node manifests only say whether the node
can perform file operations; `CapabilityGrant`s say whether the requester may
perform them. A grant on node A never authorizes node B.

### New bit vs AND of existing bits

| Option                                   | Pros                                                                                                             | Cons                                                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add `rpc:fs:copy-across-nodes`           | Easy to search for the feature; one policy knob can disable the whole product action.                            | Duplicates source/destination path scope, risks becoming a super-permission, and weakens the ADR-016 mental model by making copy look like a primitive node operation. |
| Require `rpc:fs:read` AND `rpc:fs:write` | Reuses existing least-privilege grants, keeps per-node scope explicit, and matches the actual two-leg execution. | Policy UI must explain that one click consumes two grants. Operators may want a convenience preset later.                                                              |

Recommendation: use the AND of existing bits for v1. If operators later need a
feature-level kill switch, add hub policy that disables the composite action
without minting a new node capability bit.

Prod-tier confirmation follows existing policy: if the destination
`rpc:fs:write` grant requires confirmation, the copy request waits for an
approved confirmation token bound to the destination path and destination bytes
hash. The source read grant may also require confirmation if a future policy
marks specific read scopes sensitive.

---

## 4. Audit envelope shape

Do not write two unrelated audit rows and hope a reviewer reconstructs intent.
The user action is one copy, so the audit trail should contain one composite
`copy` envelope. Internally it still records the two legs and their independent
policy decisions.

Recommended shape:

```json
{
  "eventType": "RPC_FS_COPY_ACROSS_NODES",
  "decision": "allow",
  "reasonCode": "COPY_COMPLETED",
  "peer": { "kind": "local-user", "displayName": "..." },
  "intent": {
    "kind": "rpc:fs:copy",
    "mode": "overwrite",
    "workContextId": "wc_...",
    "sourceNodeId": "macbook",
    "sourcePathHash": "sha256:...",
    "sourceSnapshotId": "snapshot_...",
    "expectedSourceHash": "sha256:source...",
    "destNodeId": "hub",
    "destPathHash": "sha256:...",
    "expectedHash": "sha256:old...",
    "newHash": "sha256:new...",
    "bytesWritten": 48192,
    "maxBytes": 1048576
  },
  "requiredBits": ["rpc:fs:read", "rpc:fs:write"],
  "legOutcomes": {
    "sourceRead": { "nodeId": "macbook", "decision": "allow" },
    "destWrite": { "nodeId": "hub", "decision": "allow" }
  },
  "correlationId": "copy_..."
}
```

The stored audit row should follow `docs/SECURITY_POLICY.md`: compact ids,
reason codes, hashes, byte counts, policy refs, `prevHash`, and `entryHash`.
Keep `peer` as the flat requester identity used by `HubPolicyPeerIdentity`/
`SecurityAuditPeer`; put source/destination node ids and path hashes in the
copy intent or material block so existing audit consumers do not have to parse a
new nested peer shape. Align field names with existing File RPC primitives:
`expectedHash`, `newHash`, and `bytesWritten`. Do not persist raw file bytes,
raw env, provider auth, or unbounded payloads in the audit database. Display
surfaces can resolve hashes/refs through normal artifact or file-preview
permissions when appropriate.

Why not two rows? A two-row source-read + dest-write chain mirrors the low-level
implementation, but it makes atomic intent invisible. If the destination write
fails, a reviewer needs to know the preceding read was for a copy attempt, not a
standalone file inspection. A composite row preserves the atomic user intent and
can still include per-leg decisions for forensic clarity.

---

## 5. Failure modes and recovery

The v1 recovery rule is boring on purpose: retry the same request only when the
same preconditions still hold. No partial destination file should become
observable.

| Failure                                                | Behavior                                                                                                                                                | Recovery                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Source grant denied                                    | Return `COPY_SOURCE_DENIED`; no destination grant/write attempted unless policy UI needs a dry-run explanation.                                         | Ask for/adjust source read grant, then retry.                                                   |
| Destination grant denied                               | Return `COPY_DEST_DENIED`; no source read unless a dry-run explicitly requested both decisions.                                                         | Ask for/adjust destination write grant, then retry.                                             |
| Source read fails after destination grant              | Return `COPY_SOURCE_READ_FAILED`; no destination write attempted.                                                                                       | Retry after source node/path is healthy; same destination precondition still applies.           |
| Destination write fails after source read              | Return `COPY_DEST_WRITE_FAILED`; discard buffered bytes server-side. Atomic write temp file is unlinked or ignored; destination path remains unchanged. | Retry with the same `expectedHash`; if destination changed, retry fails as `COPY_DEST_CHANGED`. |
| Network drop during source read                        | Return `COPY_SOURCE_READ_FAILED` or `COPY_CANCELLED` depending on caller cancellation.                                                                  | Retry from start. No resume in v1.                                                              |
| Network drop during destination write                  | Return `COPY_DEST_WRITE_FAILED`/`COPY_CANCELLED`; atomic temp file never renames.                                                                       | Retry with the same `expectedHash`; safe because nothing partial landed.                        |
| Hub crash after source read before dest write          | No copy completion audit row; destination unchanged.                                                                                                    | Retry from start. The source may be re-read and re-hashed.                                      |
| Hub crash after destination rename before audit append | Treat as high-risk audit failure per security policy. Prod/destructive flows fail closed.                                                               | Recovery requires audit verification and operator-visible reconciliation.                       |

The hub should prefer ordering that avoids unnecessary reads: destination
existence/hash checks can happen before source read when cheap, especially for
`create` where an existing destination should stop the operation immediately.
The contract above is not a mandate to waste bandwidth; it is the authorization
and outcome invariant.

---

## 6. V1 non-goals

| Non-goal                      | Rationale                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Streaming copy                | Bounded hub buffering is simpler to reason about and lets v1 guarantee no partial destination file. Streaming can be revisited after resumable/audited transfer state exists.            |
| Resume                        | Resume needs chunk manifests, byte-range verification, temp-file lifecycle, and retry windows. Overkill for a per-file bounded copy.                                                     |
| Directory traversal/recursion | Tree copy reintroduces sync problems: excludes, conflicts, symlinks, partial application, and secret/cache discovery.                                                                    |
| Symlinks                      | Cross-node symlink meaning is host-specific and can escape allowed roots. V1 rejects symlink traversal and symlink-as-source/destination unless a future explicit policy says otherwise. |
| Metadata preservation         | Mode, owner, group, xattrs, ACLs, and mtime have different semantics across macOS/Linux/WSL. Preserve content bytes only.                                                                |
| Append                        | Append makes partial writes visible and unsafe to retry.                                                                                                                                 |
| Delete/rename/move            | These are destructive filesystem operations with separate UX/audit needs.                                                                                                                |
| Broad folder sync/rsync       | `rsync` may be a future engine, but the product contract must be a scoped handoff/copy plan with grants, conflicts, excludes, hashes, and audit.                                         |
| Secret sync                   | No syncing `.env`, SSH keys, token stores, provider auth, credentials, Hermes profile DBs, or auth/session caches. Secrets need an explicit vault/policy flow, not file copy.            |
| Process migration             | Relay copies bytes and launches/attaches sessions; it does not move a running tmux/Claude/Codex/Hermes process image between machines.                                                   |

---

## 7. Wave prior art and Relay divergences

Wave is the immediate prior art for the user value. #616 pins
`wavetermdev/waveterm@021db67ee7af1771d0b4b9bf09c098fa7747e5cd`. In
`pkg/wshrpc/wshremote/wshremote_file.go` lines 73-100, Wave's
`remoteCopyFileInternal` documents and enforces the useful constraints:

- file-only copy, not directories;
- source size must not exceed `RemoteFileTransferSizeLimit`;
- destination preparation happens before open/write and is governed by an
  explicit overwrite flag;
- the implementation opens a source file and creates/truncates a destination
  file only after those checks pass.

Relay should steal those constraints, not the exact architecture.

Relay divergences:

| Dimension         | Wave-style model                                                | Relay model                                                                                                   |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Authorization     | A local/remote helper permission model around `wsh file`.       | Hub policy composes `CapabilityGrant`s for source `rpc:fs:read` and destination `rpc:fs:write`.               |
| Audit             | Operational command behavior.                                   | Hash-chained audit envelope with requester, source, destination, bytes, hashes, reason code, and policy refs. |
| Node isolation    | Copy can be expressed through Wave's local/remote helper model. | ADR-016 forbids node-to-node addressing; hub issues independent per-node operations.                          |
| Identity          | Local/remote path aliases such as `wsh://local/~/`.             | Node-scoped absolute paths plus optional `FileResourceRef` repo/worktree binding; paths are never global ids. |
| Handoff substrate | File copy is a utility.                                         | File copy is one primitive inside WorkContext-aware handoff, artifacts, previews, and agent attachments.      |

---

## 8. Relationship to #683 cold handoff to hub

Issue `#683` is the laptop-closing use case: move local WIP to a hub-hosted environment
so work can continue after the laptop sleeps. This spike informs the transfer
substrate by defining the smallest safe cross-node mutation: explicit source,
explicit destination, bounded bytes, conflict precondition, two grants, and a
composite audit envelope.

That is not process migration. A running laptop-side tmux/Claude/Codex/Hermes
process remains on the laptop. The #683 v1 should be a cold handoff: snapshot
repo/cwd/WIP state, transfer/apply the selected files or patch artifacts to the
hub, start a new hub-side session with the same `WorkContext` and bounded
handoff summary, and mark the source session as handed-off/stale/left-running
according to what actually happened.

For git-backed handoff, this one-shot copy contract is most useful for approved
untracked files, artifacts, and non-git payloads; tracked dirty state should
usually move as a patch against a known base commit. For non-git cwd handoff,
this contract becomes the atomic per-file building block under a higher-level
`HandoffPlan` that handles excludes, byte totals, destination namespace, and
operator confirmation.
