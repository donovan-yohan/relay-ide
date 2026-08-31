// #760 / Epic #757 (ADR-019): file-range context source adapter.
//
// TWO RESPONSIBILITIES, both for the `file-anchor` ContextPacket kind only
// (MVP scope — diff-range / terminal-range / markdown adapters are deferred):
//
//   1. EXPANSION — given a `file-anchor` packet, expand its `AnchorRef` (a
//      `FileResourceRef` location + line/byte range + captured `quote`) into the
//      referenced CONTENT SLICE for consumption, bounded by the range and a hard
//      size cap, read through the node File RPC layer UNDER CAPABILITY
//      (`rpc:fs:read`). `expandFileRange` first resolves the anchor's
//      `AnchorState` (#766) and REFUSES to serve current-looking content for a
//      `stale`/`missing` anchor — a drifted range surfaces `stale` and the
//      ADVISORY captured `quote`, never freshly-read bytes presented as the
//      anchored selection. This is the load-bearing correctness rule from the
//      issue: "a stale anchor expansion must surface `stale`, NOT serve
//      wrong/old content as current."
//
//   2. DECORATION — `decoratePacketAnchorState` is the runtime consumer #759
//      flagged as missing: it derives an anchor packet's `AnchorState` at READ
//      time (via the #766 resolver registry) and attaches it as a NON-STORED
//      `anchorState` field so `context.get` / `inbox.get` / `inbox.list` can
//      surface staleness without ever persisting a lifecycle bit (ADR-019 rule
//      #3: `AnchorState` is always derived, never stored).
//
// C1 (fugu/path security): we NEVER `decodeURIComponent` the stored
// `AnchorRef.ref.path`. The stored path was validated + normalized at mint time
// (`createFileResourceRef` → POSIX normalize, no `..`); it is a literal absolute
// path, not a URL component. The File RPC seam receives it VERBATIM. The hub
// File RPC route owns root-containment + traversal enforcement (#759 fetcher
// reuses `normalizeHubFileRpcRequest`); this adapter adds no path rewriting.

import {
  resolveAnchorState,
  type AnchorRef,
  type AnchorState,
  type ContextPacket,
} from '../../shared/context-packet.js';
import {
  createFileResourceRef,
  type FileResourceRef,
} from '../../shared/file-resource-ref.js';
import type { NodeId } from '../../shared/identity.js';
import {
  ANCHOR_RESOLUTION_CAPABILITY,
  resolveAnchorWithRegisteredFetcher,
  type ResolveAnchorOutcome,
} from '../anchor-resolution.js';
import type { RelayCapabilityBit } from '../../shared/security-policy.js';

// ---------------------------------------------------------------------------
// Hard bounds for an expanded slice.
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the number of lines a single file-range expansion returns.
 * A line range wider than this is clamped (and the result flagged
 * `truncatedLines`) so an enormous selection cannot return an unbounded slice.
 */
export const FILE_RANGE_MAX_EXPANDED_LINES = 2_000;

/**
 * Hard ceiling on the number of UTF-8 bytes a single file-range expansion
 * returns, independent of the line count. Mirrors the File RPC read ceiling so
 * a few very long lines cannot blow the budget.
 */
export const FILE_RANGE_MAX_EXPANDED_BYTES = 64 * 1024;

const SLICE_ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------
// Content fetch seam (File-RPC-under-capability `read`).
// ---------------------------------------------------------------------------

/**
 * Target a content fetch resolves on the OWNING node. Mirrors the #766
 * `AnchorFileFetchTarget` location identity, plus the `maxBytes`/`maxLines`
 * bounds the read must honour. `path` is the stored, already-validated absolute
 * path — passed VERBATIM (C1: never `decodeURIComponent`'d here).
 */
export interface FileRangeContentTarget {
  nodeId: NodeId;
  path: string;
  maxBytes: number;
  maxLines?: number;
  repoBinding?: FileResourceRef['repoBinding'];
}

/**
 * Result of a File-RPC-under-capability `read` for an anchor's content. Returns
 * the (bounded) UTF-8 text plus the freshness decorations needed to mint a
 * `current` `FileResourceRef` for the #766 comparison, so a single read both
 * expands the slice AND resolves staleness without a second round trip.
 *
 *   - `found: false` — node reported the path gone / not a regular file → the
 *     anchor is `missing`.
 *   - `found: true`  — `content` is the bounded UTF-8 read; `contentSha256` is
 *     present only when the read was NOT truncated (a truncated read cannot
 *     yield a trustworthy whole-file hash — see `anchor-file-fetcher.ts`).
 *
 * `grantedCapability` echoes the capability the fetch was authorized for; the
 * adapter asserts it matches `ANCHOR_RESOLUTION_CAPABILITY` (C1 enforcement,
 * mirroring `resolveAnchor`).
 */
export type FileRangeContentResult =
  | { found: false; grantedCapability: RelayCapabilityBit }
  | {
      found: true;
      grantedCapability: RelayCapabilityBit;
      content: string;
      bytesRead?: number;
      mtimeMs?: number;
      size?: number;
      contentSha256?: string;
      truncatedBytes?: boolean;
    };

/**
 * Injected File-RPC-under-capability content fetch. Production wires this to
 * the hub File RPC `fs.read` path behind `evaluateHubPolicy` (see
 * `createAnchorContentFetcher` in `anchor-file-fetcher.ts`); tests mock it.
 * Returns `null` when the read could not be authorized/performed at all
 * (distinct from `found: false`).
 */
export type FileRangeContentFetcher = (
  target: FileRangeContentTarget
) => Promise<FileRangeContentResult | null>;

// ---------------------------------------------------------------------------
// Expansion result.
// ---------------------------------------------------------------------------

/**
 * The outcome of expanding a `file-anchor` packet. `state` is ALWAYS present
 * (derived). `content` is populated ONLY when `state === 'unchanged'` — a
 * `stale`/`missing`/unavailable anchor never carries content presented as the
 * current anchored selection (the issue's correctness rule). For a `stale`
 * anchor the advisory captured `quote` is echoed under `capturedQuote` so a
 * consumer can still show what WAS selected, clearly labelled stale.
 */
export interface FileRangeExpansion {
  state: AnchorState | 'unavailable';
  /** The bounded current slice. Present only when `state === 'unchanged'`. */
  content?: string;
  /** True when the slice was clamped by the line/byte cap. */
  truncated?: boolean;
  /** The 1-based inclusive line range that was expanded (echoed for the UI). */
  lineRange?: { startLine: number; endLine: number };
  /** Advisory captured quote (NEVER current). Echoed for stale/missing anchors. */
  capturedQuote?: string;
}

export interface ExpandFileRangeDeps {
  fetchContent: FileRangeContentFetcher;
  /**
   * Resolve the anchor's `AnchorState`. Defaults to the hub-registered #766
   * resolver; injectable for tests. `null` return ⇒ resolution unavailable.
   */
  resolveState?: (anchor: AnchorRef) => Promise<ResolveAnchorOutcome | null>;
}

// ---------------------------------------------------------------------------
// Slice helpers (pure).
// ---------------------------------------------------------------------------

/**
 * Slice `content` to the anchor's 1-based inclusive line range, clamped to
 * `FILE_RANGE_MAX_EXPANDED_LINES` lines and `FILE_RANGE_MAX_EXPANDED_BYTES`
 * bytes. Returns the slice plus whether it was clamped. When no `lineRange` is
 * set (byte-range-only anchor) the whole bounded read is returned (byte-range
 * slicing on top of an already-truncated read is deferred — MVP is line-range).
 */
export function sliceLineRange(
  content: string,
  lineRange: { startLine: number; endLine: number } | undefined
): { slice: string; truncated: boolean } {
  if (!lineRange) {
    return clampBytes(content);
  }
  const lines = content.split('\n');
  // 1-based inclusive → 0-based half-open. Clamp to available lines.
  const startIdx = Math.max(0, lineRange.startLine - 1);
  if (startIdx >= lines.length) {
    // The captured range starts past EOF — nothing to show in-range.
    return { slice: '', truncated: false };
  }
  const requestedCount = lineRange.endLine - lineRange.startLine + 1;
  const cappedCount = Math.min(requestedCount, FILE_RANGE_MAX_EXPANDED_LINES);
  const endIdx = Math.min(lines.length, startIdx + cappedCount);
  const selected = lines.slice(startIdx, endIdx);
  const truncatedByLineCap = requestedCount > FILE_RANGE_MAX_EXPANDED_LINES;
  const byteClamped = clampBytes(selected.join('\n'));
  return {
    slice: byteClamped.slice,
    truncated: truncatedByLineCap || byteClamped.truncated,
  };
}

/** Clamp a string to `FILE_RANGE_MAX_EXPANDED_BYTES` UTF-8 bytes. */
function clampBytes(value: string): { slice: string; truncated: boolean } {
  const encoded = SLICE_ENCODER.encode(value);
  if (encoded.length <= FILE_RANGE_MAX_EXPANDED_BYTES) {
    return { slice: value, truncated: false };
  }
  const decoder = new TextDecoder();
  const sliced = decoder.decode(encoded.slice(0, FILE_RANGE_MAX_EXPANDED_BYTES));
  // Drop a trailing replacement char produced by cutting mid-codepoint.
  return { slice: sliced.replace(/�+$/u, ''), truncated: true };
}

/** Build the bounded content target from a captured anchor. */
function contentTargetFor(anchor: AnchorRef): FileRangeContentTarget {
  const ref = anchor.ref;
  // The read is bounded by the anchor's own maxBytes when set, else the hard
  // expansion ceiling. Either way it never exceeds the File RPC read ceiling.
  const maxBytes = Math.min(
    ref.maxBytes ?? FILE_RANGE_MAX_EXPANDED_BYTES,
    FILE_RANGE_MAX_EXPANDED_BYTES
  );
  // A line-range anchor reads enough lines to cover the captured range (clamped
  // to the hard line ceiling) so the slice is present in the read window.
  const maxLines = anchor.lineRange
    ? Math.min(anchor.lineRange.endLine, FILE_RANGE_MAX_EXPANDED_LINES)
    : undefined;
  return {
    nodeId: ref.nodeId,
    path: ref.path, // C1: verbatim, never decodeURIComponent'd.
    maxBytes,
    ...(maxLines !== undefined ? { maxLines } : {}),
    ...(ref.repoBinding ? { repoBinding: ref.repoBinding } : {}),
  };
}

/**
 * Mint the `current` `FileResourceRef` from a content fetch so the pure #766
 * resolver can compare it to the captured ref. Preserves the captured ref's
 * identity carriers (`intent`, `maxBytes`, `repoBinding`) so
 * `fileResourceRefEquals` treats them as the same location.
 */
function currentRefFromContent(
  captured: AnchorRef,
  fetched: Extract<FileRangeContentResult, { found: true }>
): FileResourceRef | null {
  const ref = captured.ref;
  try {
    return createFileResourceRef({
      nodeId: ref.nodeId,
      path: ref.path,
      intent: ref.intent,
      ...(fetched.size !== undefined ? { size: fetched.size } : {}),
      ...(fetched.contentSha256 !== undefined ? { sha256: fetched.contentSha256 } : {}),
      ...(fetched.mtimeMs !== undefined ? { mtimeMs: fetched.mtimeMs } : {}),
      ...(ref.maxBytes !== undefined ? { maxBytes: ref.maxBytes } : {}),
      ...(ref.repoBinding ? { repoBinding: ref.repoBinding } : {}),
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Expansion.
// ---------------------------------------------------------------------------

/**
 * Expand a `file-anchor`'s `AnchorRef` into a bounded content slice IF AND ONLY
 * IF the anchor still resolves `unchanged`. The flow:
 *
 *   1. Fetch the bounded current content through the File-RPC-under-capability
 *      seam (the only blessed read path; C1: never a local stat/read on the hub
 *      for a federated node's file). A `null` fetch ⇒ `unavailable`; a
 *      `found:false` fetch ⇒ `missing`.
 *   2. Assert the fetch acknowledged `ANCHOR_RESOLUTION_CAPABILITY` (C1 defense
 *      in depth — a mis-wired fetcher that skipped the gate throws).
 *   3. Mint a `current` ref from the read and derive `AnchorState` via the PURE
 *      #766 resolver (`resolveState` override may substitute an authoritative
 *      sha-based resolution; by default we compare the read-derived ref).
 *   4. ONLY when `unchanged` do we return the sliced content. For `stale` /
 *      `missing` we return the state + advisory captured `quote` and NO current
 *      content — never present drifted bytes as the anchored selection.
 */
export async function expandFileRange(
  anchor: AnchorRef,
  deps: ExpandFileRangeDeps
): Promise<FileRangeExpansion> {
  const target = contentTargetFor(anchor);
  const fetched = await deps.fetchContent(target);

  if (fetched === null) {
    return baseExpansion(anchor, 'unavailable');
  }
  if (fetched.grantedCapability !== ANCHOR_RESOLUTION_CAPABILITY) {
    throw new Error(
      `file-range content fetch was authorized for "${fetched.grantedCapability}" but requires "${ANCHOR_RESOLUTION_CAPABILITY}"`
    );
  }
  if (!fetched.found) {
    return baseExpansion(anchor, 'missing');
  }

  // Derive state. An injected resolver wins (it may run an authoritative
  // sha-vs-sha resolution through the registered #766 fetcher); otherwise we
  // compare the ref minted from this very read.
  let state: AnchorState;
  if (deps.resolveState) {
    const outcome = await deps.resolveState(anchor);
    if (outcome === null) return baseExpansion(anchor, 'unavailable');
    state = outcome.state;
  } else {
    const current = currentRefFromContent(anchor, fetched);
    state = resolveAnchorState(anchor, current);
  }

  if (state !== 'unchanged') {
    // Stale or missing: surface the state + advisory captured quote, NEVER the
    // freshly-read bytes presented as the current anchored selection.
    return baseExpansion(anchor, state);
  }

  const { slice, truncated } = sliceLineRange(fetched.content, anchor.lineRange);
  const expansion: FileRangeExpansion = {
    state: 'unchanged',
    content: slice,
    truncated: truncated || fetched.truncatedBytes === true,
  };
  if (anchor.lineRange) expansion.lineRange = { ...anchor.lineRange };
  return expansion;
}

function baseExpansion(
  anchor: AnchorRef,
  state: AnchorState | 'unavailable'
): FileRangeExpansion {
  const expansion: FileRangeExpansion = { state };
  if (anchor.lineRange) expansion.lineRange = { ...anchor.lineRange };
  if (anchor.quote) expansion.capturedQuote = anchor.quote;
  return expansion;
}

// ---------------------------------------------------------------------------
// Decoration (runtime consumer of #766 — the #759-flagged missing piece).
// ---------------------------------------------------------------------------

/**
 * A `ContextPacket` decorated with its DERIVED `AnchorState`. The `anchorState`
 * field is computed at read time and is NEVER persisted (ADR-019 rule #3). Only
 * `file-anchor` packets carry it; everything else is the packet unchanged.
 */
export type DecoratedContextPacket = ContextPacket & {
  /** Derived at read time for `file-anchor` packets. Omitted when unresolved. */
  anchorState?: AnchorState;
};

/**
 * Resolver seam for decoration. Defaults to the hub-registered #766 resolver
 * (`resolveAnchorWithRegisteredFetcher`); injectable for tests. A `null` return
 * means resolution is unavailable (hub not booted / no in-scope session) — the
 * packet is then returned UNDECORATED rather than guessing a state.
 */
export type AnchorStateResolver = (
  anchor: AnchorRef
) => Promise<ResolveAnchorOutcome | null>;

/**
 * Decorate a single packet with its derived `AnchorState`. Non-`file-anchor`
 * packets (and `file-anchor` packets whose resolution is unavailable) pass
 * through unchanged. NEVER mutates the input.
 */
export async function decoratePacketAnchorState(
  packet: ContextPacket,
  resolve: AnchorStateResolver = resolveAnchorWithRegisteredFetcher
): Promise<DecoratedContextPacket> {
  if (packet.kind !== 'file-anchor' || !packet.anchor) return packet;
  const outcome = await resolve(packet.anchor);
  if (outcome === null) return packet; // resolution unavailable → undecorated.
  return { ...packet, anchorState: outcome.state };
}

/**
 * Decorate many packets concurrently. Order-preserving. Used by `inbox.list`
 * where a message references several packets.
 */
export async function decoratePacketsAnchorState(
  packets: readonly ContextPacket[],
  resolve: AnchorStateResolver = resolveAnchorWithRegisteredFetcher
): Promise<DecoratedContextPacket[]> {
  return Promise.all(packets.map((p) => decoratePacketAnchorState(p, resolve)));
}

// ---------------------------------------------------------------------------
// Hub-level content-fetcher registration (mirrors the #759 anchor-fetcher
// registry). The production `FileRangeContentFetcher` is built once at hub boot
// from the live registry/link/envelope handles and registered here so the
// `expandFileRange` consumer can retrieve it without threading deps through
// every call site.
// ---------------------------------------------------------------------------

let registeredContentFetcher: FileRangeContentFetcher | null = null;

/** Register the hub's production file-range content fetcher (once at boot). */
export function registerFileRangeContentFetcher(
  fetcher: FileRangeContentFetcher
): void {
  registeredContentFetcher = fetcher;
}

/**
 * Expand a `file-anchor` packet using the hub-registered content fetcher and
 * anchor-state resolver. Returns `null` when no content fetcher is registered
 * (hub not booted) so the caller can distinguish "unavailable" from a resolved
 * state. Non-`file-anchor` packets (or anchor packets with no `anchor`) also
 * return `null` — expansion is file-anchor-only in MVP.
 */
export async function expandFileRangePacket(
  packet: ContextPacket
): Promise<FileRangeExpansion | null> {
  if (packet.kind !== 'file-anchor' || !packet.anchor) return null;
  if (!registeredContentFetcher) return null;
  return expandFileRange(packet.anchor, { fetchContent: registeredContentFetcher });
}
