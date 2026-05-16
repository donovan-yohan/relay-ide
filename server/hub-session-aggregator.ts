import type { HubNodeLinkManager } from './hub-node-link.js';
import { HubNodeLinkError } from './hub-node-link.js';
import type { HubNodeRegistry } from './hub-node-registry.js';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';
import {
  sessionEnvelopeRegistry,
  type InMemorySessionEnvelopeRegistry,
} from './session-envelope-registry.js';
import type { SessionSummary } from './types.js';
import { scopedNodeSession, isSessionSummary } from './hub-node-router.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';

/**
 * Returns true when a session is owned by this hub host (local node).
 * Local sessions are always stamped with `DEFAULT_LOCAL_NODE_ID` by
 * `withLocalIdentity()` in `server/sessions.ts`; the `undefined` arm
 * is defensive in case a code path constructs a SessionSummary
 * without going through that helper.
 *
 * Used by the `GET /sessions` branch-refresh loop to gate the
 * `git rev-parse` shellout — running git against a remote node's
 * cwd locally is meaningless.
 */
export function isLocallyOwnedSession(session: SessionSummary): boolean {
  return (
    session.nodeId === undefined || session.nodeId === DEFAULT_LOCAL_NODE_ID
  );
}

// Per-node RPC timeout for sessions.list aggregation. Tighter than the
// 10s HubNodeLinkManager default because GET /sessions is on the
// browser refresh path and slow nodes must not block the response —
// we drop them instead of stalling every other tab.
const PER_NODE_TIMEOUT_MS = 3_000;

export interface AggregateRemoteSessionsDeps {
  registry: HubNodeRegistry;
  nodeLinks: HubNodeLinkManager;
  logger?: Logger;
  sessionEnvelopes?: InMemorySessionEnvelopeRegistry;
  perNodeTimeoutMs?: number;
}

/**
 * Fetch and aggregate `sessions.list` results from every online paired
 * node with an active reverse link. Returns a flat array of
 * `SessionSummary` stamped with `nodeId`. Per-node failures (offline,
 * RPC timeout, malformed payload) are logged and dropped from the
 * result; the aggregate never throws.
 *
 * Offline / stale / revoked nodes are skipped entirely. Sessions from
 * a node that drops mid-fetch effectively disappear from the next
 * `GET /sessions` cycle, matching how routed PTY sockets close on
 * node-link loss.
 */
export async function aggregateRemoteSessions(
  deps: AggregateRemoteSessionsDeps
): Promise<SessionSummary[]> {
  const logger = deps.logger ?? createLogger('hub-session-agg');
  const timeoutMs = deps.perNodeTimeoutMs ?? PER_NODE_TIMEOUT_MS;
  const envelopes = deps.sessionEnvelopes ?? sessionEnvelopeRegistry;

  const candidates = deps.registry
    .listNodes()
    .filter(
      (node) =>
        node.status === 'online' && deps.nodeLinks.hasActiveNode(node.nodeId)
    );

  if (candidates.length === 0) return [];

  const results = await Promise.allSettled(
    candidates.map(async (node) => {
      const sessions = await requestSessionsWithTimeout(
        deps.nodeLinks,
        node.nodeId,
        timeoutMs
      );
      return { nodeId: node.nodeId, sessions };
    })
  );

  const aggregated: SessionSummary[] = [];
  for (let i = 0; i < results.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const result = results[i];
    if (!result) continue;
    if (result.status === 'rejected') {
      const reason =
        result.reason instanceof HubNodeLinkError
          ? `${result.reason.relayNodeError.code}: ${result.reason.relayNodeError.message}`
          : result.reason instanceof Error
            ? result.reason.message
            : String(result.reason ?? 'unknown');
      logger.warn(
        `sessions.list failed for node ${candidate.nodeId}: ${reason}`
      );
      continue;
    }
    for (const session of result.value.sessions) {
      const scoped = scopedNodeSession(result.value.nodeId, session);
      envelopes.upsert(scoped.sessionEnvelope!);
      aggregated.push(scoped);
    }
  }

  return aggregated;
}

async function requestSessionsWithTimeout(
  nodeLinks: HubNodeLinkManager,
  nodeId: string,
  timeoutMs: number
): Promise<SessionSummary[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `node ${nodeId} did not answer sessions.list within ${timeoutMs}ms`
        )
      );
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const payload = await Promise.race([
      nodeLinks.request(nodeId, 'sessions.list', {}),
      timeoutPromise,
    ]);
    return parseSessionListPayload(payload);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseSessionListPayload(payload: unknown): SessionSummary[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const sessions = (payload as Record<string, unknown>)['sessions'];
  if (!Array.isArray(sessions)) return [];
  return sessions.filter(isSessionSummary);
}
