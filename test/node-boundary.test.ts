import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCAL_ENVIRONMENT_ID,
  createLocalEventAuthority,
  createNodeScopedFileEvent,
  createNodeScopedSessionEvent,
  nodeSessionWebSocketPath,
  sessionEventMatches,
} from '../shared/node-boundary.js';

import { createLocalRelayNode } from '../server/local-node.js';
import type { CreateParams, CreateResult } from '../server/sessions.js';

describe('node boundary primitives', () => {
  it('declares a stable local environment authority for local mode events', () => {
    expect(DEFAULT_LOCAL_ENVIRONMENT_ID).toBe('local');
    expect(createLocalEventAuthority()).toEqual({
      nodeId: 'local',
      environmentId: 'local',
      authority: 'local-node',
    });
  });

  it('creates node-scoped session event references without changing the local id', () => {
    const event = createNodeScopedSessionEvent('abc123', {
      nodeId: 'desktop:one',
      environmentId: 'dev',
    });

    expect(event).toEqual({
      nodeId: 'desktop:one',
      environmentId: 'dev',
      authority: 'local-node',
      sessionId: 'abc123',
      localSessionId: 'abc123',
      globalSessionId: 'desktop%3Aone:abc123',
    });
    expect(
      sessionEventMatches(
        { id: 'abc123', nodeId: 'other', globalSessionId: 'other:abc123' },
        event
      )
    ).toBe(false);
    expect(
      sessionEventMatches(
        {
          id: 'abc123',
          nodeId: 'desktop:one',
          globalSessionId: 'desktop%3Aone:abc123',
        },
        event
      )
    ).toBe(true);
  });

  it('keeps file/worktree events scoped to the node-owned path instances', () => {
    expect(
      createNodeScopedFileEvent({
        workspacePath: '/repos/relay-ide',
        worktreePath: '/repos/relay-ide/.worktrees/a',
        nodeId: 'node/a',
      })
    ).toEqual({
      nodeId: 'node/a',
      environmentId: 'local',
      authority: 'local-node',
      workspacePath: '/repos/relay-ide',
      repoInstanceId: 'node%2Fa:%2Frepos%2Frelay-ide',
      worktreePath: '/repos/relay-ide/.worktrees/a',
      worktreeInstanceId: 'node%2Fa:%2Frepos%2Frelay-ide%2F.worktrees%2Fa',
    });
  });

  it('identifies the future node-owned session websocket route shape', () => {
    expect(nodeSessionWebSocketPath('node/a', 'session one')).toBe(
      '/nodes/node%2Fa/ws/sessions/session%20one'
    );
  });

  it('exposes a local relay-node facade over injected session operations', () => {
    const calls: string[] = [];
    const node = createLocalRelayNode({
      sessions: {
        list: () => {
          calls.push('list');
          return [];
        },
        get: (id: string) => {
          calls.push(`get:${id}`);
          return undefined;
        },
        create: (params: CreateParams): CreateResult => {
          calls.push('create');
          return { id: params.id ?? 'created' } as CreateResult;
        },
        kill: (id: string) => {
          calls.push(`kill:${id}`);
        },
        updateDisplayName: (id: string, displayName: string) => {
          calls.push(`update:${id}:${displayName}`);
          return { id, displayName };
        },
        write: (id: string, data: string) => {
          calls.push(`write:${id}:${data}`);
        },
      },
    });

    expect(node.nodeId).toBe('local');
    expect(node.environmentId).toBe('local');
    expect(node.sessions.list()).toEqual([]);
    expect(node.sessions.get('s1')).toBeUndefined();
    expect(node.sessions.create({ id: 's1' } as CreateParams)).toEqual({
      id: 's1',
    });
    expect(node.sessions.updateDisplayName('s1', 'renamed')).toEqual({
      id: 's1',
      displayName: 'renamed',
    });
    node.sessions.write('s1', 'x');
    node.sessions.kill('s1');

    expect(calls).toEqual([
      'list',
      'get:s1',
      'create',
      'update:s1:renamed',
      'write:s1:x',
      'kill:s1',
    ]);
  });
});
