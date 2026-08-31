// #766 / Epic #757 (ADR-019): anchor-resolution service.
//
// `resolveAnchorState` (the PURE comparison primitive) lives in
// `shared/context-packet.ts` because it performs no I/O. THIS module is the
// IMPURE caller: it obtains the `current` `FileResourceRef` for an anchor's
// location and delegates the comparison to the pure resolver.
//
// CORRECTNESS-CRITICAL (ADR-019 §D3, fugu concern C1): the `current` ref MUST
// be minted by re-reading/re-stat-ing through the node File RPC layer UNDER
// CAPABILITY (`rpc:fs:read` for read, `rpc:fs:stat` maps to `rpc:fs:read`),
// NEVER a local `fs.stat`. A federated session's file lives on its OWN node
// (`GlobalSessionId = nodeId:localSessionId`); a local stat on the hub would
// silently resolve the wrong filesystem and return a confidently-wrong
// `AnchorState`. The File RPC path
// (`server/file-rpc.ts` → `nodeLinks.request('fs.read'|'fs.stat', …)` routed
// over `/hub/node-link`, gated by `requiredCapabilitiesForRpcIntent` +
// `evaluateHubPolicy` in `server/hub-node-router.ts`) is the only blessed way
// to read a (possibly remote) node's file. This module depends on that path
// through the injected `AnchorFileFetcher` seam so the policy/scoping
// machinery is reused, not re-implemented, and so the caller stays unit-
// testable with a mock that asserts the capability requirement.

import * as crypto from 'node:crypto';

import {
  createFileResourceRef,
  type FileResourceRef,
} from '../shared/file-resource-ref.js';
import type { NodeId } from '../shared/identity.js';
import {
  resolveAnchorState,
  type AnchorRef,
  type AnchorState,
} from '../shared/context-packet.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';

/**
 * Capability the anchor resolver requires to fetch the `current` ref. Both the
 * `read` and `stat` File RPC intents resolve to `rpc:fs:read` (see
 * `requiredCapabilitiesForRpcIntent` in `server/hub-policy-evaluator.ts`), so a
 * single bit gates anchor resolution. The injected fetcher MUST be invoked
 * behind a hub policy check for this bit; the caller asserts the fetcher
 * acknowledges it (defense in depth, so a mis-wired fetcher that skips the gate
 * is caught rather than silently resolving without authorization).
 */
export const ANCHOR_RESOLUTION_CAPABILITY: RelayCapabilityBit = 'rpc:fs:read';

/**
 * Result of a File-RPC-under-capability fetch for an anchor's location. The
 * fetcher re-resolves `(nodeId, path)` on the OWNING node and returns the
 * freshness decorations needed to mint a `current` `FileResourceRef`:
 *
 *   - `found: false`  — the node reported the path no longer resolves (e.g.
 *     `FILE_RPC_NOT_FOUND`, or the path is no longer a regular file). The
 *     resolver maps this to `AnchorState='missing'`.
 *   - `found: true`   — the path resolved. `mtimeMs`/`size` come from the node
 *     `stat`/`read` response. `contentSha256` is present ONLY when the fetch
 *     was a `read` and the bytes were hashed (use `hashAnchorContent`); a
 *     stat-only fetch leaves it `undefined`, which the pure resolver treats as
 *     the conservative C3 case if the captured ref also lacks sha256.
 *
 * `grantedCapability` echoes the capability the fetcher was authorized for; the
 * caller asserts it matches `ANCHOR_RESOLUTION_CAPABILITY` (C1 enforcement).
 */
export type AnchorFileFetchResult =
  | { found: false; grantedCapability: RelayCapabilityBit }
  | {
      found: true;
      grantedCapability: RelayCapabilityBit;
      mtimeMs?: number;
      size?: number;
      /** sha256 hex of the CURRENT contents, set only on a `read` fetch. */
      contentSha256?: string;
    };

/**
 * The target an anchor resolver hands the fetcher. Carries the location
 * identity (`nodeId`, `path`) plus the `maxBytes`/`repoBinding` decorations so
 * the re-minted `current` ref preserves identity equality with the captured
 * ref (`fileResourceRefEquals` includes `maxBytes`/`repoBinding` in identity).
 */
export interface AnchorFileFetchTarget {
  nodeId: NodeId;
  path: string;
  maxBytes?: number;
  repoBinding?: FileResourceRef['repoBinding'];
  /**
   * Whether the captured anchor carries `read`-intent freshness (a sha256). If
   * it does, the fetcher SHOULD perform a `read` (so the current ref also gets
   * a sha256 for authoritative comparison); otherwise a `stat` suffices.
   */
  preferRead: boolean;
}

/**
 * Injected File-RPC-under-capability fetch. Production wires this to the hub
 * File RPC path (`nodeLinks.request('fs.read' | 'fs.stat', …)` behind
 * `evaluateHubPolicy`); tests mock it. Returns `null` to signal the fetch
 * could not be authorized/performed at all (distinct from `found: false`,
 * which is an authorized fetch that found nothing).
 */
export type AnchorFileFetcher = (
  target: AnchorFileFetchTarget
) => Promise<AnchorFileFetchResult | null>;

/** Hash file content (utf8 or raw bytes) to a sha256 hex digest. */
export function hashAnchorContent(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export interface ResolveAnchorOutcome {
  state: AnchorState;
  /**
   * The freshly minted `current` ref, when the file resolved. `null` when the
   * file is missing or the fetch could not be authorized — mirrors the
   * `current` argument the pure resolver received.
   */
  current: FileResourceRef | null;
}

/**
 * Resolve an anchor's `AnchorState` by fetching its CURRENT ref through the
 * File RPC layer under capability and delegating the comparison to the pure
 * `resolveAnchorState`.
 *
 * Steps:
 *   1. Derive the fetch target from the captured anchor's ref. `preferRead` is
 *      driven by whether the captured ref carries a sha256 (so an authoritative
 *      sha-vs-sha comparison is possible).
 *   2. Call the injected fetcher (the File-RPC-under-capability seam). If it
 *      returns `null` (fetch unauthorized/unavailable) the anchor is treated as
 *      `missing` — we do NOT fall back to a local stat (C1).
 *   3. Assert the fetcher acknowledged the required capability
 *      (`ANCHOR_RESOLUTION_CAPABILITY`); a mismatch throws, surfacing a
 *      mis-wired fetcher rather than resolving without authorization.
 *   4. Re-mint the `current` `FileResourceRef` from the fetch result, carrying
 *      forward the location identity (`nodeId`, `path`, `intent`, `maxBytes`,
 *      `repoBinding`) and the fetched freshness decorations.
 *   5. Delegate to the pure resolver.
 *
 * The captured anchor's `intent` is preserved on the minted `current` ref so
 * `fileResourceRefEquals` (which compares `intent`) treats the two as the same
 * location. The resolver re-reads through RPC and never trusts the captured
 * `quote` for access (it is advisory only — ADR-019).
 */
export async function resolveAnchor(
  captured: AnchorRef,
  fetcher: AnchorFileFetcher
): Promise<ResolveAnchorOutcome> {
  const capturedRef = captured.ref;
  const preferRead = capturedRef.sha256 !== undefined;

  const target: AnchorFileFetchTarget = {
    nodeId: capturedRef.nodeId,
    path: capturedRef.path,
    preferRead,
    ...(capturedRef.maxBytes !== undefined ? { maxBytes: capturedRef.maxBytes } : {}),
    ...(capturedRef.repoBinding ? { repoBinding: capturedRef.repoBinding } : {}),
  };

  const fetched = await fetcher(target);

  // C1: an unauthorized/unavailable fetch resolves to `missing`. We never fall
  // back to a local `fs.stat` — the file lives on the owning node.
  if (fetched === null) {
    return { state: resolveAnchorState(captured, null), current: null };
  }

  // C1 enforcement: the fetch MUST have been gated on the read capability.
  if (fetched.grantedCapability !== ANCHOR_RESOLUTION_CAPABILITY) {
    throw new Error(
      `anchor resolution fetch was authorized for "${fetched.grantedCapability}" but requires "${ANCHOR_RESOLUTION_CAPABILITY}"`
    );
  }

  if (!fetched.found) {
    return { state: resolveAnchorState(captured, null), current: null };
  }

  let current: FileResourceRef;
  try {
    current = createFileResourceRef({
      nodeId: capturedRef.nodeId,
      path: capturedRef.path,
      // Preserve the captured ref's intent so identity equality holds. The
      // freshness decorations below are freshly fetched via RPC.
      intent: capturedRef.intent,
      ...(fetched.size !== undefined ? { size: fetched.size } : {}),
      ...(fetched.contentSha256 !== undefined ? { sha256: fetched.contentSha256 } : {}),
      ...(fetched.mtimeMs !== undefined ? { mtimeMs: fetched.mtimeMs } : {}),
      ...(capturedRef.maxBytes !== undefined ? { maxBytes: capturedRef.maxBytes } : {}),
      ...(capturedRef.repoBinding ? { repoBinding: capturedRef.repoBinding } : {}),
    });
  } catch {
    // A current ref that cannot even be minted (e.g. the node returned a path
    // that no longer normalizes to the same location) is treated as missing.
    return { state: resolveAnchorState(captured, null), current: null };
  }

  return { state: resolveAnchorState(captured, current), current };
}

// ── Hub-level fetcher registration (#759 integration) ───────────────────────
//
// The production `AnchorFileFetcher` (File-RPC-under-capability) is constructed
// once at hub boot in `server/index.ts` from the live registry/link/envelope
// handles. Registering it here keeps those deps off every call site: read-time
// consumers resolve through `resolveAnchorWithRegisteredFetcher` instead of
// holding the fetcher themselves.

let registeredFetcher: AnchorFileFetcher | null = null;

/** Register the hub's production anchor fetcher (called once at boot). */
export function registerAnchorFileFetcher(fetcher: AnchorFileFetcher): void {
  registeredFetcher = fetcher;
}

/**
 * Resolve an anchor using the hub-registered fetcher. Returns `null` when no
 * fetcher is registered (hub not booted) so the caller can distinguish
 * "unavailable" from a resolved `missing`.
 */
export async function resolveAnchorWithRegisteredFetcher(
  captured: AnchorRef
): Promise<ResolveAnchorOutcome | null> {
  if (!registeredFetcher) return null;
  return resolveAnchor(captured, registeredFetcher);
}
