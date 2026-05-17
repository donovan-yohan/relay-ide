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
import type { RelayNodeErrorCode } from '../shared/relay-node-protocol.js';
import type { WorkContextStore } from './work-contexts.js';

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
// browser refresh path and slow nodes must not block the response.
const PER_NODE_TIMEOUT_MS = 3_000;
const REMOTE_SESSION_CACHE_TTL_MS = 60_000;
const CACHEABLE_TYPED_SESSION_LIST_FAILURE_CODES = new Set<RelayNodeErrorCode>([
  'NODE_BUSY',
  'INTERNAL',
]);

export interface RemoteSessionReadModelCache {
  get(nodeId: string, nowMs: number, maxAgeMs: number): SessionSummary[] | null;
  set(nodeId: string, sessions: SessionSummary[], observedAtMs: number): void;
  upsert(nodeId: string, session: SessionSummary, observedAtMs: number): void;
  clear(nodeId: string): void;
}

interface CachedRemoteSessions {
  observedAtMs: number;
  sessions: SessionSummary[];
}

export function createRemoteSessionReadModelCache(): RemoteSessionReadModelCache {
  const entries = new Map<string, CachedRemoteSessions>();
  return {
    get(nodeId, nowMs, maxAgeMs) {
      const cached = entries.get(nodeId);
      if (!cached) return null;
      if (nowMs - cached.observedAtMs > maxAgeMs) {
        entries.delete(nodeId);
        return null;
      }
      return cached.sessions.map((session) => ({ ...session }));
    },
    set(nodeId, sessions, observedAtMs) {
      entries.set(nodeId, {
        observedAtMs,
        sessions: sessions.map((session) => ({ ...session })),
      });
    },
    upsert(nodeId, session, observedAtMs) {
      const cached = entries.get(nodeId);
      const nextSession = { ...session };
      const sessions = cached
        ? cached.sessions.map((cachedSession) => ({ ...cachedSession }))
        : [];
      const existingIndex = sessions.findIndex(
        (cachedSession) => cachedSession.id === nextSession.id
      );
      if (existingIndex >= 0) {
        sessions[existingIndex] = nextSession;
      } else {
        sessions.push(nextSession);
      }
      entries.set(nodeId, { observedAtMs, sessions });
    },
    clear(nodeId) {
      entries.delete(nodeId);
    },
  };
}

export interface AggregateRemoteSessionsDeps {
  registry: HubNodeRegistry;
  nodeLinks: HubNodeLinkManager;
  logger?: Logger;
  sessionEnvelopes?: InMemorySessionEnvelopeRegistry;
  workContextStore?: WorkContextStore;
  readModelCache?: RemoteSessionReadModelCache;
  perNodeTimeoutMs?: number;
  readModelCacheTtlMs?: number;
  now?: () => number;
}

/**
 * Fetch and aggregate `sessions.list` results from every online paired
 * node with an active reverse link. Returns a flat array of
 * `SessionSummary` stamped with `nodeId`. Per-node failures (offline,
 * RPC timeout, malformed payload) are logged; callers that supply a
 * read-model cache get the last recent successful list for true transient
 * failures, otherwise the failed node is dropped. Non-cacheable typed
 * HubNodeLinkError failures such as NODE_OFFLINE, auth/credential errors,
 * revoked nodes/sessions, version skew, and malformed requests are not masked
 * by the cache. The aggregate never throws.
 *
 * Offline / stale / revoked nodes are skipped entirely and their cached
 * read model is cleared. Successful empty session lists replace the
 * cache, so ended sessions stop appearing once the owning node can answer
 * authoritatively.
 */
export async function aggregateRemoteSessions(
  deps: AggregateRemoteSessionsDeps
): Promise<SessionSummary[]> {
  const logger = deps.logger ?? createLogger('hub-session-agg');
  const timeoutMs = deps.perNodeTimeoutMs ?? PER_NODE_TIMEOUT_MS;
  const cacheTtlMs = deps.readModelCacheTtlMs ?? REMOTE_SESSION_CACHE_TTL_MS;
  const nowMs = deps.now?.() ?? Date.now();
  const envelopes = deps.sessionEnvelopes ?? sessionEnvelopeRegistry;

  const nodes = deps.registry.listNodes();
  const candidates = nodes.filter(
    (node) =>
      node.status === 'online' && deps.nodeLinks.hasActiveNode(node.nodeId)
  );
  if (deps.readModelCache) {
    const candidateIds = new Set(candidates.map((node) => node.nodeId));
    for (const node of nodes) {
      if (!candidateIds.has(node.nodeId)) deps.readModelCache.clear(node.nodeId);
    }
  }

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
      const reason = formatSessionListFailure(result.reason);
      const cached = getCachedSessionsForFailure(
        deps,
        candidate.nodeId,
        result.reason,
        nowMs,
        cacheTtlMs
      );
      if (cached) {
        logger.warn(
          `sessions.list failed for node ${candidate.nodeId}: ${reason}; using cached read model`
        );
        aggregated.push(
          ...cached.map((session) =>
            withWorkContextMetadata(deps.workContextStore, session)
          )
        );
      } else {
        logger.warn(
          `sessions.list failed for node ${candidate.nodeId}: ${reason}`
        );
      }
      continue;
    }
    const scopedSessions: SessionSummary[] = [];
    for (const session of result.value.sessions) {
      const scoped = scopedNodeSession(result.value.nodeId, session);
      const sessionEnvelope = envelopes.upsert(scoped.sessionEnvelope!);
      scopedSessions.push({ ...scoped, sessionEnvelope });
    }
    deps.readModelCache?.set(candidate.nodeId, scopedSessions, nowMs);
    aggregated.push(
      ...scopedSessions.map((session) =>
        withWorkContextMetadata(deps.workContextStore, session)
      )
    );
  }

  return aggregated;
}

function formatSessionListFailure(reason: unknown): string {
  if (reason instanceof HubNodeLinkError) {
    return `${reason.relayNodeError.code}: ${reason.relayNodeError.message}`;
  }
  if (reason instanceof Error) return reason.message;
  return String(reason ?? 'unknown');
}

function getCachedSessionsForFailure(
  deps: AggregateRemoteSessionsDeps,
  nodeId: string,
  reason: unknown,
  nowMs: number,
  cacheTtlMs: number
): SessionSummary[] | null {
  if (!isCacheableSessionListFailure(reason)) {
    return null;
  }
  return deps.readModelCache?.get(nodeId, nowMs, cacheTtlMs) ?? null;
}

function isCacheableSessionListFailure(reason: unknown): boolean {
  if (!(reason instanceof HubNodeLinkError)) return true;
  const { code, retryable } = reason.relayNodeError;
  return retryable && CACHEABLE_TYPED_SESSION_LIST_FAILURE_CODES.has(code);
}

function withWorkContextMetadata(
  store: WorkContextStore | undefined,
  session: SessionSummary
): SessionSummary {
  const trustedSession = { ...session };
  delete trustedSession.workContextId;
  const workContextId = store?.findSessionWorkContextIds(trustedSession)[0];
  return workContextId ? { ...trustedSession, workContextId } : trustedSession;
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
