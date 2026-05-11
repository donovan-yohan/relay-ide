import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
  createRepoInstanceId,
  createWorktreeInstanceId,
  parseGlobalSessionId,
} from '../shared/identity.js';

describe('shared identity helpers', () => {
  it('uses a stable implicit local node for local mode', () => {
    expect(DEFAULT_LOCAL_NODE_ID).toBe('local');
  });

  it('round-trips global session ids without assuming local ids are globally unique', () => {
    const global = createGlobalSessionId('macbook', 'session:with/slashes');

    expect(global).toBe('macbook:session%3Awith%2Fslashes');
    expect(parseGlobalSessionId(global)).toEqual({
      nodeId: 'macbook',
      localSessionId: 'session:with/slashes',
    });
  });

  it('rejects malformed global session ids', () => {
    expect(parseGlobalSessionId('not-global')).toBeNull();
    expect(parseGlobalSessionId(':missing-node')).toBeNull();
    expect(parseGlobalSessionId('node:')).toBeNull();
  });

  it('scopes repo and worktree instance ids by node plus local path', () => {
    const repoInstanceId = createRepoInstanceId('desktop', '/src/relay-ide');
    const worktreeInstanceId = createWorktreeInstanceId('desktop', '/src/relay-ide/.worktrees/a');

    expect(repoInstanceId).toBe('desktop:/src/relay-ide');
    expect(worktreeInstanceId).toBe('desktop:/src/relay-ide/.worktrees/a');
  });
});
