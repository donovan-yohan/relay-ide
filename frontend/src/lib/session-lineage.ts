import type { SessionSummary } from './types.js';
import { scopedSessionKey } from './session-keys.js';

export interface SessionLineageRoot {
  session: SessionSummary;
  workers: SessionSummary[];
}

export interface SessionLineage {
  /** Persistent planners that own one or more directly spawned workers. */
  orchestrators: SessionLineageRoot[];
  /** Sessions without lineage remain ordinary, top-level session rows. */
  standalone: SessionSummary[];
  /** Spawned sessions whose parent is missing or not an orchestrator. */
  ungrouped: SessionSummary[];
}

/**
 * Order all cockpit rows independently of arrival order. Creation time gives a
 * stable operator-friendly chronology; name and id make ties deterministic.
 */
function compareSessions(left: SessionSummary, right: SessionSummary): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.displayName.localeCompare(right.displayName) ||
    scopedSessionKey(left).localeCompare(scopedSessionKey(right))
  );
}

/**
 * Build the one-hop session lineage shown in the operator cockpit.
 *
 * Only orchestrators are roots. A spawned worker is nested only when its
 * immediate parent is one of those roots; stale/missing/non-orchestrator
 * parents remain visible in the synthetic ungrouped bucket instead of being
 * silently lost. Sessions with no parent preserve the normal flat treatment.
 */
export function buildSessionLineage(
  sessions: readonly SessionSummary[]
): SessionLineage {
  const orchestrators = sessions
    .filter((session) => session.role === 'orchestrator')
    .sort(compareSessions);
  const rootsByScopedKey = new Map(
    orchestrators.map((session) => [scopedSessionKey(session), session])
  );
  const rootsByRawId = new Map<string, SessionSummary[]>();
  for (const root of orchestrators) {
    const candidates = rootsByRawId.get(root.id) ?? [];
    candidates.push(root);
    rootsByRawId.set(root.id, candidates);
  }
  const workersByRootKey = new Map<string, SessionSummary[]>();
  const standalone: SessionSummary[] = [];
  const ungrouped: SessionSummary[] = [];

  for (const session of sessions) {
    // An orchestrator is always a visible root, even if an older record also
    // carries a parent pointer.
    if (session.role === 'orchestrator') continue;

    if (session.spawnedBySessionId === undefined) {
      standalone.push(session);
      continue;
    }

    const exactRoot = rootsByScopedKey.get(session.spawnedBySessionId);
    const rawCandidates = rootsByRawId.get(session.spawnedBySessionId) ?? [];
    const sameNodeRoots = rawCandidates.filter(
      (candidate) => candidate.nodeId === session.nodeId
    );
    const root =
      exactRoot ??
      (rawCandidates.length === 1
        ? rawCandidates[0]
        : sameNodeRoots.length === 1
          ? sameNodeRoots[0]
          : undefined);
    if (!root) {
      ungrouped.push(session);
      continue;
    }

    const rootKey = scopedSessionKey(root);
    const workers = workersByRootKey.get(rootKey) ?? [];
    workers.push(session);
    workersByRootKey.set(rootKey, workers);
  }

  return {
    orchestrators: orchestrators.map((session) => ({
      session,
      workers: (workersByRootKey.get(scopedSessionKey(session)) ?? []).sort(
        compareSessions
      ),
    })),
    standalone: standalone.sort(compareSessions),
    ungrouped: ungrouped.sort(compareSessions),
  };
}
