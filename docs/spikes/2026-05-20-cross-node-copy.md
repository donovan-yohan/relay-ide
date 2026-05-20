# Spike: cross-node copy contract (#616 slice 5)

Status: spike — not accepted. If conclusions hold, a follow-on ADR captures the v1 contract.

Date: 2026-05-20.

Parent: epic [#616 — Remote file/resource preview and agent attachments](https://github.com/donovan-yohan/relay-ide/issues/616).

Predecessor slices (shipped): slice 1 `FileResourceRef` (#671/#672), slice 2 `FileBlock` renderer (#673/#674), slice 3 `PromptAttachment` shape (#675/#676), slice 4 FileBlock edit mode + `fs.write` (#677/#678).

---

## Why bidirectional sync is deferred

The Wave product (the source we borrowed user value from in #616) exposes copy + sync between a local host and an SSH-paired remote via `wsh file`. The remote-mirroring story works there because Wave runs a single user identity end-to-end and the user owns both endpoints. Relay does not have that assumption: a hub may broker between a Mac node and a Linux devbox owned by the same human, but it may equally broker between a paired peer's node and the human's node. The single-writer story is unsettled in that second case.

True bidirectional sync (rsync-style continuous mirroring, conflict resolution, dotfile shadow trees) sits on top of three unresolved questions:

1. **Single-writer authority.** Which node owns the canonical content for a given path? Today the answer is "whoever wrote last to disk on that node", which is fine for local files and breaks for shared identity across nodes. A federated mirror would need either a designated authoritative side per path or a CRDT-style merge story. Both are large designs.
2. **Conflict UX.** When source and destination diverge between two syncs, the user must decide which side wins. Relay has no merge-conflict UI today and no policy for agent-driven conflict resolution. Building one is its own epic.
3. **Partial-failure recovery.** A mid-sync network drop or node disconnect leaves the destination in a known-inconsistent state. Continuous sync requires either a journal (write-ahead log on the hub) or full content rescans on reconnect. Both are expensive and neither is scoped for #616.

ADR-016 (node-to-node isolation) is the principle that keeps these problems contained: nodes don't talk to each other directly; the hub mediates and audits. Bidirectional sync would push against that principle by demanding cross-node state reconciliation. Until we have a story for that, we defer.

**Verdict:** bidirectional sync is out of scope for #616 and likely out of scope for the next two quarters. The safe subset below is the only cross-node mutation we will offer in v1.

---

## One-shot copy contract (the safe subset)

A single user-initiated or agent-initiated operation that:

1. Reads one file from a source node (`rpc:fs:read` on `(sourceNodeId, sourcePath)`).
2. Writes the bytes to a destination node (`rpc:fs:write` on `(destNodeId, destPath)`).
3. Surfaces a typed success or typed failure. No partial state on destination on failure.

### Request shape (draft, not yet implemented)

```ts
interface FileRpcCopyAcrossNodesRequest {
  operation: 'copy-across-nodes';
  source: { nodeId: NodeId; path: string };
  dest: { nodeId: NodeId; path: string };
  mode: 'create' | 'overwrite'; // no 'append' in v1
  // optimistic concurrency: hash of dest content if mode === 'overwrite'.
  // If unset and mode === 'overwrite', server rejects.
  expectedDestHash?: string;
  // size cap; server enforces a hard ceiling regardless.
  maxBytes: number;
  // client-supplied idempotency token; only honored for mode: 'create'
  // (see open question 1 below). Bounded TTL on hub-side cache.
  idempotencyKey?: string;
}
```

### Response shape

```ts
interface FileRpcCopyAcrossNodesResponse {
  operation: 'copy-across-nodes';
  source: { nodeId: NodeId; path: string; sourceHash: string };
  dest: {
    nodeId: NodeId;
    path: string;
    bytesWritten: number;
    newHash: string;
    newMtime: string;
    created: boolean;
  };
}
```

### Error envelopes

- `COPY_SOURCE_READ_FAILED` — source read failed; no write was attempted.
- `COPY_DEST_WRITE_FAILED` — source read succeeded but destination write failed; no partial bytes on dest (server discards the buffer).
- `COPY_DEST_HASH_MISMATCH` — `expectedDestHash` did not match; dest unchanged.
- `COPY_SOURCE_TOO_LARGE` — source size exceeds `maxBytes`.
- `FORBIDDEN` — either source or dest capability denied (server does not leak which).

### What v1 does not stream

The copy is a buffered read-then-write at the hub. The hub holds the bytes for the duration of the operation (bounded by `maxBytes`). No chunked transport, no resume token. If the file is larger than `maxBytes`, the operation fails — no partial copy.

---

## Capability shape

The operation requires two grants:

- `rpc:fs:read` on the source side, scoped to `sourceNodeId`.
- `rpc:fs:write` on the destination side, scoped to `destNodeId`.

**Open question:** should `copy-across-nodes` be a new capability bit (e.g., `rpc:fs:copy`)?

**Recommendation:** no. Use AND of the existing two bits.

Rationale:

- Adding a new bit doesn't grant access the user couldn't already compose by holding both bits. It only changes _how_ access is requested.
- A single composite bit makes audit logs harder to read — reviewers want to see which side the grant attached to.
- A single bit makes consent UI weirder — the user must understand it implies both read on one node and write on another.
- AND-of-existing keeps the grant graph identity-shaped: capability bits track operations on a single node; cross-node operations compose them at the hub.

The cost of recommending AND: hub policy evaluator must learn to compose grants from two distinct policy scopes. This is a small lift; the alternative (new bit) is also a lift.

The decision should be revisited if cross-node copy ever gains a confirmation challenge (#427's `requires_confirmation` mode) — the challenge might want a single addressable bit. For v1 of a one-shot copy with mandatory `expectedDestHash`, the challenge isn't needed.

---

## Audit envelope shape

**Recommendation:** single composite audit row with both source and dest peer/material.

```ts
{
  eventType: 'grant' | 'denial',
  decision: 'allow' | 'deny',
  intent: { action: 'rpc.fs.copy-across-nodes.completed' },
  peer: { source: PeerRef, dest: PeerRef },
  requiredBits: ['rpc:fs:read', 'rpc:fs:write'],
  grantedBits: [...],
  deniedBits: [...],
  scope: { source: PolicyScope, dest: PolicyScope },
  params: { sourcePath, destPath, mode, bytesWritten, sourceHash, newHash },
  prevHash: ...,
  entryHash: ...,
}
```

Rationale:

- The audit chain reflects atomic intent. If a reviewer wants to know "who copied file X from node A to node B at time T?", a single row answers it. Two rows (source read + dest write) would require a chain-join.
- The existing `rpc.fs.read` and `rpc.fs.write.completed` audit entries already capture each leg individually if a reviewer wants to drill in; the cross-node row sits on top.
- The two-row alternative duplicates the prevHash chain and forces the reviewer to mentally pair them. A single envelope is easier to verify integrity on.

The cost: a new envelope variant. The hub's audit emitter learns one more action key. No new chain semantics.

---

## Failure modes and recovery

| Stage                      | What can fail                                                                      | Server behavior                                                                                                                                                                 | Client-visible code                                                 |
| -------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Policy decision            | Source or dest grant missing                                                       | Deny before any read attempted; emit `denial` audit row.                                                                                                                        | `FORBIDDEN`                                                         |
| Source read                | Network drop, file not found, source node offline                                  | No bytes leave the source side; no write attempted; emit `denial` audit row with `COPY_SOURCE_READ_FAILED` reason.                                                              | `COPY_SOURCE_READ_FAILED` (or `NODE_OFFLINE`, `FILE_RPC_NOT_FOUND`) |
| Hash check                 | `expectedDestHash` mismatch                                                        | Source bytes are discarded by the hub; dest unchanged; emit `denial` audit row.                                                                                                 | `COPY_DEST_HASH_MISMATCH`                                           |
| Dest write                 | Network drop after read, dest node offline, write-permission denied                | Source bytes discarded; dest unchanged; emit `denial` audit row with `COPY_DEST_WRITE_FAILED`.                                                                                  | `COPY_DEST_WRITE_FAILED`                                            |
| Client → Hub request drop  | Request never reached the hub                                                      | Nothing happens on either node; no audit row.                                                                                                                                   | Client sees transport-level error; safe to retry.                   |
| Source → Hub transfer drop | Source read started but bytes did not fully arrive at the hub                      | Hub aborts the read; no write attempted; emit `denial` audit row.                                                                                                               | `COPY_SOURCE_READ_FAILED` (or `NODE_OFFLINE`)                       |
| Hub → Dest transfer drop   | Source read completed; dest write started but did not commit                       | Source bytes discarded; dest unchanged; emit `denial` audit row.                                                                                                                | `COPY_DEST_WRITE_FAILED`                                            |
| Hub → Client response drop | Operation committed on dest; success row in audit chain; client never saw response | The audit chain is the source of truth: dest hash matches `newHash`. Client retry semantics are mode-dependent — see the idempotency note below for `mode: 'create'` ambiguity. | Client transport error; retry behavior differs by mode              |

The hub does not surface "we got partway through" to the client. The contract is: either the destination has the expected bytes and the hash matches, or it doesn't.

### Retry semantics by mode

- **`mode: 'overwrite'`.** The retry is naturally idempotent. The client sends the same `expectedDestHash`. If the prior write committed, `expectedDestHash` no longer matches the new content → server returns `COPY_DEST_HASH_MISMATCH` and the client knows the prior write landed. If the prior write did not commit, the retry succeeds. No ambiguity.
- **`mode: 'create'`.** The retry is **not** naturally idempotent. If the prior write committed, the dest file now exists and the retry fails with `FILE_RPC_WRITE_PERMISSION_DENIED` or a `FILE_EXISTS`-shaped error — and the client cannot distinguish "my prior request landed" from "another writer raced me to that path". See the idempotency-key open question below for the v1 disposition of this case.

---

## Non-goals for v1

| Non-goal                                    | Rationale                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Streaming / chunked transport               | Adds resume-token state, buffer churn, and partial-failure modes. v1 is bounded `maxBytes`.                                                                                                        |
| Resume after disconnect                     | Implies durable state on the hub between requests. v1 is request/response only.                                                                                                                    |
| Directory traversal (`cp -r`)               | Adds path-globbing, per-entry policy, and a per-entry audit row explosion. v1 is per-file only.                                                                                                    |
| Symlinks                                    | Adds symlink-loop and escape-from-root analysis on both sides. v1 fails closed on `lstat().isSymbolicLink()`.                                                                                      |
| Metadata preservation (mode/mtime/xattr)    | Adds platform-specific paths and conflicts with `expectedDestHash` semantics. v1 writes the bytes; the dest file's mode follows the dest node's umask.                                             |
| Source-side capture of `expectedSourceHash` | We don't need TOCTOU on the source side; the source read is the canonical fetch and any drift between hub-side stat and hub-side read would already surface in the source side `fs.read` envelope. |
| Background / async dispatch                 | v1 is synchronous, request-scoped. Long copies block. If a user needs async, they can split the work or wait.                                                                                      |

---

## Adjacent prior art (Wave)

Wave's cross-host file copy is the model that inspired this slice (per the #616 epic body). The pinned Wave commit is `wavetermdev/waveterm@021db67ee7af1771d0b4b9bf09c098fa7747e5cd`.

Two constraints Wave already enforces that map directly to our v1 contract:

- **File-only behavior + transfer size caps.** See `pkg/wshrpc/wshremote/wshremote_file.go` lines 73-100. Wave rejects directory copies and enforces an explicit max size before forwarding. We adopt both behaviors verbatim.
- **Explicit overwrite required.** Wave fails if the destination exists and the user didn't pass an overwrite flag. We do the same via `mode: 'create' | 'overwrite'` plus the mandatory `expectedDestHash` on overwrite.

Where Relay diverges:

- Wave's model assumes the user owns both ends (SSH-paired remote). Relay's hub mediates between potentially different identities; we layer capability + audit at the hub rather than relying on filesystem permission bits on a single host.
- Wave's `wsh file` is a CLI affordance. Relay's cross-node copy will land first as a programmatic RPC; CLI surface (via the cli-gateway, #429) is a follow-on.
- Wave does not encode optimistic concurrency on the destination. Relay does, via `expectedDestHash`, because federated edits introduce a real risk of two writers racing — the slice-4 edit flow already enforces this for single-node writes; cross-node copy must too.

---

## Open questions (resolve before implementation)

1. **Idempotency key.** Should the request carry a client-supplied idempotency token so retries after network drops are unambiguous?

   The case **for** adding one is the `mode: 'create'` retry ambiguity above: after a Hub → Client response drop, the client cannot tell whether its create landed or whether another writer beat it to the path. An idempotency key (client-supplied UUID; hub remembers the (key → result) mapping for some bounded window, e.g. 5 minutes) lets the hub return the cached success response on retry and skip the racy second write.

   The case **against** is added state: the hub now keeps a short-lived idempotency cache and must invalidate it on dest changes from non-copy paths (e.g. a direct `fs.write` to the same path while the cache is live).

   **Recommendation:** add `idempotencyKey?: string` to the request shape **for `mode: 'create'`** only; ignore the field for `mode: 'overwrite'` (where `expectedDestHash` already provides idempotency). Bounded TTL on the cache (5 min), keyed on `(destNodeId, destPath, idempotencyKey)`. This was a gap in the original spike — flagged by review feedback before implementation.

2. **Audit row cardinality if dest is the same as source node.** Should "copy within the same node" be allowed? It maps to a local `fs.read` → `fs.write` and doesn't need the cross-node envelope. Reject at the hub: same `nodeId` on both sides returns `INVALID_ARGUMENT` and forces the caller to use `fs.write` directly.
3. **Provider-side enforcement.** The destination node still enforces its own filesystem permission bits at write time. If the hub said "yes" but the OS user can't write the path, we surface `FILE_RPC_WRITE_PERMISSION_DENIED` (same code as slice 4's existing path). This is consistent and needs no new error class.

---

## Acceptance for the spike

This doc is not an ADR. It's the artifact slice 5 ships. If the conclusions hold up under team review, the next step is:

1. Promote the contract decisions (single envelope, AND-of-bits, no streaming) to a formal ADR.
2. Open implementation tickets for the request/response shapes, hub route, and tests.
3. Re-scope per-feedback before any code lands.

Slice 5 ends here.
