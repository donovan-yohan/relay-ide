import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
  createRepoInstanceId,
  createWorktreeInstanceId,
  parseGlobalSessionId,
  parseRepoInstanceId,
  parseWorktreeInstanceId,
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
    expect(parseGlobalSessionId('node:session:raw-delimiter')).toBeNull();
    expect(parseGlobalSessionId('node:%')).toBeNull();
  });

  it('encodes repo and worktree instance ids before joining node and local path', () => {
    const nodeId = 'desktop:node/with delimiter';
    const repoPath = '/src/relay ide:main';
    const worktreePath = '/src/relay ide/.worktrees/feature:one';

    const repoInstanceId = createRepoInstanceId(nodeId, repoPath);
    const worktreeInstanceId = createWorktreeInstanceId(nodeId, worktreePath);

    expect(repoInstanceId).toBe(
      'desktop%3Anode%2Fwith%20delimiter:%2Fsrc%2Frelay%20ide%3Amain'
    );
    expect(worktreeInstanceId).toBe(
      'desktop%3Anode%2Fwith%20delimiter:%2Fsrc%2Frelay%20ide%2F.worktrees%2Ffeature%3Aone'
    );
    expect(parseRepoInstanceId(repoInstanceId)).toEqual({
      nodeId,
      localPath: repoPath,
    });
    expect(parseWorktreeInstanceId(worktreeInstanceId)).toEqual({
      nodeId,
      localPath: worktreePath,
    });
  });

  it('rejects malformed repo and worktree instance ids', () => {
    for (const malformed of [
      'not-scoped',
      ':missing-node',
      'node:',
      'node:/raw/path:with-colon',
      'node:%',
    ]) {
      expect(parseRepoInstanceId(malformed)).toBeNull();
      expect(parseWorktreeInstanceId(malformed)).toBeNull();
    }
  });
});
