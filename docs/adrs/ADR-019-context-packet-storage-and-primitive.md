# ADR-019: Context-packet storage and primitive

- **Status:** Accepted
- **Date:** 2026-05-27
- **Refs:** #764 (decision gate), #757 (epic), #758, #765, #766, #763, #761, #616, #470, #493, #552, ADR-015, ADR-017, ADR-018
- **Supersedes:** none

> Numbering note: issue #764's body calls this "ADR-018". ADR-018 is already
> taken (`ADR-018-command-mediated-handoff-supervisor.md`, accepted 2026-05-25).
> This decision is **ADR-019**; the issue text is a stale label.

## Context

Epic #757 introduces a CLI/API-first primitive for attaching precise context —
file ranges, diff hunks, terminal ranges, markdown blocks, freeform notes — and
routing it into running agent sessions or durable WorkContexts. The product
principle is that the CLI/API contract is the source of truth and the web UI
(#762) is a thin client over the same verbs; an agent must be able to create,
inspect, deliver, acknowledge, pin, and resolve context headlessly.

The planning cycle's child issues under-specified two forks. This ADR is the
decision gate (#764) that ratifies both so the parallel implementation lanes
build against a fixed contract: **#758** (model + store), **#765** (CLI verbs +
capability bits), **#766** (anchor resolution).

### Fork 1 — where do context packets + inbox messages live?

Children #758/#759 specified workspace-local `.relay/*.json` / `.jsonl` files.
Grounding that against the code:

- **No `.relay/` directory exists anywhere in the repo today.** The only
  durable structured stores are SQLite-behind-gateway: `work-contexts.db` via
  `server/work-contexts.ts`, and the IA store landed in #748.
- The WorkContext store already demonstrates the full pattern this feature
  needs: a `schema_version` table with a guarded migration
  (`server/work-contexts.ts:310-329`), `create/get/list/update`
  (lines 418-449), an `update()` that accepts an `artifacts[]` patch
  (the `WorkContextPatchInput` `Pick`, lines 151-165), and HTTP routes mounted
  via `createWorkContextRouter` (lines 582-745).
- "Agents inspect the workspace representation" is already satisfied by a CLI
  gateway **read verb** returning JSON — the same pull model agents use for
  `work-contexts.get` (ADR-018 command table). Files do not federate across
  nodes; the hub does. Delivery addressing is already
  `GlobalSessionId = nodeId:localSessionId` (`shared/identity.ts:46-51`), not a
  filesystem path.

### Fork 2 — extend `PromptAttachment` or fork a new `ContextAttachment`?

`shared/prompt-attachment.ts` is an **intentionally open** discriminated union
(line 22, with `'diff-ref'`/`'log-ref'` reserved in the header comment) and
already ships the bridge to WorkContext: `promptAttachmentToArtifactRef`
(lines 136-172), which special-cases on `kind`.

`shared/file-resource-ref.ts` already carries
`nodeId/path/sha256/mtimeMs/size/repoBinding/capturedAt/intent`. Critically,
`fileResourceRefEquals` (lines 201-214) **excludes `sha256`/`mtimeMs`/
`capturedAt` from identity** — identity is location `(nodeId, path, intent,
maxBytes, repoBinding)`, freshness is the excluded decorations. That is exactly
the split anchor resolution (#766) needs: identity = "same anchor location",
freshness = "did the content drift". A forked `ContextAttachment` would
re-derive ~70% of `PromptAttachment` + `FileResourceRef` (the file pointer,
the ref-only privacy posture, the artifact bridge, the equality semantics) and
then have to re-implement the freshness primitive that already exists.

The only genuine delta #757 needs is the **anchor**: a line/byte range + a
captured quote, which `FileResourceRef` does not carry.

## Decision

### D1 — Storage: SQLite-behind-gateway, no workspace files for MVP

Context packets and session inbox messages are stored in **SQLite behind the
hub gateway**, reusing the `server/work-contexts.ts` store pattern
(`schema_version` migration, `create/get/list/update`, HTTP router). The CLI
gateway read verbs (`context.list` / `inbox.list`, #765) return JSON over the
same pull model as `work-contexts.get`.

**No `.relay/*.json` workspace files are the write path for MVP.** Files do not
federate across nodes, the hub does, and delivery is already addressed by
`GlobalSessionId`. An optional, derived, **read-only**
`.relay/context/<id>.json` projection MAY be added later as a convenience
mirror for local tooling — it is explicitly a future, never the source of
truth, and never the write path. The store is canonical; any projection is
regenerated from it.

### D2 — Primitive: extend `PromptAttachment`, introduce `AnchorRef` + `ContextPacket`

We **extend** the open `PromptAttachment` union and do **not** fork a parallel
`ContextAttachment`. Concretely (sketched in `shared/context-packet.ts`):

- **`AnchorRef`** composes a `FileResourceRef` + a range (`LineRange` and/or
  `ByteRange`) + a bounded captured `quote`. This is the only net-new shape
  the file primitive needs; everything else (location identity, freshness
  decorations, repo binding, ref-only privacy) is reused from
  `FileResourceRef`.
- **`ContextPacket`** is the durable, **reusable** envelope: stable `id`,
  `kind`, an `AnchorRef` (anchored kinds) or `fileRef`/`note` (freeform),
  optional IA/workbench `binding` (workspace/node/repoInstance/worktreeInstance
  ids), `createdBy`/`createdAt`. It is **lifecycle-independent** — one packet
  can be delivered to many sessions and pinned to many WorkContexts (#763).
- The file-range case slots into `PromptAttachment` as a **new sibling kind
  `'file-anchor'`** (not a `range?` field on the existing `'file-ref'` path),
  so whole-file and ranged attachments stay distinct identities and
  `parsePromptAttachment` validates the range only for the new kind. The
  `promptAttachmentToArtifactRef` bridge extends along its existing `kind`
  switch for the #763 pin path. No `ContextAttachment` type is introduced.

### D3 — Lifecycle (lives on the inbox message, not the packet)

```
queued → delivered → acknowledged → (resolved | ignored)
```

- **`queued`** — created, not yet fetched.
- **`delivered` (= fetched)** — **PULL only**: the consumer fetched it via
  `inbox.list` / agent `preturn` (#761). Relay **never pushes** context through
  `sessions.input` or raw PTY bytes. This is consistent with ADR-018: raw input
  is a narrow PTY smoke primitive, not a blessed agent-to-agent API.
- **`acknowledged`** — consumer explicitly acked receipt.
- **`resolved` / `ignored`** — terminal.

**`stale` is NOT a lifecycle state.** It is **derived** from the referenced
packet's `AnchorState` at render/resolution time, never stored as a manual
transition. `AnchorState = 'unchanged' | 'stale' | 'missing'` is computed by
the #766 resolver from `fileResourceRefEquals` (identity) + sha256/mtime
comparison (freshness). `'shifted'` (range moved but quote relocatable) is
**explicitly deferred** — until then a moved range surfaces as `stale`.

### D4 — Environment contract

The shipped env var is **`RELAY_WORK_CONTEXT_ID`**, set by
`injectRelaySessionEnv` in `server/pty-handler.ts:676-677` (both process env and
tmux env). #761's proposed `RELAY_WORKCONTEXT_ID` (no underscore between WORK
and CONTEXT) is **wrong** and must align to the shipped name. Agent context
`preturn` keys off the session's bound `GlobalSessionId` and, when present,
`RELAY_WORK_CONTEXT_ID`.

### D5 — Capability bits

Four new bits, added to `RELAY_CAPABILITY_BITS` in `shared/security-policy.ts`:

| Bit | Tier placement |
| --- | --- |
| `context:read` | default-allow (add to `LEGACY_DEFAULT_ALLOWED_CAPABILITIES`) |
| `inbox:read` | default-allow (add to `LEGACY_DEFAULT_ALLOWED_CAPABILITIES`) |
| `context:write` | dev-allow; **NOT** in `HIGH_RISK_CAPABILITIES` |
| `inbox:write` | dev-allow; **NOT** in `HIGH_RISK_CAPABILITIES` |

Rationale grounded in the policy module: the trust-tier overlay
(`applyTrustTierOverlay`, `shared/security-policy.ts:190-217`) silently allows
any granted bit on `dev`/`sandbox` tiers, and only promotes a bit to
`requiresConfirmation` on the `prod` tier if it is in
`HIGH_RISK_CAPABILITY_SET`. Reads (`context:read`/`inbox:read`) go in
`LEGACY_DEFAULT_ALLOWED_CAPABILITIES` (lines 38-55), so they are silent-allow by
default like `session:read`/`rpc:fs:read`. Writes are ref-only context inserts —
no raw payload, no file mutation, no PTY exec — so they do **not** belong in
`HIGH_RISK_CAPABILITIES` (lines 57-66, which is reserved for
kill/intervention-send/intervention-submit/fs-write/fs-delete/git-write/pty-exec/
port-forward). They remain grant-gated (an ungranted bit is `deny`) and a `prod`
operator can still revoke per-node by editing the ACL, but they are not promoted
to a confirmation challenge on prod.

## Storage schema

Mirrors the `server/work-contexts.ts` column style (TEXT ids, `*_json` blob for
the typed envelope, ISO-8601 `created_at`/`updated_at`, `schema_version` table
with the same guarded migration at lines 310-329). Real DDL lands in #758; this
is the ratified shape.

```sql
-- schema_version table identical to work-contexts.db (single-row INTEGER).

CREATE TABLE IF NOT EXISTS context_packets (
  id           TEXT PRIMARY KEY,         -- cp:<suffix>
  kind         TEXT NOT NULL,            -- file-anchor | file-ref | diff-ref | log-ref | note
  packet_json  TEXT NOT NULL,            -- canonical ContextPacket (ref-only; no raw bytes)
  node_id      TEXT,                     -- denormalized from binding for federation queries
  workspace_id TEXT,                     -- denormalized from binding
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_packets_created_at
  ON context_packets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_packets_node
  ON context_packets(node_id);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id                     TEXT PRIMARY KEY,   -- im:<suffix>
  target_session_id      TEXT,               -- GlobalSessionId (nodeId:localSessionId)
  target_work_context_id TEXT,               -- WorkContextId (handoff/pin path)
  message_json           TEXT NOT NULL,      -- canonical SessionInboxMessage
  state                  TEXT NOT NULL,      -- queued|delivered|acknowledged|resolved|ignored
  created_by             TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  delivered_at           TEXT,
  acknowledged_at        TEXT,
  resolved_at            TEXT,
  updated_at             TEXT NOT NULL,
  CHECK (target_session_id IS NOT NULL OR target_work_context_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_session
  ON inbox_messages(target_session_id, state);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_work_context
  ON inbox_messages(target_work_context_id, state);

-- Many-to-many: a packet is reusable across messages; a message carries many.
CREATE TABLE IF NOT EXISTS inbox_message_packets (
  message_id        TEXT NOT NULL,
  context_packet_id TEXT NOT NULL,
  ordinal           INTEGER NOT NULL,    -- preserve attachment order
  PRIMARY KEY (message_id, context_packet_id),
  FOREIGN KEY (message_id) REFERENCES inbox_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (context_packet_id) REFERENCES context_packets(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_inbox_message_packets_packet
  ON inbox_message_packets(context_packet_id);
```

Notes:

- `packet_json` / `message_json` hold the canonical typed envelope (same
  blob-plus-denormalized-columns approach as `work_contexts.context_json`). No
  `AnchorState` is stored — it is derived at read time by #766.
- `ON DELETE RESTRICT` on the join's packet FK enforces packet reuse: a packet
  referenced by a live message cannot be deleted out from under it.
- No `stale`/`shifted` columns — staleness is never persisted.

## Consequences

- All three impl lanes share one contract: #758 implements the store +
  `parse`/`create` against `shared/context-packet.ts`; #765 adds the four
  capability bits + `context.*`/`inbox.*` CLI verbs to
  `shared/cli-gateway-contract.ts` and the manifest; #766 implements
  `resolveAnchorState` on top of `fileResourceRefEquals`.
- Reusing the WorkContext store pattern means context packets inherit the same
  ref-only/no-raw-payload privacy discipline and federate through the hub
  exactly like work contexts and active-work read models.
- The deferred `.relay/` projection and `'shifted'` anchor state are named
  non-goals, so follow-on issues do not re-litigate them as gaps.
- #761 must rename its env var to the shipped `RELAY_WORK_CONTEXT_ID`.

## Alternatives considered

- **`.relay/*.json` / `.jsonl` workspace files (as originally specced in
  #758/#759).** Rejected for MVP: no `.relay/` exists today, files do not
  federate across nodes (the hub does), and there is no existing file-watch /
  reconciliation machinery — adopting it would be net-new infrastructure that
  contradicts the hub-mediated, `GlobalSessionId`-addressed delivery model.
  Retained as a deferred read-only projection only.
- **Fork a parallel `ContextAttachment` union.** Rejected: ~70% overlap with
  `PromptAttachment` + `FileResourceRef` (file pointer, ref-only privacy,
  artifact bridge, equality), and it would have to re-implement the
  anchor-freshness primitive that `fileResourceRefEquals` already provides.
  Extending the open union is the smaller, lower-risk change.
- **Thread `range?` onto the existing `PromptAttachmentFileRef`.** Rejected in
  favor of a sibling `'file-anchor'` kind: keeps whole-file vs ranged
  attachments as distinct identities, avoids weakening the existing `file-ref`
  parser, and matches the discriminant-switch extension style of
  `createPromptAttachment` / `promptAttachmentToArtifactRef`.
- **Store `AnchorState` (`stale`) as a lifecycle column.** Rejected: staleness
  is a pure function of current file contents vs the captured ref; persisting
  it would immediately drift and require invalidation on every file change.
  Derive at render time instead.
- **Promote `context:write`/`inbox:write` into `HIGH_RISK_CAPABILITIES`.**
  Rejected: writes are ref-only metadata inserts with no raw payload, file
  mutation, or exec; high-risk is reserved for kill/intervention/fs-write/
  fs-delete/git-write/pty-exec/port-forward. They stay grant-gated but not
  confirmation-gated on prod.
```
