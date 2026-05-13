# Spike: File RPC streaming semantics over `/hub/node-link`

> **Status:** Spike — design doc, no implementation
> **Date:** 2026-05-12
> **Issue:** [#424](https://github.com/donovan-yohan/relay-ide/issues/424)
> **Blocks:** [#428](https://github.com/donovan-yohan/relay-ide/issues/428) (File RPC epic)
> **Refs:** [#416](https://github.com/donovan-yohan/relay-ide/issues/416),
> [#418](https://github.com/donovan-yohan/relay-ide/issues/418),
> [#427](https://github.com/donovan-yohan/relay-ide/issues/427)
> **ADRs:** [ADR-015](../adrs/ADR-015-core-primitives-domain-agnostic.md),
> [ADR-016](../adrs/ADR-016-node-to-node-isolation.md)

---

## tl;dr

- **Channel:** new `file` channel sibling to `pty`. Same envelope shape, distinct
  state machine, distinct verb namespace. The existing `rpc` channel stays
  request/response for short manifest probes.
- **Framing:** `streamId`-keyed, same pattern as `pty`. A verb-specific open
  envelope (`type: fs.read | fs.list | fs.write | fs.tail`) → ordered
  `fs.chunk` payloads → terminal `fs.done` or `fs.error`. Default chunk 64 KiB,
  hard cap 256 KiB.
- **Backpressure:** application-level credit window. Consumer issues `fs.ack`
  with byte credits, node refuses to send the next chunk past the window.
  Default initial window 1 MiB, replenished every 256 KiB.
- **Path scoping:** all paths resolved against a node-side allowlist of paired
  roots before any FS call, with symlink escape rejected post-`realpath`.
- **Capabilities:** `rpc:fs-read`, `rpc:fs-write`, `rpc:fs-tail` enforced
  hub-side and node-side. Write to a `prod`-tier node always requires a
  confirmation token from #427.

---

## 1. Scope and non-goals

### In scope

| Verb       | Purpose                                         |
| ---------- | ----------------------------------------------- |
| `fs.read`  | Streamed read of a single file, optional range  |
| `fs.list`  | Directory listing, paginated via opaque cursor  |
| `fs.stat`  | Single-shot metadata (size, mtime, type, link)  |
| `fs.write` | Streamed write with create/truncate/append mode |
| `fs.tail`  | Long-lived follow-from-offset stream            |

### Non-goals (handled elsewhere)

- Diff / merge — repo feature layer (per ADR-015).
- File watcher beyond `fs.tail` semantics. No directory `inotify` fan-out, no
  recursive subtree watch.
- Multi-node parallel ops. Per ADR-016 a CLI gateway composes per-node calls;
  the file RPC layer never names a peer node.
- Chmod / chown / symlink creation / rename. Out of MVP scope; can be added
  later as `fs.chmod`, `fs.rename` if needed without breaking framing.
- Binary diff transfer (rsync-style). The chunk stream is naive byte stream;
  the hub or feature layer can compress at a higher level.

---

## 2. Channel decision

Two options were considered.

### Option A — reuse `rpc` channel with `fs.*` method names

The current `rpc` channel (`shared/relay-node-protocol.ts`, dispatched by
`HubNodeLinkManager.request`) is a strict request/response pair keyed by
`requestId` with a 10 s timeout (`DEFAULT_RPC_TIMEOUT_MS` in
`server/hub-node-link.ts`). It is designed for short manifest probes.

To make this carry streamed file reads we would need to:

- Introduce a `streamId` mode that disables the `requestId` timeout for that
  call.
- Teach `HubNodeLinkManager.request` to fan multiple inbound envelopes back to
  the original caller rather than resolve once and clear.
- Add stream framing (chunks + terminator) on a channel whose existing
  contract is single-frame return.

Pros: one fewer channel. Existing consumers don't learn a new word.
Cons: the `rpc` channel's invariant — "one request, one response, bounded
latency" — is exactly what makes it useful for manifest probes and capability
introspection. Overloading it with long-lived streams complicates timeouts,
cancellation, and audit log shape.

### Option B (chosen) — new `file` channel

Add `file` to `RelayNodeChannel` alongside `pty`. Mirror the `pty` host pattern:
node-side `node-link-file-host.ts` sibling to `node-link-pty-host.ts`, hub-side
state-machine methods on `HubNodeLinkManager` sibling to `attachPty` /
`handlePtyEnvelope`.

Pros:

- Clear separation of concerns. `rpc` stays a sync probe channel, `file` owns
  long-lived streams, `pty` keeps its terminal semantics. Each state machine is
  small and readable.
- Verb namespace (verb-specific opens — `fs.read`, `fs.list`, `fs.write`,
  `fs.tail` — plus the shared frames `fs.chunk`, `fs.ack`, `fs.done`,
  `fs.error`, `fs.cancel`) lives in one place and is easy to grep / audit.
- Per-stream lifecycle (open → chunks → done / error / cancel) maps cleanly to
  WebSocket frames without overloading `requestId`.
- Audit-log entries can key on channel name to apply the right schema (PTY
  attach vs file read vs RPC probe), simpler than reflecting a `kind` field.
- Future channels (`exec`, `port`) follow the same pattern.

Cons:

- One more channel for the protocol surface. The cost is a single-string
  extension of `RelayNodeChannel` plus one dispatch arm in
  `HubNodeLinkManager.handleEnvelope`.

**Decision: Option B.** Add `'file'` to `RelayNodeChannel`. Reuse
`RelayNodeEnvelope` exactly as-is (no envelope shape change). Verbs are
`fs.*`; framing details below.

### Channel boundaries

| Channel   | Lifetime   | Keyed by    | Use                                                 |
| --------- | ---------- | ----------- | --------------------------------------------------- |
| `control` | connection | —           | hello, heartbeat, revoke, errors with no request id |
| `rpc`     | per call   | `requestId` | short manifest / capability probes; one-shot        |
| `events`  | broadcast  | —           | unsolicited events from node                        |
| `pty`     | long       | `streamId`  | terminal sessions                                   |
| `file`    | long       | `streamId`  | file read/write/tail streams                        |
| `preview` | long       | `streamId`  | reserved (existing)                                 |

---

## 3. Verb shape per file op

All envelopes use the existing `RelayNodeEnvelope` shape from
`shared/relay-node-protocol.ts`. Every streaming verb is keyed by `streamId`
(allocated hub-side as a `crypto.randomUUID()` and reused for all envelopes in
the flow). Terminal envelopes for a `streamId` are `fs.done` or `fs.error`;
seeing either frees the hub-side state and prevents further frames.

For brevity, examples below show only the non-boilerplate envelope fields.
`protocol`, `protocolVersion`, `nodeId`, `timestamp` are always present.

### 3.1 `fs.stat(path)` — single response

Smallest verb. Lives on `rpc` channel because there is no stream — but the
verb name still uses the `fs.` prefix so capability-bit lookup is uniform.
Choosing `rpc` here keeps `fs.stat` cheap (no `streamId` allocation, no
backpressure window).

**Request (hub → node):**

```json
{
  "channel": "rpc",
  "type": "fs.stat",
  "requestId": "...",
  "payload": { "path": "/abs/path" }
}
```

**Response (node → hub):**

```json
{ "channel": "rpc", "type": "fs.stat", "requestId": "...",
  "payload": {
    "exists": true,
    "type": "file" | "dir" | "symlink" | "other",
    "size": 12345,
    "mtimeMs": 1715553600000,
    "mode": "0o644",
    "symlinkTarget": "/abs/target",
    "symlinkOutsideRoot": false
  } }
```

Missing path returns `exists: false` rather than `NOT_FOUND` — saves a round
trip when the consumer is probing existence. Hard errors (permission denied,
I/O error) use `error: { code: 'INTERNAL', ... }` on the envelope.

### 3.2 `fs.list(dir, opts)` — paginated, on `file` channel

Listings can be large enough that a single response would blow the WS frame
budget. Use the `file` channel with pagination, even though most directories
fit in one chunk.

**Open (hub → node):**

```json
{
  "channel": "file",
  "type": "fs.list",
  "streamId": "S1",
  "payload": {
    "path": "/abs/path",
    "recursive": false,
    "limit": 500,
    "cursor": null
  }
}
```

**Ack (node → hub) — initial credit window:**

```json
{
  "channel": "file",
  "type": "fs.ack",
  "streamId": "S1",
  "payload": { "windowBytes": 1048576 }
}
```

**Page (node → hub):**

```json
{
  "channel": "file",
  "type": "fs.chunk",
  "streamId": "S1",
  "payload": {
    "entries": [
      { "name": "foo", "type": "file", "size": 123, "mtimeMs": 1715553600000 },
      { "name": "bar", "type": "dir" }
    ],
    "cursor": "opaque-base64-or-null"
  }
}
```

**Terminal (node → hub):**

```json
{
  "channel": "file",
  "type": "fs.done",
  "streamId": "S1",
  "payload": { "totalEntries": 1024, "truncated": false }
}
```

`cursor` is opaque to the hub and the consumer. The node may encode an inode
position, a path suffix, or a base64-encoded `readdir` offset — the only
invariant is that re-issuing `fs.list` with the same cursor resumes the
listing. `recursive: true` is supported but performs a single bounded BFS
(default depth 8) and returns multiple entries per chunk frame in
deterministic sort order (by relative path) — same `entries[]` shape as
the non-recursive case, just packed across more frames. `limit` is
hub-side enforceable; the node caps it at 5000 per page regardless.

### 3.3 `fs.read(path, range?)` — chunked stream

Single-file read. Always streamed even for tiny files (so the verb shape is
uniform). For files under one chunk the stream is one `fs.chunk` + one
`fs.done`.

**Cutoff rule:** **all reads are streamed.** Even <64 KiB reads emit
`fs.chunk` + `fs.done`. This avoids two parsing paths on both sides.
Round-trip cost for a 1 KiB file is one open, one chunk, one done — three
frames vs the two of a single-shot response. Acceptable.

**Open (hub → node):**

```json
{
  "channel": "file",
  "type": "fs.read",
  "streamId": "S2",
  "payload": {
    "path": "/abs/path",
    "offset": 0,
    "length": null, // null = read to EOF
    "lastBytes": null, // mutually exclusive with offset+length
    "chunkSize": 65536
  }
}
```

**Ack (node → hub) — initial credit window:**

```json
{
  "channel": "file",
  "type": "fs.ack",
  "streamId": "S2",
  "payload": { "windowBytes": 1048576 }
}
```

**Chunks (node → hub):**

```json
{
  "channel": "file",
  "type": "fs.chunk",
  "streamId": "S2",
  "payload": {
    "seq": 0,
    "bytes": 65536,
    "data": "<base64>",
    "eof": false
  }
}
```

**Terminal:**

```json
{
  "channel": "file",
  "type": "fs.done",
  "streamId": "S2",
  "payload": { "totalBytes": 1048576, "sha256": "..." }
}
```

`sha256` is computed by the node as it reads and emitted on `fs.done` only
when the consumer asked for it (`payload.hash: 'sha256'` on open). Optional
because hashing a 1 GB file streamed is wasted CPU when the consumer just
wants display.

**Range semantics:**

- `offset + length` — byte range, half-open `[offset, offset+length)`. `length:
null` means "to EOF."
- `lastBytes: N` — read the last N bytes (used by file inspectors and by
  `fs.tail` initial backfill). Mutually exclusive with `offset+length`.
- Negative offsets rejected with `INVALID_REQUEST`.

### 3.4 `fs.write(path, mode, stream)` — open / chunks / close

Writes flow consumer → hub → node. Hub allocates the `streamId` and forwards
each frame.

**Open (hub → node):**

```json
{ "channel": "file", "type": "fs.write", "streamId": "S3",
  "payload": {
    "path": "/abs/path",
    "mode": "create" | "truncate" | "append",
    "expectedSize": 1048576,
    "hash": "sha256",
    "atomic": true
  } }
```

`expectedSize` is advisory; the node uses it to pre-allocate or to reject
oversize before the first chunk. `atomic: true` writes to
`<dir>/.relay-write-<streamId>.tmp` and `fs.rename` on `fs.write.close` —
the only write strategy for `create` and `truncate`. `append` never uses
atomic because the existing file content is intentionally preserved.

**Ack (node → hub) — initial write window:**

```json
{
  "channel": "file",
  "type": "fs.ack",
  "streamId": "S3",
  "payload": { "windowBytes": 1048576 }
}
```

**Chunk (hub → node), consumer-driven:**

```json
{
  "channel": "file",
  "type": "fs.chunk",
  "streamId": "S3",
  "payload": { "seq": 0, "bytes": 65536, "data": "<base64>" }
}
```

**Close (hub → node):**

```json
{
  "channel": "file",
  "type": "fs.write.close",
  "streamId": "S3",
  "payload": { "totalBytes": 1048576, "sha256": "..." }
}
```

**Terminal (node → hub):**

```json
{
  "channel": "file",
  "type": "fs.done",
  "streamId": "S3",
  "payload": { "totalBytes": 1048576, "sha256": "...", "renamed": true }
}
```

**Integrity:** if the consumer sends `hash: 'sha256'` on open and a
`sha256` on close, the node verifies its rolling hash on receipt and emits
`fs.error` with `code: 'INVALID_REQUEST'` on mismatch — the temp file is
unlinked, the rename never happens. If `atomic: true` and any chunk or close
errors, the temp file is unlinked and `fs.error` is emitted; the destination
path is untouched. **Partial writes are never observable** in `atomic` mode.

For `append` mode, partial writes are by definition observable. The node
records the offset of each chunk in the audit log so a partially-written
file can be inspected after a crash.

### 3.5 `fs.tail(path, fromOffset?)` — long-lived follow stream

`tail -F` semantics: stream existing bytes from `fromOffset`, then keep the
stream open and push new bytes as they arrive. Survives file rotation
(`fs.rename` → new inode with same name); the node re-opens and emits a
`fs.rotated` chunk.

**Open (hub → node):**

```json
{
  "channel": "file",
  "type": "fs.tail",
  "streamId": "S4",
  "payload": {
    "path": "/abs/path",
    "fromOffset": -1024, // -N = last N bytes; 0 = start; null = current EOF
    "follow": true,
    "chunkSize": 65536
  }
}
```

**Ack (node → hub) — initial credit window:**

```json
{
  "channel": "file",
  "type": "fs.ack",
  "streamId": "S4",
  "payload": { "windowBytes": 1048576 }
}
```

**Chunks (node → hub):** same shape as `fs.read` chunks.

**Rotation event (node → hub):**

```json
{
  "channel": "file",
  "type": "fs.rotated",
  "streamId": "S4",
  "payload": { "newInode": "0x123", "atByte": 0 }
}
```

**Cancel (hub → node):**

```json
{ "channel": "file", "type": "fs.cancel", "streamId": "S4" }
```

**Terminal (node → hub):**

```json
{ "channel": "file", "type": "fs.done", "streamId": "S4",
  "payload": { "totalBytes": 1048576, "reason": "cancelled" | "deleted" } }
```

`follow: false` makes `fs.tail` behave as a one-shot `fs.read` from the
specified offset and emits `fs.done` at EOF. The verb is kept distinct from
`fs.read` because the semantics — "start from a position relative to EOF" —
are different and the audit log entry differs.

---

## 4. Streaming framing

### Ordering

Within a single `streamId`, frames are strictly ordered (TCP under WebSocket
guarantees this). Per-stream `seq` is included in `fs.chunk` payloads as a
defensive marker so the receiving side can assert (and so the audit log can
record the high-water mark on disconnect).

Across distinct `streamId`s there is **no** ordering guarantee. The hub may
multiplex an `fs.read` and an `fs.tail` over the same WS link; their frames
interleave freely.

### Chunk size

- Default: **64 KiB** (`65536`).
- Hard cap: **256 KiB** per frame. Larger payloads return
  `INVALID_REQUEST` on open.
- Consumer-tunable via `chunkSize` on open. Below 4 KiB is silently rounded
  up because per-frame overhead (JSON envelope, base64 expansion) dominates.

Base64 inflation is ~33%; a 64 KiB chunk fits in ~88 KiB of JSON. Well under
typical WS frame budgets (default `ws` library `maxPayload` is 100 MiB).

### End-of-stream

`fs.done` is the terminal envelope. It carries summary metadata:
`totalBytes`, optional `sha256`, and verb-specific extras (`totalEntries`,
`reason`, `renamed`). Receiving `fs.done` frees hub-side state and signals
the consumer's stream API to close cleanly.

This mirrors `pty.exit` from `node-link-pty-host.ts`: the node owns the
terminal envelope and the hub trusts it to fire exactly once per `streamId`.

### Mid-stream errors

A single `fs.error` envelope ends the stream:

```json
{ "channel": "file", "type": "fs.error", "streamId": "S2",
  "error": {
    "code": "INVALID_REQUEST" | "INTERNAL" | "NOT_FOUND" | "UNAUTHORIZED",
    "message": "...",
    "retryable": false
  } }
```

`error.code` is drawn from `RelayNodeErrorCode` in
`shared/relay-node-protocol.ts`. No new error taxonomy.

`error.retryable` distinguishes recoverable from terminal: a transient I/O
error (`code: 'INTERNAL', retryable: true`) means "try `fs.read` again."
A path traversal rejection (`code: 'UNAUTHORIZED', retryable: false`) means
"this will fail every time; fix the request." The consumer treats
`retryable: true` as a hint, not a guarantee — it must still implement its
own backoff.

After `fs.error` is sent, the node closes its file handle, the hub deletes
the `streamId` from its map, and the consumer's stream API rejects. No
further frames on that `streamId` are valid; if any arrive they are dropped
with a warn log.

---

## 5. Backpressure

The PTY path today has no backpressure: `node-link-pty-host.ts` calls
`sendData` synchronously whenever `pty.onData` fires, and a slow browser can
balloon the WS send buffer. PTY data volume per session is small enough that
this is fine. File reads can be unboundedly large — `fs.read` on a 4 GiB log
would buffer the entire file in the hub's WS send queue if the browser is
slow. Backpressure is therefore mandatory for the `file` channel.

### Options considered

| Approach          | How                                                                    | Pros                                                  | Cons                                           |
| ----------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| WS-level only     | Trust `ws.bufferedAmount`, pause source when high                      | No protocol changes                                   | Hub can't propagate browser slowness to node   |
| Pull-based        | Consumer requests each chunk explicitly                                | Simple, naturally bounded                             | Per-chunk RTT kills throughput on fast links   |
| Push-with-drop    | Node drops chunks if hub buffer high                                   | Cheap                                                 | Data loss; unacceptable for files              |
| **Credit window** | Consumer grants byte credits via `fs.ack`; node won't send past window | Throughput on fast links; bounded buffer on slow ones | One extra verb (`fs.ack`); state on both sides |

### Decision: credit window

- **Initial window:** 1 MiB granted on the node's first `fs.ack` (sent in
  response to the verb-specific open envelope). Configurable per-stream via
  `payload.initialWindowBytes` on open.
- **Replenishment:** consumer sends `fs.ack { creditBytes: N }` whenever it
  has drained ≥256 KiB. Hub forwards each `fs.ack` to the node.
- **Node behavior:** maintains a per-stream `outstandingBytes` counter,
  pauses reading when `outstandingBytes >= windowBytes`. Resumes on next
  `fs.ack`.
- **Hub behavior:** the hub forwards `fs.ack` from consumer to node
  transparently. If the browser WS `bufferedAmount` exceeds 4 MiB the hub
  itself stops issuing acks toward the node — this is the second line of
  defense, because a malicious or buggy consumer could otherwise grant an
  infinite window.

### Reverse direction (`fs.write`)

Writes flow consumer → node. The node grants the initial window via
`fs.ack` on open (default 1 MiB), and replenishes every 256 KiB drained to
disk. Consumer respects window or hub kills the stream with
`INVALID_REQUEST: window exceeded`.

### Why not pure WS-level

`ws.bufferedAmount` is observable on the hub for each socket but a hub-only
pause cannot tell the node to stop reading. The node would still happily
hose the hub. Credit window propagates the slow consumer's pace all the way
back to the source `fs.createReadStream`.

---

## 6. Range / seek / append

### Read range semantics

| Param                       | Meaning                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `offset: 0, length: null`   | Full file from start                                           |
| `offset: 1024, length: 512` | Half-open `[1024, 1536)`                                       |
| `offset: 0, length: 0`      | Zero-byte read (single `fs.done` with `totalBytes: 0`)         |
| `lastBytes: 1024`           | Last 1 KiB of file; useful for log preview and `fs.tail` start |

Offsets and lengths are **bytes, not lines**. A `fs.read` of a UTF-8 file
with a 3-byte char at offset N-1 may split the codepoint across two chunks;
the consumer reassembles. This keeps the node simple.

### Write modes

| Mode       | Behavior                                                               | Atomic? |
| ---------- | ---------------------------------------------------------------------- | ------- |
| `create`   | Open with `O_CREAT \| O_EXCL`. Fails if path exists.                   | Yes     |
| `truncate` | Open with `O_CREAT \| O_TRUNC`. Wipes existing content on first chunk. | Yes     |
| `append`   | Open with `O_APPEND \| O_CREAT`. Each chunk appends to current EOF.    | No      |

`atomic: true` (default for `create` and `truncate`) writes to
`<dir>/.relay-write-<streamId>.tmp` and `fs.rename` on `fs.write.close`.
The rename is atomic on POSIX (same filesystem). Cross-filesystem renames
fall back to copy + unlink and surface `error.code: 'INTERNAL'` if the
fallback fails — this is rare because the temp file is always written to
the same directory as the destination.

`atomic: false` is allowed for `create` and `truncate` for cases where the
consumer wants progress visibility (e.g., long uploads with concurrent
readers expecting a partially-written file). Audit-log records the chosen
mode.

`append` is not atomic by definition: each chunk's bytes are flushed to the
existing file. A crash mid-write leaves a partial tail. The audit log
records each chunk's offset on receipt so post-mortem recovery is possible.

---

## 7. Security and path scoping

### Path scoping (node-side)

Every verb resolves its `path` argument as follows before any FS call:

1. Reject if `path` contains a null byte.
2. Reject if `path` is not absolute.
3. `path.resolve(path)` to normalise to an absolute, `..`-collapsed form.
   Then `fs.realpath` the **nearest existing ancestor directory** (walk up
   until a component exists), and join the remaining basename(s) back on.
   This avoids `realpath` throwing on non-existent targets, which is the
   normal case for `fs.write` in `create` mode and for `fs.stat` probing
   existence. Symlinks in the ancestor chain are still followed; the leaf
   (which doesn't exist yet) cannot itself be a symlink, so there's nothing
   to resolve there.
4. Reject if the resolved path is outside the union of:
   - The node's **paired roots** (configured at install / pair time).
   - The node's **configurable allowlist** (`~/.config/relay-ide/file-rpc-roots.json`).
5. Reject if any path component is a `..` literal (defense in depth; step 3
   already collapses them, but a buggy resolver should not be the only line).
6. For `fs.write`, additionally `fs.realpath` the parent directory and
   reject if **that** is outside the allowlist (so a write through a
   symlink-trapped parent is blocked even if the leaf doesn't exist yet).
7. For `fs.stat`, a missing leaf is **not** an error — the verb returns
   `exists: false` after the scope check above passes. Same for `fs.write`
   in `create` mode: a missing leaf is expected; only the parent directory
   must resolve into the allowlist.

Rejection is `error.code: 'UNAUTHORIZED', retryable: false`. The error
message says "path outside allowed roots" — it does **not** echo the
resolved realpath, to avoid an oracle for symlink-based reconnaissance.

Symlinks pointing outside the allowlist are surfaced in `fs.stat` via
`symlinkOutsideRoot: true` so consumers can render them as "→ external"
without the hub knowing the actual target. Following such a symlink in
`fs.read` is rejected.

### Capability bits

Per #427, credentials carry per-verb capability bits. The file RPC layer
introduces three:

| Bit            | Verbs                           |
| -------------- | ------------------------------- |
| `rpc:fs-read`  | `fs.stat`, `fs.list`, `fs.read` |
| `rpc:fs-write` | `fs.write` (any mode)           |
| `rpc:fs-tail`  | `fs.tail`                       |

`fs.stat` and `fs.list` ride on `rpc:fs-read` deliberately — listing a
directory exposes filenames, which is a read. Splitting them adds nothing
operationally.

`rpc:fs-tail` is separate from `rpc:fs-read` because tail is a long-lived
subscription that survives session disconnect (briefly, until hub-side
cleanup). An operator may want to grant inspectors `rpc:fs-read` but not
the ability to pin file handles open.

### Trust-tier interaction (#427)

| Verb       | `sandbox` | `dev`   | `prod`                              |
| ---------- | --------- | ------- | ----------------------------------- |
| `fs.stat`  | allowed   | allowed | allowed                             |
| `fs.list`  | allowed   | allowed | allowed                             |
| `fs.read`  | allowed   | allowed | allowed (audit-logged)              |
| `fs.tail`  | allowed   | allowed | allowed (audit-logged)              |
| `fs.write` | allowed   | allowed | **requires two-token confirmation** |

The confirmation token is supplied as `payload.confirmationToken` on the
`fs.write` open envelope. The hub validates it against the audit-log
confirmation issuance per #427 and rejects with
`error.code: 'UNAUTHORIZED'` if missing or stale.

Reads on `prod` do not require confirmation because read-only inspection is
the most common cross-tier workflow ("what's in `/var/log/foo` on the prod
box?"). The audit log makes the read traceable after the fact.

### Audit log requirements (#427)

Every verb writes a log entry on open with:

- timestamp, hub peer identity, node identity, trust tier
- verb, `streamId`, full resolved realpath
- intent (provided by consumer; e.g., `"inspect"`, `"upload-config"`)
- request hash (sha256 of the open envelope JSON)

`fs.read` / `fs.tail` / `fs.list` log only the open envelope. Chunk
contents are not logged — too large and would be a privacy issue. Size and
duration are recorded on `fs.done` as a closing entry.

`fs.write` logs the open envelope and **every chunk's `(seq, bytes)` pair**
so a partial-write incident can be reconstructed. Chunk bodies are not
logged.

`fs.error` writes a closing entry with the error code and stream summary.

---

## 8. Large file / memory caveats

### Per-stream memory cap

- **Node-side read buffer:** 1 chunk's worth (default 64 KiB) — `fs.createReadStream`
  with `highWaterMark: chunkSize`. Credit window does the rest.
- **Hub-side per-stream buffer:** capped at `windowBytes` (default 1 MiB).
  Hub stops forwarding chunks to the browser when its WS `bufferedAmount`
  exceeds 4 MiB, and stops forwarding `fs.ack` toward the node.
- **Browser-side buffer:** consumer's choice. The credit-window mechanism
  scales the upstream to whatever rate the browser can drain.

### Per-link concurrent stream cap

A single node link is capped at **32 concurrent file streams** (default).
The cap exists per-node and per-channel — `pty` streams are counted
separately. New opens past the cap are rejected with
`error.code: 'NODE_BUSY', retryable: true`. The hub may queue them but
returning `NODE_BUSY` immediately is preferable so the consumer can decide.

### Timeouts

| Timeout     | Default | Behavior                                                                                                                                                            |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open ack    | 5 s     | Hub waits 5 s for the node's first `fs.ack` after issuing the open envelope. Otherwise emits `fs.error: INTERNAL, retryable: true` to the consumer and frees state. |
| Idle read   | 60 s    | Read stream with no chunk progress for 60 s is terminated. Tail streams are exempt (idle is normal for a quiet log).                                                |
| Idle write  | 30 s    | Write stream with no consumer chunk for 30 s is terminated and rolled back (atomic mode unlinks temp file).                                                         |
| Tail follow | none    | Long-lived by design. Cancelled by `fs.cancel` or link close.                                                                                                       |

### Disconnect handling

When the reverse link closes (`HubNodeLinkManager.cleanupNodeLinkResources`
already handles this for `pty`):

- All `file` streams keyed to that link are dropped.
- The hub emits `fs.error: NODE_OFFLINE, retryable: true` to each consumer
  for an in-flight read.
- For an in-flight `fs.write` with `atomic: true`, the temp file remains on
  the node's disk until either the link re-establishes (which would
  abandon it — no resume semantics in v1) or a node-side janitor cleans
  `.relay-write-*.tmp` files older than 1 hour. The audit log records the
  abandoned `streamId` so the file can be associated.

**Resume is not in scope.** A future verb `fs.read.resume(streamId,
fromSeq)` could be added without changing the framing, but v1 just retries
from the start. Consumer should set `lastBytes` or `offset` to skip already-
received bytes if it cares.

### File-size limits

- `fs.read` has no built-in size limit (it streams).
- `fs.write` honours `payload.maxBytes` if the consumer provides it (the
  node rejects with `INVALID_REQUEST` if `totalBytes` would exceed it). No
  hard server-side cap; the audit-log entry records the realised size.
- `fs.list` recursive caps at depth 8 and 100k entries by default.

---

## 9. Follow-up implementation tickets (for epic #428)

One ticket per verb, plus path-scoping and tests. Each is independent enough
to land in its own PR.

| #     | Title                                                          | Why it's separate                                                                                     |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| FU-1  | `file` channel scaffolding + `node-link-file-host.ts` skeleton | Adds `'file'` to `RelayNodeChannel`, no verbs yet. Unlocks parallel verb work.                        |
| FU-2  | `fs.stat` (on `rpc` channel) + capability gate                 | Smallest verb. Validates capability-bit wiring before streaming surface lands.                        |
| FU-3  | `fs.list` with pagination + cursor                             | Validates `file`-channel framing end to end without read-stream complexity.                           |
| FU-4  | `fs.read` with range + credit window                           | First streaming verb. Backpressure must be implemented here or the test for it lives nowhere.         |
| FU-5  | `fs.write` with atomic + append modes + integrity hash         | Mirrors `fs.read` but reverse direction. Atomic rename + temp-file janitor.                           |
| FU-6  | `fs.tail` with follow + rotation                               | Long-lived stream lifecycle; cancel semantics.                                                        |
| FU-7  | Path-scoping module (`server/file-rpc-scope.ts`)               | Shared by all verbs; lands separately so test coverage targets just the resolver.                     |
| FU-8  | Audit-log integration (depends on #427 logging primitives)     | Hooks each verb's open / chunk-summary / close events. Sequence after #427 lands the log primitives.  |
| FU-9  | Trust-tier two-token gate for `fs.write` on `prod` nodes       | Wires `confirmationToken` validation per #427. Depends on FU-5 and #427 confirmation flow.            |
| FU-10 | Integration tests + harness                                    | Large-file read, pagination, write success/error, tail rotation, traversal rejection, capability-off. |

Capability bits (`rpc:fs-read`, `rpc:fs-write`, `rpc:fs-tail`) are added in
FU-2 and consumed by FU-3 through FU-6.

---

## Compliance check

- **ADR-015 (core domain-agnostic):** the `file` channel and `fs.*` verbs are
  core primitives. No path argument encodes "this is a git repo" or "this is
  a worktree." Verbs accept opaque absolute paths. Repo-aware aggregation
  (e.g., "list all `package.json` across paired roots") is a feature-layer
  consumer of `fs.list`, not part of this spec.
- **ADR-016 (node-to-node isolation):** no `fs.*` envelope names a peer node.
  Cross-node file copy is composed at the hub (`fs.read` on node A → `fs.write`
  on node B), never expressed as a single envelope with two `nodeId`s. The
  hub authorizes each leg independently with hub-level credentials.
- **Error taxonomy:** reuses `RelayNodeErrorCode`
  (`INVALID_REQUEST`, `UNAUTHORIZED`, `NOT_FOUND`, `INTERNAL`, `NODE_BUSY`,
  `NODE_OFFLINE`). No new codes added.
