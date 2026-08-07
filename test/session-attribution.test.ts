import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { buildSessionEvent } from '../server/session-attribution.js';

describe('buildSessionEvent', () => {
  it('defaults local production sessions to the local node id', () => {
    expect(
      buildSessionEvent(
        {
          id: 'free-session',
        },
        { eventType: 'session_start', timestamp: '2026-05-14T00:00:00.000Z' }
      )
    ).toMatchObject({
      session_id: 'free-session',
      node_id: DEFAULT_LOCAL_NODE_ID,
      session_category: 'free',
      event_type: 'session_start',
    });
  });

  it('preserves an explicit node id when one is already attached', () => {
    expect(
      buildSessionEvent(
        {
          id: 'remote-session',
          nodeId: 'node-b',
          repoPath: '/repo',
          worktreePath: null,
          branchName: 'main',
        },
        { eventType: 'tool_complete', timestamp: '2026-05-14T00:00:00.000Z' }
      )
    ).toMatchObject({
      session_id: 'remote-session',
      node_id: 'node-b',
      repo_path: '/repo',
      worktree_path: null,
      branch_name: 'main',
      session_category: 'repo',
    });
  });
});
