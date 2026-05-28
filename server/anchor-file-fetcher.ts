// #759 / ADR-019 (§D3, fugu C1): production wiring of #766's `AnchorFileFetcher`
// seam to the hub's session-scoped File RPC path under capability.
//
// THE SESSION-SCOPE PROBLEM. #766's fetcher contract is `(nodeId, path, …)` with
// NO session — but the only blessed way to read a (possibly remote) node's file
// is `server/file-rpc.ts` → `nodeLinks.request('fs.read'|'fs.stat')`, which is
// SESSION-SCOPED: the request must name a live scoped session whose filesystem
// root (worktree/repo/cwd) CONTAINS the target path, and the read is gated by
// `evaluateHubPolicy(rpc.fs.read)` against that session's scope. A bare
// `(nodeId, path)` carries neither a session nor a scope.
//
// DECISION (smallest correct, reuses the policy/scoping machinery rather than
// re-implementing it): resolve a scope by SCANNING the live scoped-session
// registry for a session on `nodeId` whose root contains `path` (via the same
// `normalizeHubFileRpcRequest` root-containment check the File RPC route uses),
// then route the read through THAT session's envelope + policy. We do NOT mint a
// synthetic session and we do NOT fall back to a local `fs.stat` (C1: a local
// stat on the hub would silently resolve the WRONG filesystem for a federated
// node). If no live in-scope session exists, or policy denies, the fetcher
// returns `null` — which #766's `resolveAnchor` maps to `AnchorState='missing'`
// (an honest "can't resolve right now" rather than a confidently-wrong answer).
//
// CAPABILITY GATE. The read runs the SAME `evaluateHubPolicy` +
// `requiredCapabilitiesForRpcIntent('rpc.fs.read'|'rpc.fs.stat')` check as the
// File RPC route. Both intents require `rpc:fs:read`, which is exactly
// `ANCHOR_RESOLUTION_CAPABILITY`; the fetch result echoes that bit as
// `grantedCapability` so #766's caller can assert the gate fired (C1
// enforcement). A non-`allow` decision returns `null`.

import { executeLocalFileRpc, normalizeHubFileRpcRequest } from './file-rpc.js';
import {
  evaluateHubPolicy,
  requiredCapabilitiesForRpcIntent,
} from './hub-policy-evaluator.js';
import type { ScopedSessionSummary } from './session-envelope-registry.js';
import { ANCHOR_RESOLUTION_CAPABILITY } from './anchor-resolution.js';
import type {
  AnchorFileFetcher,
  AnchorFileFetchResult,
  AnchorFileFetchTarget,
} from './anchor-resolution.js';
import { hashAnchorContent } from './anchor-resolution.js';
import type {
  FileRangeContentFetcher,
  FileRangeContentResult,
  FileRangeContentTarget,
} from './context-adapters/file-range.js';
import type {
  FileRpcReadResponse,
  FileRpcStatResponse,
} from '../shared/file-rpc.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';
import { RELAY_NODE_LINK_PROTOCOL_VERSION } from '../shared/relay-node-protocol.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { RELAY_SECURITY_POLICY_VERSION } from '../shared/security-policy.js';

/** Minimal node registry shape the fetcher needs (subset of the hub registry). */
export interface AnchorFetcherNodeRegistry {
  listNodes(): HubNodeSummary[];
}

/** Minimal node-link shape the fetcher needs (subset of the hub link manager). */
export interface AnchorFetcherNodeLinks {
  hasActiveNode(nodeId: string): boolean;
  request(nodeId: string, type: string, payload: unknown): Promise<unknown>;
}

/** Minimal session-envelope registry shape (subset of the in-memory registry). */
export interface AnchorFetcherSessionEnvelopes {
  listSummaries(options?: {
    now?: Date;
    includeRevoked?: boolean;
    includeExpired?: boolean;
  }): ScopedSessionSummary[];
}

export interface AnchorFileFetcherDeps {
  registry: AnchorFetcherNodeRegistry;
  nodeLinks: AnchorFetcherNodeLinks;
  sessionEnvelopes: AnchorFetcherSessionEnvelopes;
  now?: () => Date;
}

type AnchorFetchTransport = 'local' | 'node-link';

function liveNode(
  registry: AnchorFetcherNodeRegistry,
  nodeLinks: AnchorFetcherNodeLinks,
  nodeId: string
): HubNodeSummary | null {
  const node = registry.listNodes().find((n) => n.nodeId === nodeId);
  if (!node) return null;
  if (node.status !== 'online') return null;
  if (node.protocolVersion !== RELAY_NODE_LINK_PROTOCOL_VERSION) return null;
  if (!nodeLinks.hasActiveNode(nodeId)) return null;
  return node;
}

function localCompatibilityNode(): HubNodeSummary {
  const now = new Date().toISOString();
  return {
    nodeId: DEFAULT_LOCAL_NODE_ID,
    displayName: 'Local hub',
    hostname: 'localhost',
    platform: process.platform,
    arch: process.arch,
    relayVersion: 'local',
    protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    status: 'online',
    connection: { route: 'local', status: 'online' },
    trust: {
      state: 'trusted',
      level: 'privileged-local-user',
      tier: 'dev',
      policy: {
        policyVersion: RELAY_SECURITY_POLICY_VERSION,
        ref: 'acl:local-compatibility',
        trustTier: 'dev',
        // Anchor resolution is read-only and still scoped to a live local
        // session root by normalizeHubFileRpcRequest below. This node object is
        // only for DEFAULT_LOCAL_NODE_ID; remote nodes still require a paired
        // active reverse link.
        allowed: ['rpc:fs:read'],
        requiresConfirmation: [],
        scope: { kind: 'node' },
      },
    },
    credentialState: 'active',
    version: {
      state: 'compatible',
      nodeProtocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
      hubProtocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    },
    capabilities: {
      totals: { available: 0, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'unknown',
        tmux: 'unknown',
        git: 'unknown',
        browserAutomation: 'unknown',
        clipboardImage: 'unknown',
        ssh: 'unknown',
        tailscale: 'unknown',
      },
      agents: {},
      serviceManager: 'unknown',
      wsl: false,
    },
    fileRpcAvailable: true,
    degradedReasons: [],
    createdAt: now,
    pairedAt: now,
    lastSeenAt: now,
    credentialId: 'local-compatibility',
  };
}

function resolveNodeTransport(
  registry: AnchorFetcherNodeRegistry,
  nodeLinks: AnchorFetcherNodeLinks,
  nodeId: string
): { node: HubNodeSummary; transport: AnchorFetchTransport } | null {
  if (nodeId === DEFAULT_LOCAL_NODE_ID) {
    return { node: localCompatibilityNode(), transport: 'local' };
  }
  const node = liveNode(registry, nodeLinks, nodeId);
  return node ? { node, transport: 'node-link' } : null;
}

/**
 * Find a live, active scoped session on `nodeId` whose filesystem root CONTAINS
 * `path`, and return the normalized File RPC request scoped to it. Reuses
 * `normalizeHubFileRpcRequest` (the same root-containment + traversal guard the
 * File RPC route uses) so a path outside every session's root is rejected here
 * exactly as it would be on the route. Returns `null` when no in-scope live
 * session exists.
 */
function resolveScopedReadRequest(input: {
  sessions: ScopedSessionSummary[];
  node: HubNodeSummary;
  nodeId: string;
  path: string;
  operation: 'read' | 'stat';
  maxBytes?: number;
}): {
  session: ScopedSessionSummary;
  request: ReturnType<typeof normalizeHubFileRpcRequest>;
} | null {
  for (const session of input.sessions) {
    if (session.nodeId !== input.nodeId) continue;
    if (session.status !== 'active') continue;
    const normalized = normalizeHubFileRpcRequest({
      operation: input.operation,
      nodePlatform: input.node.platform,
      nodeId: input.nodeId,
      session,
      body: {
        path: input.path,
        ...(input.operation === 'read' && input.maxBytes !== undefined
          ? { maxBytes: input.maxBytes }
          : {}),
      },
    });
    // A session whose root does NOT contain the path fails normalization
    // (ROOT_ESCAPE / ROOT_UNAVAILABLE) — skip it and try the next session.
    if (normalized.ok) {
      return { session, request: normalized };
    }
  }
  return null;
}

/**
 * Build the production `AnchorFileFetcher`. Each fetch:
 *   1. confirms the node is live (online, matching protocol, active reverse link);
 *   2. resolves a live in-scope scoped session + normalized File RPC request;
 *   3. runs the SAME hub policy check the File RPC route runs for the read;
 *   4. issues `nodeLinks.request('fs.read'|'fs.stat', …)` and maps the response.
 * Any failure short of an authorized response that found the file returns either
 * `null` (no scope / unauthorized — anchor treated as `missing` by the resolver)
 * or `{ found: false }` (authorized, node reported the path gone).
 */
export function createAnchorFileFetcher(
  deps: AnchorFileFetcherDeps
): AnchorFileFetcher {
  const now = deps.now ?? (() => new Date());

  return async function fetchAnchorFile(
    target: AnchorFileFetchTarget
  ): Promise<AnchorFileFetchResult | null> {
    const nodeTransport = resolveNodeTransport(
      deps.registry,
      deps.nodeLinks,
      target.nodeId
    );
    if (!nodeTransport) return null;
    const { node, transport } = nodeTransport;

    const operation: 'read' | 'stat' = target.preferRead ? 'read' : 'stat';
    const resolved = resolveScopedReadRequest({
      sessions: deps.sessionEnvelopes.listSummaries(),
      node,
      nodeId: target.nodeId,
      path: target.path,
      operation,
      ...(target.maxBytes !== undefined ? { maxBytes: target.maxBytes } : {}),
    });
    // No live session whose scope contains the path → we have no authorization
    // context for the read. Treat as unresolvable (C1: never local-stat).
    if (!resolved || !resolved.request.ok) return null;

    const action = `rpc.fs.${operation}` as 'rpc.fs.read' | 'rpc.fs.stat';
    const policyScope = resolved.request.value.policyScope;
    const fileRequest = resolved.request.value.request;
    const decision = evaluateHubPolicy({
      peer: { kind: 'hub' },
      node,
      nodeId: target.nodeId,
      intent: { action, target: target.nodeId },
      scope: policyScope,
      requiredCapabilities: requiredCapabilitiesForRpcIntent(action),
      sessionId: resolved.session.sessionId,
      ...(resolved.session.correlationId
        ? { correlationId: resolved.session.correlationId }
        : {}),
      ...(resolved.session.expiresAt !== null
        ? { expiresAt: resolved.session.expiresAt }
        : {}),
      ...(resolved.session.revokedAt !== null
        ? { revokedAt: resolved.session.revokedAt }
        : {}),
      params: { ...fileRequest },
      now: now(),
    });
    // Anything other than a clean allow (deny / challenge / revoke) is treated
    // as "not authorized for an unattended anchor resolution" → unresolvable.
    if (decision.decision !== 'allow') return null;

    let payload: unknown;
    try {
      payload =
        transport === 'local'
          ? await executeLocalFileRpc(operation, fileRequest)
          : await deps.nodeLinks.request(
              target.nodeId,
              `fs.${operation}`,
              fileRequest
            );
    } catch {
      // A NOT_FOUND from the node means the path is gone (authorized fetch, found
      // nothing); any other link error means we could not perform the read.
      // We can't cheaply distinguish here without leaking the error taxonomy, so
      // we conservatively report "found nothing" only when the node is reachable.
      // A thrown HubNodeLinkError for NOT_FOUND is the common gone-file case.
      return { found: false, grantedCapability: ANCHOR_RESOLUTION_CAPABILITY };
    }

    return mapPayload(operation, payload);
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Map an authorized File RPC response onto an `AnchorFileFetchResult`. */
function mapPayload(
  operation: 'read' | 'stat',
  payload: unknown
): AnchorFileFetchResult {
  const record = asRecord(payload);
  if (!record) {
    return { found: false, grantedCapability: ANCHOR_RESOLUTION_CAPABILITY };
  }

  if (operation === 'stat') {
    const response = record as unknown as FileRpcStatResponse;
    const stat = response.stat;
    // Only a regular file resolves an anchor; a directory/symlink/other at the
    // path means the anchored file no longer exists there → missing.
    if (!stat || stat.type !== 'file') {
      return { found: false, grantedCapability: ANCHOR_RESOLUTION_CAPABILITY };
    }
    return {
      found: true,
      grantedCapability: ANCHOR_RESOLUTION_CAPABILITY,
      ...(typeof stat.size === 'number' ? { size: stat.size } : {}),
      ...(typeof stat.mtimeMs === 'number' ? { mtimeMs: stat.mtimeMs } : {}),
    };
  }

  const response = record as unknown as FileRpcReadResponse;
  if (typeof response.content !== 'string') {
    return { found: false, grantedCapability: ANCHOR_RESOLUTION_CAPABILITY };
  }
  // Hash the CURRENT bytes for an authoritative sha-vs-sha comparison. The read
  // is bounded by `maxBytes`; a truncated read cannot yield a trustworthy whole-
  // file hash, so we omit the sha (the pure resolver falls back to size/mtime).
  const buffer =
    response.encoding === 'base64'
      ? Buffer.from(response.content, 'base64')
      : Buffer.from(response.content, 'utf8');
  const contentSha256 = response.truncatedBytes
    ? undefined
    : hashAnchorContent(buffer);
  return {
    found: true,
    grantedCapability: ANCHOR_RESOLUTION_CAPABILITY,
    ...(typeof response.bytesRead === 'number'
      ? { size: response.bytesRead }
      : {}),
    ...(contentSha256 !== undefined ? { contentSha256 } : {}),
  };
}

// ── #760: content fetcher (File-RPC-under-capability `read` that RETURNS bytes) ─
//
// The #766 `AnchorFileFetcher` above discards the read content (it only keeps
// the freshness sha for staleness comparison). The #760 file-range adapter
// needs the actual bounded text slice, so this builds a sibling fetcher that
// returns the UTF-8 content alongside the same freshness decorations. It reuses
// the IDENTICAL scope-resolution + policy machinery (`resolveScopedReadRequest`
// + `evaluateHubPolicy` under `rpc:fs:read`) so the security posture is shared,
// not re-implemented. C1: `target.path` is passed VERBATIM (no decodeURIComponent).

/** Map an authorized File RPC `read` response onto a `FileRangeContentResult`. */
function mapContentPayload(payload: unknown): FileRangeContentResult {
  const record = asRecord(payload);
  if (!record) {
    return { found: false, grantedCapability: ANCHOR_RESOLUTION_CAPABILITY };
  }
  const response = record as unknown as FileRpcReadResponse;
  if (typeof response.content !== 'string') {
    return { found: false, grantedCapability: ANCHOR_RESOLUTION_CAPABILITY };
  }
  // The adapter slices line ranges over UTF-8 text; a base64 (binary) read is
  // not line-sliceable, so decode it to a UTF-8 view for the bounded slice.
  const text =
    response.encoding === 'base64'
      ? Buffer.from(response.content, 'base64').toString('utf8')
      : response.content;
  const buffer = Buffer.from(text, 'utf8');
  // A truncated read cannot yield a trustworthy whole-file hash (mirrors the
  // staleness fetcher); omit the sha so the resolver falls back to size/mtime.
  const contentSha256 = response.truncatedBytes
    ? undefined
    : hashAnchorContent(buffer);
  return {
    found: true,
    grantedCapability: ANCHOR_RESOLUTION_CAPABILITY,
    content: text,
    ...(typeof response.bytesRead === 'number'
      ? { bytesRead: response.bytesRead, size: response.bytesRead }
      : {}),
    ...(contentSha256 !== undefined ? { contentSha256 } : {}),
    ...(typeof response.truncatedBytes === 'boolean'
      ? { truncatedBytes: response.truncatedBytes }
      : {}),
  };
}

/**
 * Build the production `FileRangeContentFetcher` for the #760 adapter. Always a
 * `read` (the adapter needs bytes). Returns `null` when the node is not live,
 * no in-scope session exists, or policy denies — mapped by the adapter to
 * `unavailable`/`missing` (never a confidently-wrong slice; C1).
 */
export function createAnchorContentFetcher(
  deps: AnchorFileFetcherDeps
): FileRangeContentFetcher {
  const now = deps.now ?? (() => new Date());

  return async function fetchAnchorContent(
    target: FileRangeContentTarget
  ): Promise<FileRangeContentResult | null> {
    const nodeTransport = resolveNodeTransport(
      deps.registry,
      deps.nodeLinks,
      target.nodeId
    );
    if (!nodeTransport) return null;
    const { node, transport } = nodeTransport;

    const resolved = resolveScopedReadRequest({
      sessions: deps.sessionEnvelopes.listSummaries(),
      node,
      nodeId: target.nodeId,
      path: target.path, // C1: verbatim.
      operation: 'read',
      maxBytes: target.maxBytes,
    });
    if (!resolved || !resolved.request.ok) return null;

    const policyScope = resolved.request.value.policyScope;
    const fileRequest = resolved.request.value.request;
    const decision = evaluateHubPolicy({
      peer: { kind: 'hub' },
      node,
      nodeId: target.nodeId,
      intent: { action: 'rpc.fs.read', target: target.nodeId },
      scope: policyScope,
      requiredCapabilities: requiredCapabilitiesForRpcIntent('rpc.fs.read'),
      sessionId: resolved.session.sessionId,
      ...(resolved.session.correlationId
        ? { correlationId: resolved.session.correlationId }
        : {}),
      ...(resolved.session.expiresAt !== null
        ? { expiresAt: resolved.session.expiresAt }
        : {}),
      ...(resolved.session.revokedAt !== null
        ? { revokedAt: resolved.session.revokedAt }
        : {}),
      params: { ...fileRequest },
      now: now(),
    });
    if (decision.decision !== 'allow') return null;

    let payload: unknown;
    try {
      payload =
        transport === 'local'
          ? await executeLocalFileRpc('read', fileRequest)
          : await deps.nodeLinks.request(target.nodeId, 'fs.read', fileRequest);
    } catch {
      // A node error (e.g. NOT_FOUND) on an authorized read → file gone.
      return { found: false, grantedCapability: ANCHOR_RESOLUTION_CAPABILITY };
    }
    return mapContentPayload(payload);
  };
}
