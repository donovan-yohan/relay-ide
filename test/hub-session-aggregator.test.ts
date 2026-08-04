import { describe, expect, it, vi } from 'vitest';
import {
  aggregateRemoteSessions,
  createRemoteSessionReadModelCache,
  isLocallyOwnedSession,
} from '../server/hub-session-aggregator.js';
import { HubNodeLinkError } from '../server/hub-node-link.js';
import { createSessionEnvelopeRegistry } from '../server/session-envelope-registry.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { createRoutedNodeSessionEnvelope } from '../shared/session-envelope.js';
import type { HubNodeLinkManager } from '../server/hub-node-link.js';
import type { HubNodeRegistry } from '../server/hub-node-registry.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';
import type { SessionSummary } from '../server/types.js';
import type { WorkContextStore } from '../server/work-contexts.js';

function summary(
  nodeId: string,
  status: HubNodeSummary['status'] = 'online'
): HubNodeSummary {
  return {
    nodeId,
    displayName: nodeId,
    hostname: `${nodeId}.local`,
    platform: 'linux',
    arch: 'x64',
    relayVersion: '0.1.0-test',
    protocolVersion: '1.0',
    status,
    connection: {
      route: '/hub/node-link',
      status: status === 'online' ? 'connected' : 'offline',
    },
    trust: { state: 'paired', level: 'privileged-local-user' },
    pairedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-02T00:00:00.000Z',
    capabilities: undefined as never,
  } as unknown as HubNodeSummary;
}

function localSession(id: string, nodeId: string): SessionSummary {
  return {
    id,
    type: 'terminal',
    mode: 'pty',
    repoPath: '/srv/relay-ide',
    worktreePath: null,
    cwd: '/srv/relay-ide',
    repoName: 'relay-ide',
    branchName: 'nightly',
    displayName: `${nodeId}/${id}`,
    createdAt: '2026-01-02T03:04:05.000Z',
    lastActivity: '2026-01-02T03:04:05.000Z',
    idle: false,
    customCommand: null,
    nodeId,
    globalSessionId: `${nodeId}:${id}`,
    useTmux: true,
    tmuxSessionName: `tmux-${id}`,
    status: 'active',
    needsBranchRename: false,
    activityState: 'idle',
  };
}

function buildDeps(opts: {
  nodes: HubNodeSummary[];
  activeNodeIds: Set<string>;
  requestImpl: (nodeId: string, type: string) => Promise<unknown>;
}) {
  const registry = {
    listNodes: () => opts.nodes,
  } as unknown as HubNodeRegistry;
  const nodeLinks = {
    hasActiveNode: (nodeId: string) => opts.activeNodeIds.has(nodeId),
    request: vi.fn(async (nodeId: string, type: string, _payload: unknown) =>
      opts.requestImpl(nodeId, type)
    ),
  } as unknown as HubNodeLinkManager;
  return { registry, nodeLinks };
}

describe('aggregateRemoteSessions', () => {
  it('returns an empty array when no nodes are paired', async () => {
    const { registry, nodeLinks } = buildDeps({
      nodes: [],
      activeNodeIds: new Set(),
      requestImpl: async () => ({ sessions: [] }),
    });
    const result = await aggregateRemoteSessions({ registry, nodeLinks });
    expect(result).toEqual([]);
  });

  it('skips offline, stale, and revoked nodes', async () => {
    const requestImpl = vi.fn(async () => ({ sessions: [] }));
    const { registry, nodeLinks } = buildDeps({
      nodes: [
        summary('node-online', 'online'),
        summary('node-offline', 'offline'),
        summary('node-stale', 'stale'),
        summary('node-revoked', 'revoked'),
      ],
      activeNodeIds: new Set(['node-online']),
      requestImpl,
    });
    await aggregateRemoteSessions({ registry, nodeLinks });
    expect(requestImpl).toHaveBeenCalledTimes(1);
    expect(requestImpl).toHaveBeenCalledWith('node-online', 'sessions.list');
  });

  it('skips online nodes that have no live reverse link', async () => {
    const requestImpl = vi.fn(async () => ({ sessions: [] }));
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-with-link'), summary('node-without-link')],
      activeNodeIds: new Set(['node-with-link']),
      requestImpl,
    });
    await aggregateRemoteSessions({ registry, nodeLinks });
    expect(requestImpl).toHaveBeenCalledTimes(1);
    expect(requestImpl).toHaveBeenCalledWith('node-with-link', 'sessions.list');
  });

  it('stamps each returned session with the correct nodeId', async () => {
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a'), summary('node-b')],
      activeNodeIds: new Set(['node-a', 'node-b']),
      requestImpl: async (nodeId) => ({
        sessions: [localSession('s1', nodeId), localSession('s2', nodeId)],
      }),
    });
    const result = await aggregateRemoteSessions({ registry, nodeLinks });
    expect(result).toHaveLength(4);
    expect(result.filter((s) => s.nodeId === 'node-a')).toHaveLength(2);
    expect(result.filter((s) => s.nodeId === 'node-b')).toHaveLength(2);
    for (const session of result) {
      expect(session.globalSessionId).toMatch(/^node-(a|b):(s1|s2)$/);
    }
  });

  it('strips node-provided WorkContext ids from remote session aggregation without a hub link', async () => {
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a')],
      activeNodeIds: new Set(['node-a']),
      requestImpl: async (nodeId) => ({
        sessions: [
          {
            ...localSession('s-untrusted', nodeId),
            workContextId: 'node-owned-context',
          },
        ],
      }),
    });

    const result = await aggregateRemoteSessions({ registry, nodeLinks });

    expect(result).toHaveLength(1);
    expect(result[0]?.workContextId).toBeUndefined();
  });

  it('hydrates remote session WorkContext ids only from the hub store', async () => {
    const workContextStore = {
      findSessionWorkContextIds: vi.fn(() => ['hub-owned-context']),
    } as unknown as WorkContextStore;
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a')],
      activeNodeIds: new Set(['node-a']),
      requestImpl: async (nodeId) => ({
        sessions: [
          {
            ...localSession('s-linked', nodeId),
            workContextId: 'node-owned-context',
          },
        ],
      }),
    });

    const result = await aggregateRemoteSessions({
      registry,
      nodeLinks,
      workContextStore,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.workContextId).toBe('hub-owned-context');
    expect(workContextStore.findSessionWorkContextIds).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-linked', nodeId: 'node-a' })
    );
  });

  it('registers listed remote session envelopes for later routed attach validation', async () => {
    const sessionEnvelopes = createSessionEnvelopeRegistry();
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a')],
      activeNodeIds: new Set(['node-a']),
      requestImpl: async (nodeId) => ({
        sessions: [localSession('s-listed', nodeId)],
      }),
    });

    const result = await aggregateRemoteSessions({
      registry,
      nodeLinks,
      sessionEnvelopes,
    });

    expect(result).toHaveLength(1);
    expect(sessionEnvelopes.read('s-listed', 'node-a')).toMatchObject({
      sessionId: 's-listed',
      nodeId: 'node-a',
      globalSessionId: 'node-a:s-listed',
    });
  });

  it('does not clobber a renewed remote expiry with a stale sessions.list envelope', async () => {
    const sessionEnvelopes = createSessionEnvelopeRegistry();
    const staleEnvelope = createRoutedNodeSessionEnvelope({
      sessionId: 's-renewed',
      nodeId: 'node-a',
      globalSessionId: 'node-a:s-renewed',
      cwd: '/srv/relay-ide',
      repoPath: '/srv/relay-ide',
      issuedAt: '2026-01-02T03:04:05.000Z',
      expiresAt: '2026-01-02T03:05:00.000Z',
    });
    sessionEnvelopes.upsert(staleEnvelope);
    expect(
      sessionEnvelopes.renew({
        sessionId: 's-renewed',
        nodeId: 'node-a',
        expiresAt: '2026-01-02T03:10:00.000Z',
        now: new Date('2026-01-02T03:04:30.000Z'),
      })
    ).toMatchObject({ ok: true });

    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a')],
      activeNodeIds: new Set(['node-a']),
      requestImpl: async () => ({
        sessions: [
          {
            ...localSession('s-renewed', 'node-a'),
            sessionEnvelope: staleEnvelope,
          },
        ],
      }),
    });

    const result = await aggregateRemoteSessions({
      registry,
      nodeLinks,
      sessionEnvelopes,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.sessionEnvelope?.expiresAt).toBe(
      '2026-01-02T03:10:00.000Z'
    );
    expect(sessionEnvelopes.read('s-renewed', 'node-a')?.expiresAt).toBe(
      '2026-01-02T03:10:00.000Z'
    );
  });

  it('drops sessions from a failed node but keeps results from other nodes', async () => {
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-good'), summary('node-bad')],
      activeNodeIds: new Set(['node-good', 'node-bad']),
      requestImpl: async (nodeId) => {
        if (nodeId === 'node-bad') {
          throw new HubNodeLinkError({
            code: 'NODE_OFFLINE',
            message: 'simulated failure',
            retryable: true,
          });
        }
        return { sessions: [localSession('s1', nodeId)] };
      },
    });
    const result = await aggregateRemoteSessions({ registry, nodeLinks });
    expect(result).toHaveLength(1);
    expect(result[0]?.nodeId).toBe('node-good');
  });

  it('falls back to the recent remote session read model when a listed node times out', async () => {
    const readModelCache = createRemoteSessionReadModelCache();
    let call = 0;
    const workContextStore = {
      findSessionWorkContextIds: vi.fn(() => ['hub-owned-context']),
    } as unknown as WorkContextStore;
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a')],
      activeNodeIds: new Set(['node-a']),
      requestImpl: async (nodeId) => {
        call += 1;
        if (call > 1) throw new Error('simulated sessions.list timeout');
        return { sessions: [localSession('s-live', nodeId)] };
      },
    });

    const fresh = await aggregateRemoteSessions({
      registry,
      nodeLinks,
      workContextStore,
      readModelCache,
      now: () => 1_000,
    });
    expect(fresh[0]).toMatchObject({
      id: 's-live',
      nodeId: 'node-a',
      workContextId: 'hub-owned-context',
      status: 'active',
    });

    const fallback = await aggregateRemoteSessions({
      registry,
      nodeLinks,
      workContextStore,
      readModelCache,
      now: () => 2_000,
    });

    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({
      id: 's-live',
      nodeId: 'node-a',
      workContextId: 'hub-owned-context',
      status: 'active',
    });
  });

  it('does not mask typed NODE_OFFLINE failures with the cached read model', async () => {
    const readModelCache = createRemoteSessionReadModelCache();
    let offline = false;
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a')],
      activeNodeIds: new Set(['node-a']),
      requestImpl: async (nodeId) => {
        if (offline) {
          throw new HubNodeLinkError({
            code: 'NODE_OFFLINE',
            message: 'node link is offline',
            retryable: true,
          });
        }
        return { sessions: [localSession('s-live', nodeId)] };
      },
    });

    await aggregateRemoteSessions({
      registry,
      nodeLinks,
      readModelCache,
      now: () => 1_000,
    });
    offline = true;

    const result = await aggregateRemoteSessions({
      registry,
      nodeLinks,
      readModelCache,
      now: () => 2_000,
    });

    expect(result).toEqual([]);
  });

  it('does not mask non-retryable typed HubNodeLinkError failures with the cached read model', async () => {
    const readModelCache = createRemoteSessionReadModelCache();
    let unauthorized = false;
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a')],
      activeNodeIds: new Set(['node-a']),
      requestImpl: async (nodeId) => {
        if (unauthorized) {
          throw new HubNodeLinkError({
            code: 'UNAUTHORIZED',
            message: 'node credential was rejected',
            retryable: false,
          });
        }
        return { sessions: [localSession('s-live', nodeId)] };
      },
    });

    await aggregateRemoteSessions({
      registry,
      nodeLinks,
      readModelCache,
      now: () => 1_000,
    });
    unauthorized = true;

    const result = await aggregateRemoteSessions({
      registry,
      nodeLinks,
      readModelCache,
      now: () => 2_000,
    });

    expect(result).toEqual([]);
  });

  it('does not use expired cached remote sessions after a sessions.list failure', async () => {
    const readModelCache = createRemoteSessionReadModelCache();
    let fail = false;
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a')],
      activeNodeIds: new Set(['node-a']),
      requestImpl: async (nodeId) => {
        if (fail) throw new Error('simulated sessions.list timeout');
        return { sessions: [localSession('s-live', nodeId)] };
      },
    });

    await aggregateRemoteSessions({
      registry,
      nodeLinks,
      readModelCache,
      now: () => 1_000,
    });
    fail = true;

    const expired = await aggregateRemoteSessions({
      registry,
      nodeLinks,
      readModelCache,
      readModelCacheTtlMs: 500,
      now: () => 2_000,
    });

    expect(expired).toEqual([]);
  });

  it('clears cached remote sessions when the owning node no longer has a live link', async () => {
    const readModelCache = createRemoteSessionReadModelCache();
    const activeNodeIds = new Set(['node-a']);
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a')],
      activeNodeIds,
      requestImpl: async (nodeId) => ({
        sessions: [localSession('s-live', nodeId)],
      }),
    });

    await aggregateRemoteSessions({ registry, nodeLinks, readModelCache });
    activeNodeIds.clear();

    const result = await aggregateRemoteSessions({
      registry,
      nodeLinks,
      readModelCache,
    });

    expect(result).toEqual([]);
    expect(readModelCache.get('node-a', Date.now(), 60_000)).toBeNull();
  });

  it('prunes cached remote sessions when the owning node is removed from the registry', async () => {
    const readModelCache = createRemoteSessionReadModelCache();
    readModelCache.set(
      'node-deleted',
      [localSession('s-stale', 'node-deleted')],
      1_000
    );
    const requestImpl = vi.fn(async () => ({ sessions: [] }));
    const { registry, nodeLinks } = buildDeps({
      nodes: [],
      activeNodeIds: new Set(),
      requestImpl,
    });

    const result = await aggregateRemoteSessions({
      registry,
      nodeLinks,
      readModelCache,
      now: () => 2_000,
    });

    expect(result).toEqual([]);
    expect(requestImpl).not.toHaveBeenCalled();
    expect(readModelCache.get('node-deleted', 2_000, 60_000)).toBeNull();
  });

  it('treats a malformed payload as an empty list rather than throwing', async () => {
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a')],
      activeNodeIds: new Set(['node-a']),
      requestImpl: async () => ({ unexpected: 'shape' }),
    });
    const result = await aggregateRemoteSessions({ registry, nodeLinks });
    expect(result).toEqual([]);
  });

  it('drops entries from the payload that fail SessionSummary validation', async () => {
    const goodSession = localSession('s-good', 'node-a');
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-a')],
      activeNodeIds: new Set(['node-a']),
      requestImpl: async () => ({
        sessions: [goodSession, { id: 'incomplete' }, null, 'string-not-obj'],
      }),
    });
    const result = await aggregateRemoteSessions({ registry, nodeLinks });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('s-good');
  });

  it('treats sessions with no nodeId as locally owned', () => {
    const session = localSession('s1', '');
    delete (session as { nodeId?: string }).nodeId;
    expect(isLocallyOwnedSession(session)).toBe(true);
  });

  it('treats sessions stamped with DEFAULT_LOCAL_NODE_ID as locally owned', () => {
    expect(
      isLocallyOwnedSession(localSession('s1', DEFAULT_LOCAL_NODE_ID))
    ).toBe(true);
  });

  it('treats sessions stamped with any remote nodeId as not locally owned', () => {
    expect(isLocallyOwnedSession(localSession('s1', 'node-remote'))).toBe(
      false
    );
  });

  it('drops a slow node when the per-node timeout fires', async () => {
    const { registry, nodeLinks } = buildDeps({
      nodes: [summary('node-fast'), summary('node-slow')],
      activeNodeIds: new Set(['node-fast', 'node-slow']),
      requestImpl: async (nodeId) => {
        if (nodeId === 'node-slow') {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { sessions: [localSession('late', nodeId)] };
        }
        return { sessions: [localSession('s-fast', nodeId)] };
      },
    });
    const result = await aggregateRemoteSessions({
      registry,
      nodeLinks,
      perNodeTimeoutMs: 25,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.nodeId).toBe('node-fast');
  });
});
