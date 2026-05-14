import { describe, expect, it, vi } from 'vitest';
import { aggregateRemoteSessions } from '../server/hub-session-aggregator.js';
import { HubNodeLinkError } from '../server/hub-node-link.js';
import type { HubNodeLinkManager } from '../server/hub-node-link.js';
import type { HubNodeRegistry } from '../server/hub-node-registry.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';
import type { SessionSummary } from '../server/types.js';

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
  } as HubNodeSummary;
}

function localSession(id: string, nodeId: string): SessionSummary {
  return {
    id,
    type: 'terminal',
    agent: 'claude',
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
    agentState: 'idle',
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
