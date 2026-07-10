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
import type { ArtifactKind, WorkContextId } from './work-context.js';
import {
  fileResourceRefEquals,
  fileResourceRefSummary,
  parseFileResourceRef,
  type FileResourceRef,
} from './file-resource-ref.js';
import { createPromptAttachment } from './prompt-attachment.js';
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

// `quote` is a JS (UTF-16) string but `MAX_ANCHOR_QUOTE_BYTES` is a UTF-8 byte
// budget. A single emoji is one `.length`-2 string but four UTF-8 bytes, so we
// must measure and truncate by encoded byte length, never `.length`. Use the
// platform `TextEncoder` (available in browsers and Node ≥ 11) so this module
// stays browser-safe (no `node:` import).
const QUOTE_ENCODER = new TextEncoder();
const QUOTE_DECODER = new TextDecoder();

/** UTF-8 byte length of a string (not its UTF-16 `.length`). */
export function utf8ByteLength(value: string): number {
  return QUOTE_ENCODER.encode(value).length;
}

/**
 * Truncate `value` to at most `maxBytes` UTF-8 bytes. Truncation happens on a
 * byte boundary; a multi-byte code point split by the cut is dropped (the
 * lenient `TextDecoder` would otherwise emit a replacement char). Returns the
 * input unchanged when it already fits.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = QUOTE_ENCODER.encode(value);
  if (encoded.length <= maxBytes) return value;
  // `fatal: false` (the default) emits U+FFFD for a trailing partial code
  // point; `ignoreBOM` keeps a leading BOM intact. We then strip any trailing
  // replacement char produced by cutting mid-codepoint.
  const sliced = QUOTE_DECODER.decode(encoded.slice(0, maxBytes));
  return sliced.replace(/�+$/u, '');
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseLineRange(payload: unknown): LineRange | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const startLine = p['startLine'];
  const endLine = p['endLine'];
  // 1-based, inclusive, both >= 1, end >= start.
  if (typeof startLine !== 'number' || !Number.isInteger(startLine))
    return null;
  if (typeof endLine !== 'number' || !Number.isInteger(endLine)) return null;
  if (startLine < 1 || endLine < startLine) return null;
  return { startLine, endLine };
}

function parseByteRange(payload: unknown): ByteRange | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const startByte = p['startByte'];
  const endByte = p['endByte'];
  // 0-based, half-open `[start, end)`, end strictly greater than start.
  if (!isPositiveInt(startByte)) return null;
  if (!isPositiveInt(endByte)) return null;
  if (endByte <= startByte) return null;
  return { startByte, endByte };
}

/**
 * Parse + validate an unknown payload into an `AnchorRef`. Returns `null` on
 * any validation failure (mirrors `parseFileResourceRef`). Requires a valid
 * `FileResourceRef` plus at least one of `lineRange`/`byteRange`. The captured
 * `quote` is truncated to `MAX_ANCHOR_QUOTE_BYTES` UTF-8 bytes (not `.length`).
 */
export function parseAnchorRef(payload: unknown): AnchorRef | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const ref = parseFileResourceRef(p['ref']);
  if (!ref) return null;
  const lineRange =
    p['lineRange'] !== undefined ? parseLineRange(p['lineRange']) : null;
  if (p['lineRange'] !== undefined && lineRange === null) return null;
  const byteRange =
    p['byteRange'] !== undefined ? parseByteRange(p['byteRange']) : null;
  if (p['byteRange'] !== undefined && byteRange === null) return null;
  // At least one range kind is required for an anchored packet.
  if (!lineRange && !byteRange) return null;
  const anchor: AnchorRef = { ref };
  if (lineRange) anchor.lineRange = lineRange;
  if (byteRange) anchor.byteRange = byteRange;
  if (typeof p['quote'] === 'string') {
    anchor.quote = truncateUtf8(p['quote'], MAX_ANCHOR_QUOTE_BYTES);
  }
  return anchor;
}

/**
 * Compact human-readable label for an anchor: the underlying ref summary plus
 * the range (`#L<start>-L<end>` for line ranges, `@<start>-<end>` for byte
 * ranges). Used for chips/audit rows and the `PromptAttachment` artifact
 * bridge.
 */
export function anchorRefSummary(anchor: AnchorRef): string {
  const base = fileResourceRefSummary(anchor.ref);
  if (anchor.lineRange) {
    const { startLine, endLine } = anchor.lineRange;
    return startLine === endLine
      ? `${base}#L${startLine}`
      : `${base}#L${startLine}-L${endLine}`;
  }
  if (anchor.byteRange) {
    return `${base}@${anchor.byteRange.startByte}-${anchor.byteRange.endByte}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Artifact-ref primitive (#898)
// ---------------------------------------------------------------------------

/**
 * A ref-only pointer to a durable WorkContext artifact (the evidence layer,
 * `server/work-context-artifacts.ts`). Like the rest of this module it carries
 * pointers + bounded metadata, never artifact bytes: resolution re-reads the
 * artifact through the gateway under capability. `artifactId` is the identity;
 * the remaining fields are advisory decorations for rendering the chip/audit
 * row without a round-trip.
 */
export interface ArtifactPacketRef {
  /** Stable artifact id (the store's primary key). Identity carrier. */
  artifactId: string;
  /** WorkContext the artifact belongs to, when known. */
  workContextId?: WorkContextId;
  /** Content hash of the artifact payload at capture, for freshness display. */
  payloadSha256?: string;
  /** Artifact kind (`shared/work-context.ts` `ArtifactKind`). */
  kind?: ArtifactKind;
  /** Human label, bounded by `MAX_ARTIFACT_TITLE_BYTES`. */
  title?: string;
  /**
   * Public/remote-safe locator (e.g. `owner/repo#123`, a gateway URL). NEVER a
   * raw local filesystem path — those are rejected by `parseArtifactPacketRef`
   * (privacy: local paths never leave the source system, mirroring the
   * artifact store's public sanitizer).
   */
  uri?: string;
}

/** Max captured `ArtifactPacketRef.title` length in bytes. Parser truncates. */
export const MAX_ARTIFACT_TITLE_BYTES = 512;

// Rejects any value that looks like an absolute local filesystem path or a
// file:// URI. `artifactId`/`uri` are single locators, not prose, so we anchor
// at the start (`^`) and keep the check strict:
//   - `/…`              any Unix absolute path (leading slash)
//   - `[A-Za-z]:[\\/]` Windows drive (C:\, C:/, d:\, …)
//   - `\\\\`            UNC share (\\server\share)
//   - `file:`           file:// URI (case-insensitive)
// Kept browser-safe (no `node:path`): this module imports no builtins.
const ABSOLUTE_LOCAL_PATH_PREFIX_RE = /^(?:\/|[a-z]:[\\/]|\\\\|file:)/i;

/** True if `value` looks like an absolute local filesystem path or file: URI. */
function looksLikeAbsoluteLocalPath(value: string): boolean {
  return ABSOLUTE_LOCAL_PATH_PREFIX_RE.test(value);
}

/**
 * Parse + validate an unknown payload into an `ArtifactPacketRef`. Returns
 * `null` on any validation failure (mirrors `parseAnchorRef`). Requires a
 * non-empty `artifactId`; rejects `artifactId`/`uri` values that look like
 * absolute local paths (privacy). Copies ONLY the declared fields — stray
 * unknown keys are dropped. `title` is truncated to `MAX_ARTIFACT_TITLE_BYTES`
 * UTF-8 bytes (not `.length`).
 */
export function parseArtifactPacketRef(
  payload: unknown
): ArtifactPacketRef | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const artifactId = p['artifactId'];
  if (typeof artifactId !== 'string' || artifactId.trim().length === 0) {
    return null;
  }
  if (looksLikeAbsoluteLocalPath(artifactId)) return null;
  const ref: ArtifactPacketRef = { artifactId };
  if (typeof p['workContextId'] === 'string') {
    ref.workContextId = p['workContextId'];
  }
  if (typeof p['payloadSha256'] === 'string') {
    ref.payloadSha256 = p['payloadSha256'];
  }
  if (typeof p['kind'] === 'string') {
    ref.kind = p['kind'] as ArtifactKind;
  }
  if (typeof p['title'] === 'string') {
    ref.title = truncateUtf8(p['title'], MAX_ARTIFACT_TITLE_BYTES);
  }
  if (typeof p['uri'] === 'string') {
    // A raw local path must never travel in a ref (it would leak the source
    // system's filesystem layout). Reject the whole ref rather than silently
    // drop the uri.
    if (looksLikeAbsoluteLocalPath(p['uri'])) return null;
    ref.uri = p['uri'];
  }
  return ref;
}

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
 *   - `artifact-ref`  — a ref-only pointer to a durable WorkContext artifact
 *                       (`ArtifactPacketRef`). No `PromptAttachment` surface
 *                       yet (#898); deferred like the reserved kinds.
 */
export type ContextPacketKind =
  | 'file-anchor'
  | 'file-ref'
  | 'diff-ref'
  | 'log-ref'
  | 'note'
  | 'artifact-ref';

export const CONTEXT_PACKET_KINDS: readonly ContextPacketKind[] = [
  'file-anchor',
  'file-ref',
  'diff-ref',
  'log-ref',
  'note',
  'artifact-ref',
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
  /** Set for `artifact-ref`: ref-only pointer to a WorkContext artifact. */
  artifactRef?: ArtifactPacketRef;
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

/** True if `state` is terminal (`resolved`/`ignored`). */
export function isTerminalInboxMessageState(
  state: SessionInboxMessageState
): boolean {
  return (TERMINAL_INBOX_MESSAGE_STATES as readonly string[]).includes(state);
}

/**
 * Outcome of validating a requested inbox-message state transition.
 *   - `ok: true, idempotent: false`  — a real forward transition; apply it.
 *   - `ok: true, idempotent: true`   — `from === to`; a re-touch (a PULL
 *     `inbox.list` re-fetching an already-delivered row, an agent
 *     double-acking). Treat as a no-op success, NOT an error. (ADR-019 C2.)
 *   - `ok: false`                    — illegal: a transition out of a terminal
 *     state, or a non-monotonic jump (e.g. `acknowledged` → `delivered`).
 */
export type InboxTransitionValidation =
  | { ok: true; idempotent: boolean }
  | { ok: false; reason: string };

// Forward-reachable target states from each state. Lifecycle:
//   queued → delivered → acknowledged → (resolved | ignored)
// Skips are permitted forward (e.g. queued → acknowledged when an agent acks a
// message it pulled in the same turn, or queued → resolved/ignored to dismiss
// without acking). Backward moves are rejected; same-state is idempotent.
const INBOX_FORWARD_TARGETS: Record<
  SessionInboxMessageState,
  readonly SessionInboxMessageState[]
> = {
  queued: ['delivered', 'acknowledged', 'resolved', 'ignored'],
  delivered: ['acknowledged', 'resolved', 'ignored'],
  acknowledged: ['resolved', 'ignored'],
  resolved: [],
  ignored: [],
};

/**
 * Validate a requested `from → to` inbox-message state transition. The store
 * (#758) enforces this on every update and #765 reuses it for the `inbox.*`
 * write verbs. Implements ADR-019 C2:
 *   - same-state is idempotent success (PULL re-touch / agent double-fetch);
 *   - any transition OUT of a terminal state is rejected;
 *   - only forward-reachable transitions are allowed (no backward moves).
 */
export function validateInboxTransition(
  from: SessionInboxMessageState,
  to: SessionInboxMessageState
): InboxTransitionValidation {
  if (!isInboxMessageState(to)) {
    return { ok: false, reason: 'invalid_target_state' };
  }
  if (from === to) {
    // Idempotent re-touch. Even when `from` is terminal: re-asserting the same
    // terminal state is a harmless no-op, not a transition out of it.
    return { ok: true, idempotent: true };
  }
  if (isTerminalInboxMessageState(from)) {
    return { ok: false, reason: 'terminal_state' };
  }
  if (!INBOX_FORWARD_TARGETS[from].includes(to)) {
    return { ok: false, reason: 'illegal_transition' };
  }
  return { ok: true, idempotent: false };
}

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
  /**
   * Actor id that performed the most recent explicit lifecycle transition
   * (ack/resolve/ignore). Blob-only (like `ignoredAt`; no denormalized column):
   * records WHO advanced the message so inbox audit can attribute the action.
   * Undefined for pull-delivery flips (no explicit actor) and un-transitioned
   * messages.
   */
  transitionedBy?: string;
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
 * (returns `null` — notes ride the message `text`, not the attachment list,
 * per ADR-019 C4). Reserved kinds (`diff-ref`/`log-ref`) have no
 * `PromptAttachment` surface yet (#760) and also return `null`.
 *
 * Returns `null` (rather than throwing) when the packet lacks the data its
 * kind requires (e.g. a `file-anchor` packet with no `anchor`), so a single
 * malformed packet drops out of a prompt instead of tearing it down.
 */
export function contextPacketToPromptAttachment(
  packet: ContextPacket
): PromptAttachment | null {
  switch (packet.kind) {
    case 'file-anchor': {
      if (!packet.anchor) return null;
      try {
        return createPromptAttachment({
          kind: 'file-anchor',
          anchor: packet.anchor,
          ...(packet.note ? { summary: packet.note } : {}),
        });
      } catch {
        return null;
      }
    }
    case 'file-ref': {
      if (!packet.fileRef) return null;
      try {
        return createPromptAttachment({
          kind: 'file-ref',
          ref: packet.fileRef,
          ...(packet.note ? { summary: packet.note } : {}),
        });
      } catch {
        return null;
      }
    }
    // C4: `note` packets carry no attachable ref — the body rides the inbox
    // message `text`, never the prompt attachment list. Reserved kinds have no
    // attachment surface in MVP. `artifact-ref` has no `PromptAttachment`
    // surface yet either (#898) — its prompt projection is deferred.
    case 'note':
    case 'diff-ref':
    case 'log-ref':
    case 'artifact-ref':
    default:
      return null;
  }
}

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

/**
 * Recover the opaque suffix from a `ContextPacketId`, or `null` if `id` is not
 * a well-formed `cp:<suffix>` id. Round-trips `createContextPacketId`.
 */
export function parseContextPacketId(id: string): { suffix: string } | null {
  if (typeof id !== 'string' || !id.startsWith(CONTEXT_PACKET_ID_PREFIX)) {
    return null;
  }
  const encoded = id.slice(CONTEXT_PACKET_ID_PREFIX.length);
  if (encoded.length === 0) return null;
  try {
    const suffix = decodeURIComponent(encoded);
    return hasValue(suffix) ? { suffix } : null;
  } catch {
    return null;
  }
}

/**
 * Recover the opaque suffix from a `SessionInboxMessageId`, or `null` if `id`
 * is not a well-formed `im:<suffix>` id. Round-trips `createInboxMessageId`.
 */
export function parseInboxMessageId(id: string): { suffix: string } | null {
  if (
    typeof id !== 'string' ||
    !id.startsWith(SESSION_INBOX_MESSAGE_ID_PREFIX)
  ) {
    return null;
  }
  const encoded = id.slice(SESSION_INBOX_MESSAGE_ID_PREFIX.length);
  if (encoded.length === 0) return null;
  try {
    const suffix = decodeURIComponent(encoded);
    return hasValue(suffix) ? { suffix } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parse / validate
// ---------------------------------------------------------------------------

function isContextPacketKind(value: unknown): value is ContextPacketKind {
  return (
    typeof value === 'string' &&
    (CONTEXT_PACKET_KINDS as readonly string[]).includes(value)
  );
}

function isInboxMessageState(
  value: unknown
): value is SessionInboxMessageState {
  return (
    typeof value === 'string' &&
    (SESSION_INBOX_MESSAGE_STATES as readonly string[]).includes(value)
  );
}

function parseBinding(payload: unknown): ContextPacketBinding | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const binding: ContextPacketBinding = {};
  if (typeof p['workspaceId'] === 'string')
    binding.workspaceId = p['workspaceId'];
  if (typeof p['nodeId'] === 'string') binding.nodeId = p['nodeId'];
  if (typeof p['repoInstanceId'] === 'string') {
    binding.repoInstanceId = p['repoInstanceId'];
  }
  if (typeof p['worktreeInstanceId'] === 'string') {
    binding.worktreeInstanceId = p['worktreeInstanceId'];
  }
  return binding;
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Parse an unknown payload into a `ContextPacket`, returning `null` on any
 * validation failure (mirrors `parseFileResourceRef`/`parsePromptAttachment`).
 * Kind-specific shape is enforced:
 *   - `file-anchor` requires a valid `anchor` (`parseAnchorRef`).
 *   - `file-ref` requires a valid whole-file `fileRef` (`parseFileResourceRef`).
 *   - `note` requires a non-empty `note` body.
 *   - `artifact-ref` requires a valid `artifactRef` (`parseArtifactPacketRef`).
 *   - reserved kinds (`diff-ref`/`log-ref`) parse the envelope but carry no
 *     anchor/ref payload in MVP (#760).
 */
export function parseContextPacket(payload: unknown): ContextPacket | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p['id'] !== 'string' || !parseContextPacketId(p['id']))
    return null;
  if (!isContextPacketKind(p['kind'])) return null;
  if (typeof p['createdBy'] !== 'string' || p['createdBy'].length === 0) {
    return null;
  }
  if (
    typeof p['createdAt'] !== 'string' ||
    !ISO_TIMESTAMP_RE.test(p['createdAt'])
  ) {
    return null;
  }
  const kind = p['kind'];
  const packet: ContextPacket = {
    id: p['id'],
    kind,
    createdBy: p['createdBy'],
    createdAt: p['createdAt'],
  };

  if (kind === 'file-anchor') {
    const anchor = parseAnchorRef(p['anchor']);
    if (!anchor) return null;
    packet.anchor = anchor;
  } else if (kind === 'file-ref') {
    const fileRef = parseFileResourceRef(p['fileRef']);
    if (!fileRef) return null;
    packet.fileRef = fileRef;
  } else if (kind === 'artifact-ref') {
    const artifactRef = parseArtifactPacketRef(p['artifactRef']);
    if (!artifactRef) return null;
    packet.artifactRef = artifactRef;
  } else if (kind === 'note') {
    if (typeof p['note'] !== 'string' || p['note'].trim().length === 0) {
      return null;
    }
  }

  // `note` is the required body for note kind, an optional annotation
  // otherwise. (Already validated above for `note`.)
  if (typeof p['note'] === 'string' && p['note'].length > 0) {
    packet.note = p['note'];
  }
  const binding =
    p['binding'] !== undefined ? parseBinding(p['binding']) : null;
  if (binding && Object.keys(binding).length > 0) {
    packet.binding = binding;
  }
  return packet;
}

/**
 * Parse an unknown payload into a `SessionInboxMessage`, returning `null` on
 * validation failure. Requires at least one target (`targetSessionId` or
 * `targetWorkContextId`), a valid lifecycle `state`, well-formed
 * `contextPacketIds`, and ISO timestamps.
 */
export function parseSessionInboxMessage(
  payload: unknown
): SessionInboxMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p['id'] !== 'string' || !parseInboxMessageId(p['id'])) return null;
  if (!isInboxMessageState(p['state'])) return null;
  if (typeof p['createdBy'] !== 'string' || p['createdBy'].length === 0) {
    return null;
  }
  if (
    typeof p['createdAt'] !== 'string' ||
    !ISO_TIMESTAMP_RE.test(p['createdAt'])
  ) {
    return null;
  }

  const targetSessionId =
    typeof p['targetSessionId'] === 'string' ? p['targetSessionId'] : undefined;
  const targetWorkContextId =
    typeof p['targetWorkContextId'] === 'string'
      ? p['targetWorkContextId']
      : undefined;
  // CHECK constraint mirror: at least one target is required.
  if (!targetSessionId && !targetWorkContextId) return null;

  if (!Array.isArray(p['contextPacketIds'])) return null;
  const contextPacketIds: ContextPacketId[] = [];
  for (const raw of p['contextPacketIds']) {
    if (typeof raw !== 'string' || !parseContextPacketId(raw)) return null;
    contextPacketIds.push(raw);
  }

  const message: SessionInboxMessage = {
    id: p['id'],
    contextPacketIds,
    state: p['state'],
    createdBy: p['createdBy'],
    createdAt: p['createdAt'],
  };
  if (targetSessionId) message.targetSessionId = targetSessionId;
  if (targetWorkContextId) message.targetWorkContextId = targetWorkContextId;
  if (typeof p['text'] === 'string' && p['text'].length > 0) {
    message.text = p['text'];
  }
  for (const field of [
    'deliveredAt',
    'acknowledgedAt',
    'resolvedAt',
    'ignoredAt',
  ] as const) {
    const value = p[field];
    if (typeof value === 'string' && ISO_TIMESTAMP_RE.test(value)) {
      message[field] = value;
    }
  }
  if (
    typeof p['transitionedBy'] === 'string' &&
    p['transitionedBy'].length > 0
  ) {
    message.transitionedBy = p['transitionedBy'];
  }
  return message;
}

/** Alias matching the #758 task naming (`parseInboxMessage`). */
export const parseInboxMessage = parseSessionInboxMessage;

// ---------------------------------------------------------------------------
// Anchor resolution (the #766 primitive — signature only)
// ---------------------------------------------------------------------------

/**
 * Resolve an `AnchorRef`'s `AnchorState` against the file's CURRENT contents.
 *
 * PURE comparison primitive (#766). It performs NO I/O: `captured` is the ref
 * as stored on the packet and `current` is a freshly minted `FileResourceRef`
 * for the same location, obtained by the IMPURE caller in
 * `server/anchor-resolution.ts` by re-stat/re-read through the node File RPC
 * layer UNDER CAPABILITY (`rpc:fs:read`/`rpc:fs:stat`) — never a local
 * `fs.stat` (a federated session's file lives on its own node).
 *
 * Resolution rule:
 *   - `current === null`                              → `'missing'`
 *   - identity mismatch (`!fileResourceRefEquals`)    → `'missing'`
 *   - identity match + freshness decorations drift    → `'stale'`
 *   - identity match + freshness decorations match    → `'unchanged'`
 *   - identity match + freshness UNKNOWABLE (C3)      → `'stale'` (conservative)
 *
 * Freshness comparison precedence (identity already established):
 *   1. If BOTH refs carry `sha256` → exact content equality: equal =>
 *      `'unchanged'`, differ => `'stale'`. sha256 is authoritative.
 *   2. Else if BOTH refs carry `mtimeMs` → mtime equality: equal =>
 *      `'unchanged'`, differ => `'stale'`. Weaker than sha but still a real
 *      freshness signal when content hashing was not performed.
 *   3. Otherwise freshness is UNKNOWABLE. This is the C3 case: the captured
 *      anchor was minted WITHOUT read-intent freshness (e.g. a `stat`/`list`
 *      ref with no sha256 and no comparable mtime), so the resolver CANNOT
 *      prove the range still points at the captured `quote`. We return the
 *      CONSERVATIVE `'stale'` rather than silently asserting `'unchanged'` —
 *      an anchored packet should be minted with `read` intent so freshness is
 *      always comparable; absent that, the consumer is warned the range may
 *      have drifted.
 *
 * Identity (`fileResourceRefEquals`) is the load-bearing reuse from
 * `file-resource-ref.ts`: it excludes the freshness decorations, so a
 * re-minted ref for the same file is "the same anchor location" even though
 * its sha256/mtime/capturedAt differ — exactly the comparison the resolver
 * needs.
 *
 * `'shifted'` (range moved but quote relocatable elsewhere in the file) is
 * EXPLICITLY DEFERRED (ADR-019); a moved range surfaces as `'stale'`.
 */
export function resolveAnchorState(
  captured: AnchorRef,
  current: FileResourceRef | null
): AnchorState {
  if (!current) return 'missing';
  if (!fileResourceRefEquals(captured.ref, current)) return 'missing';

  const capturedSha = captured.ref.sha256;
  const currentSha = current.sha256;
  // 1. sha256 is authoritative when both sides carry it.
  if (capturedSha !== undefined && currentSha !== undefined) {
    return capturedSha === currentSha ? 'unchanged' : 'stale';
  }

  // 2. Fall back to mtime when both sides carry it.
  const capturedMtime = captured.ref.mtimeMs;
  const currentMtime = current.mtimeMs;
  if (capturedMtime !== undefined && currentMtime !== undefined) {
    return capturedMtime === currentMtime ? 'unchanged' : 'stale';
  }

  // 3. C3: freshness is unknowable (captured without read-intent freshness, or
  // no comparable decoration). Conservatively report 'stale' — never silently
  // 'unchanged' when we cannot prove the content is unchanged.
  return 'stale';
}
