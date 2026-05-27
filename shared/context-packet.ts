// #764 / Epic #757: CLI-first anchored context packets + session inbox.
//
// TYPE SKETCHES ONLY. This module is the ratified contract from ADR-019
// (`docs/adrs/ADR-019-context-packet-storage-and-primitive.md`). It defines
// the shared shapes the parallel implementation lanes build against:
//   - #758 — model + SQLite-behind-gateway store (the real `create`/`parse`/
//            store/route logic lands here; the stubs below are signatures only)
//   - #765 — CLI gateway verbs + capability bits
//   - #766 — anchor resolution (`resolveAnchorState`)
//
// Design rules this file obeys (see ADR-019 §Decision):
//   1. `ContextPacket` is the durable, REUSABLE envelope. It carries no
//      lifecycle state — lifecycle lives on `SessionInboxMessage`, so one
//      packet can be delivered to many sessions/WorkContexts independently.
//   2. The anchored-file primitive REUSES `FileResourceRef` for location
//      identity and freshness decorations. `AnchorRef` only adds the delta
//      #757 needs: a line/byte range + a captured quote snapshot. Anchor
//      freshness derives from `fileResourceRefEquals` (which excludes
//      sha256/mtime/capturedAt from identity) — see `resolveAnchorState`.
//   3. `AnchorState` is DERIVED at render/resolution time, never stored as a
//      manual lifecycle field. `'shifted'` is explicitly deferred.
//
// This module is browser-safe: it imports no `node:*` builtins, mirroring
// `shared/file-resource-ref.ts` and `shared/prompt-attachment.ts` so the web
// UI (#762) can consume the same shapes. Id minting therefore takes a
// caller-supplied opaque suffix (the server owns the randomness), matching the
// `createWorkspaceId(localId)` convention in `shared/workspace.ts`.

import type {
  GlobalSessionId,
  NodeId,
  RepoInstanceId,
  WorktreeInstanceId,
} from './identity.js';
import type { WorkspaceId } from './workspace.js';
import type { WorkContextId } from './work-context.js';
import {
  fileResourceRefEquals,
  type FileResourceRef,
} from './file-resource-ref.js';
import type { PromptAttachment } from './prompt-attachment.js';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Stable id for a `ContextPacket`. Format: `cp:<suffix>` (see helper). */
export type ContextPacketId = string;

/** Stable id for a `SessionInboxMessage`. Format: `im:<suffix>`. */
export type SessionInboxMessageId = string;

export const CONTEXT_PACKET_ID_PREFIX = 'cp:' as const;
export const SESSION_INBOX_MESSAGE_ID_PREFIX = 'im:' as const;

// ---------------------------------------------------------------------------
// Anchor primitive
// ---------------------------------------------------------------------------

/**
 * A 1-based, inclusive line range inside a file. `endLine >= startLine`.
 * Used for human-meaningful selections (the common UI case).
 */
export interface LineRange {
  /** 1-based inclusive first line. */
  startLine: number;
  /** 1-based inclusive last line (>= `startLine`). */
  endLine: number;
}

/**
 * A byte range inside a file: `[startByte, endByte)` — start inclusive, end
 * exclusive, 0-based. Used for binary/exact selections and terminal ranges
 * where line semantics do not apply. Either or both range kinds may be set;
 * at least one is required for an anchored packet.
 */
export interface ByteRange {
  /** 0-based inclusive first byte. */
  startByte: number;
  /** 0-based exclusive end byte (> `startByte`). */
  endByte: number;
}

/**
 * Resolution state of an anchor against the file's current contents.
 *
 *   - `unchanged` — the underlying file resource identity matches (per
 *     `fileResourceRefEquals`) AND the freshness decorations (sha256/mtime)
 *     still match what was captured. The anchored range is trustworthy.
 *   - `stale`     — the file resource still resolves to the same location,
 *     but its content changed since capture (sha256/mtime drift). The range
 *     may no longer point at the captured `quote`.
 *   - `missing`   — the file resource no longer resolves (path/node/binding
 *     identity mismatch, or the file is gone).
 *
 * `'shifted'` (range moved but quote still present at a new offset) is
 * explicitly DEFERRED — it requires content diffing the resolver (#766) does
 * not do in MVP. Until then a moved range surfaces as `stale`.
 *
 * This state is ALWAYS derived at resolution/render time. It is never a
 * stored field on `ContextPacket` or `SessionInboxMessage`.
 */
export type AnchorState = 'unchanged' | 'stale' | 'missing';

/**
 * `AnchorRef` composes a `FileResourceRef` (location identity + freshness
 * decorations) with a range and a bounded captured quote snapshot. It is the
 * delta #757 needs on top of `FileResourceRef`, which carries nodeId/path/
 * sha256/mtimeMs/size/repoBinding but no range.
 *
 * Identity = the underlying `FileResourceRef` identity (`fileResourceRefEquals`
 * excludes sha256/mtime/capturedAt) + the range. Freshness = the excluded
 * decorations, compared by the resolver to compute `AnchorState`.
 */
export interface AnchorRef {
  /** Location handle on a (possibly remote) node. Identity carrier. */
  ref: FileResourceRef;
  /** Line range (1-based inclusive). Set for line-oriented selections. */
  lineRange?: LineRange;
  /** Byte range (0-based, half-open). Set for exact/binary/terminal ranges. */
  byteRange?: ByteRange;
  /**
   * Snapshot of the selected text at capture time, bounded by
   * `MAX_ANCHOR_QUOTE_BYTES`. Advisory only — used to render the chip and to
   * let a future `'shifted'` resolver relocate the range. Never authoritative
   * for access; the resolver re-reads through the node RPC under capability.
   */
  quote?: string;
}

/** Max captured `AnchorRef.quote` length in bytes. Resolver/store truncate. */
export const MAX_ANCHOR_QUOTE_BYTES = 4096;

// ---------------------------------------------------------------------------
// Context packet envelope
// ---------------------------------------------------------------------------

/**
 * The kind of context a packet carries. Mirrors (and is a superset of) the
 * `PromptAttachment` open union surface:
 *   - `file-anchor`   — an `AnchorRef` (file range + quote). The headline kind.
 *   - `file-ref`      — a whole-file `FileResourceRef` with no range (bridges
 *                       directly to an existing `PromptAttachment` kind).
 *   - `diff-ref` / `log-ref` — reserved; align with the `PromptAttachment`
 *                       reservations in `shared/prompt-attachment.ts`. Anchor
 *                       support for these is deferred (#760).
 *   - `note`          — freeform text only; no anchor (the `note` field holds
 *                       the body).
 */
export type ContextPacketKind =
  | 'file-anchor'
  | 'file-ref'
  | 'diff-ref'
  | 'log-ref'
  | 'note';

export const CONTEXT_PACKET_KINDS: readonly ContextPacketKind[] = [
  'file-anchor',
  'file-ref',
  'diff-ref',
  'log-ref',
  'note',
] as const;

/**
 * Optional binding placing the packet in the six-layer IA tree + workbench
 * identity. All fields optional: a freeform `note` packet may carry none, an
 * anchored packet typically carries `nodeId` (it is already on the `AnchorRef`'s
 * `FileResourceRef`) plus repo/worktree instance ids when known.
 */
export interface ContextPacketBinding {
  workspaceId?: WorkspaceId;
  nodeId?: NodeId;
  repoInstanceId?: RepoInstanceId;
  worktreeInstanceId?: WorktreeInstanceId;
}

/**
 * `ContextPacket` is the durable, reusable envelope. It is
 * LIFECYCLE-INDEPENDENT: the same packet id can be referenced by many
 * `SessionInboxMessage`s and pinned to many WorkContexts (#763). Delivery and
 * acknowledgement state never live here.
 *
 * Stored ref-only (per ADR-019 + the WorkContext privacy model): the packet
 * carries pointers + a bounded `quote`/`note`, not raw file bytes.
 */
export interface ContextPacket {
  /** Stable id (`cp:<suffix>`). Caller-owned; server mints the suffix. */
  id: ContextPacketId;
  kind: ContextPacketKind;
  /** Set for `file-anchor`. Omitted for `file-ref`/`note`/reserved kinds. */
  anchor?: AnchorRef;
  /** Set for `file-ref`: whole-file pointer with no range. */
  fileRef?: FileResourceRef;
  /** Freeform body. Required for `note`; optional annotation otherwise. */
  note?: string;
  /** IA/workbench placement. */
  binding?: ContextPacketBinding;
  /** Actor id that created the packet (human user id, agent id, etc.). */
  createdBy: string;
  /** ISO 8601 UTC mint timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Session inbox message (lifecycle lives here)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of an inbox message.
 *
 *   queued → delivered → acknowledged → (resolved | ignored)
 *
 *   - `queued`       — created, not yet fetched by the target consumer.
 *   - `delivered`    — the consumer PULLED it (via `inbox.list` / agent
 *     preturn). Delivery is a PULL: "delivered" == "fetched". Relay never
 *     pushes packets through `sessions.input`/raw PTY bytes (ADR-019, ADR-018).
 *   - `acknowledged` — the consumer explicitly acked receipt.
 *   - `resolved`     — terminal: the context was acted on/addressed.
 *   - `ignored`      — terminal: the consumer dismissed it.
 *
 * NOTE: `stale` is NOT a message lifecycle state. Staleness is a DERIVED
 * property of each referenced packet's `AnchorState` (see `resolveAnchorState`),
 * surfaced at render time — never a stored manual transition.
 */
export type SessionInboxMessageState =
  | 'queued'
  | 'delivered'
  | 'acknowledged'
  | 'resolved'
  | 'ignored';

export const SESSION_INBOX_MESSAGE_STATES: readonly SessionInboxMessageState[] =
  ['queued', 'delivered', 'acknowledged', 'resolved', 'ignored'] as const;

/** Terminal states — no further transitions allowed. */
export const TERMINAL_INBOX_MESSAGE_STATES: readonly SessionInboxMessageState[] =
  ['resolved', 'ignored'] as const;

/**
 * A message in a session/WorkContext inbox. Targets exactly one of a live
 * session (`GlobalSessionId = nodeId:localSessionId`) or a durable
 * `WorkContextId` (for handoff/pinning, #763) — at least one is required.
 * References packets by id so packet bodies stay reusable + deduped.
 */
export interface SessionInboxMessage {
  /** Stable id (`im:<suffix>`). */
  id: SessionInboxMessageId;
  /** Target live session, if addressed to a running session. */
  targetSessionId?: GlobalSessionId;
  /** Target WorkContext, if addressed durably (handoff/pin). */
  targetWorkContextId?: WorkContextId;
  /** Packets this message carries (by id; bodies live in the packet store). */
  contextPacketIds: ContextPacketId[];
  /** Optional human/agent-authored message body. */
  text?: string;
  /** Current lifecycle state (see `SessionInboxMessageState`). */
  state: SessionInboxMessageState;
  /** Actor id that sent the message. */
  createdBy: string;
  /** ISO 8601 UTC timestamps for each observed transition. */
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  ignoredAt?: string;
}

// ---------------------------------------------------------------------------
// PromptAttachment bridge
// ---------------------------------------------------------------------------
//
// ADR-019 decision: EXTEND the open `PromptAttachment` union; do NOT fork a
// parallel `ContextAttachment`. The file-range case slots in as a NEW SIBLING
// kind `'file-anchor'` rather than threading a `range?` onto the existing
// `'file-ref'` path, because:
//   - it keeps `PromptAttachmentFileRef` identity-equality clean (a whole-file
//     ref and a ranged ref are different attachments, not the same one with an
//     optional field);
//   - `parsePromptAttachment` can validate the range up front for the new kind
//     without weakening the existing `file-ref` parser;
//   - `promptAttachmentToArtifactRef` already special-cases on `kind`, so a new
//     kind is the natural extension point for the #763 pin path.
//
// The new kind to add to `shared/prompt-attachment.ts` in #758 (sketch):
//
//   export interface PromptAttachmentFileAnchor {
//     kind: 'file-anchor';
//     anchor: AnchorRef;      // from this module
//     summary?: string;
//   }
//   export type PromptAttachment =
//     | PromptAttachmentFileRef
//     | PromptAttachmentFileAnchor;   // ← extend the union here
//
// `PROMPT_ATTACHMENT_KINDS`, `CreatePromptAttachmentArgs`, the
// `createPromptAttachment`/`parsePromptAttachment` switches, and
// `promptAttachmentToArtifactRef` (kind === 'file-anchor' → ArtifactKind
// 'file' with `path` + range in the summary) all extend along the existing
// `kind` discriminant. No `ContextAttachment` type is introduced.

/**
 * Project a `ContextPacket` onto a `PromptAttachment` for inclusion in an
 * outgoing prompt. `file-anchor` → the new `'file-anchor'` attachment kind;
 * `file-ref` → the existing `'file-ref'` kind; `note` → not attachable
 * (returns null — notes ride the message `text`, not the attachment list).
 *
 * Signature only — impl in #758 once the union extension lands.
 */
export declare function contextPacketToPromptAttachment(
  packet: ContextPacket
): PromptAttachment | null;

// ---------------------------------------------------------------------------
// Id helpers (signatures + minimal compiling stubs)
// ---------------------------------------------------------------------------

function hasValue(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * Mint a `ContextPacketId` from a caller-supplied opaque suffix. The server
 * (#758) supplies the random component (e.g. 8 random bytes hex), mirroring
 * `createWorkContextId` → `wc:<hex>` and `createWorkspaceId(localId)`. Kept
 * browser-safe: no `node:crypto` import here.
 */
export function createContextPacketId(suffix: string): ContextPacketId {
  if (!hasValue(suffix)) throw new Error('suffix is required');
  return `${CONTEXT_PACKET_ID_PREFIX}${encodeURIComponent(suffix)}`;
}

/** Mint a `SessionInboxMessageId` from a caller-supplied opaque suffix. */
export function createInboxMessageId(suffix: string): SessionInboxMessageId {
  if (!hasValue(suffix)) throw new Error('suffix is required');
  return `${SESSION_INBOX_MESSAGE_ID_PREFIX}${encodeURIComponent(suffix)}`;
}

// ---------------------------------------------------------------------------
// Parse / validate (signatures only — real validation in #758)
// ---------------------------------------------------------------------------

/**
 * Parse an unknown payload into a `ContextPacket`, returning `null` on any
 * validation failure (mirrors `parseFileResourceRef`/`parsePromptAttachment`).
 * Impl in #758.
 */
export declare function parseContextPacket(payload: unknown): ContextPacket | null;

/** Parse an unknown payload into a `SessionInboxMessage`. Impl in #758. */
export declare function parseSessionInboxMessage(
  payload: unknown
): SessionInboxMessage | null;

// ---------------------------------------------------------------------------
// Anchor resolution (the #766 primitive — signature only)
// ---------------------------------------------------------------------------

/**
 * Resolve an `AnchorRef`'s `AnchorState` against the file's CURRENT contents.
 *
 * `captured` is the ref as stored on the packet; `current` is a freshly
 * minted `FileResourceRef` for the same location (re-stat/re-read via node
 * RPC under capability). Resolution rule (#766):
 *   - identity mismatch (`!fileResourceRefEquals`) → `'missing'`
 *   - identity match + sha256/mtime drift           → `'stale'`
 *   - identity match + decorations match            → `'unchanged'`
 *
 * The reference equality below is the load-bearing reuse from
 * `file-resource-ref.ts`: identity excludes the freshness decorations, so a
 * re-minted ref for the same file is "the same anchor location" even though
 * its sha256/mtime/capturedAt differ — exactly the comparison the resolver
 * needs. Impl in #766; this stub just documents the contract and keeps the
 * import live.
 */
export function resolveAnchorState(
  captured: AnchorRef,
  current: FileResourceRef | null
): AnchorState {
  // impl in #766 — sketch only. Real version also compares sha256/mtime to
  // distinguish 'stale' from 'unchanged'.
  if (!current) return 'missing';
  if (!fileResourceRefEquals(captured.ref, current)) return 'missing';
  return 'unchanged';
}
