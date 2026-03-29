import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrMerged, computeBranchLifecycleState } from '../server/git.js';
import type { PrInfo } from '../server/types.js';

describe('isPrMerged', () => {
  it('returns true for MERGED state', () => {
    const pr = { state: 'MERGED' } as PrInfo;
    assert.equal(isPrMerged(pr), true);
  });

  it('returns false for OPEN state', () => {
    const pr = { state: 'OPEN' } as PrInfo;
    assert.equal(isPrMerged(pr), false);
  });

  it('returns false for CLOSED (not merged) state', () => {
    const pr = { state: 'CLOSED' } as PrInfo;
    assert.equal(isPrMerged(pr), false);
  });
});

describe('computeBranchLifecycleState', () => {
  it('returns merged when PR is merged', () => {
    const result = computeBranchLifecycleState({
      pr: { state: 'MERGED', number: 42, title: 'Fix auth' } as PrInfo,
      isBranchStale: false,
      hasActiveSessions: true,
      isMainBranch: false,
    });
    assert.equal(result.state, 'merged');
    assert.equal(result.prNumber, 42);
    assert.equal(result.prTitle, 'Fix auth');
  });

  it('returns active when branch has active sessions', () => {
    const result = computeBranchLifecycleState({
      pr: null,
      isBranchStale: true,
      hasActiveSessions: true,
      isMainBranch: false,
    });
    assert.equal(result.state, 'active');
  });

  it('returns stale when no sessions and branch is stale', () => {
    const result = computeBranchLifecycleState({
      pr: null,
      isBranchStale: true,
      hasActiveSessions: false,
      isMainBranch: false,
    });
    assert.equal(result.state, 'stale');
  });

  it('returns active when branch is not stale and no sessions', () => {
    const result = computeBranchLifecycleState({
      pr: null,
      isBranchStale: false,
      hasActiveSessions: false,
      isMainBranch: false,
    });
    assert.equal(result.state, 'active');
  });

  it('never returns merged for main branch even if PR is merged', () => {
    const result = computeBranchLifecycleState({
      pr: { state: 'MERGED', number: 1, title: 'Main PR' } as PrInfo,
      isBranchStale: false,
      hasActiveSessions: false,
      isMainBranch: true,
    });
    assert.equal(result.state, 'active');
  });

  it('main branch can be stale but never merged', () => {
    const result = computeBranchLifecycleState({
      pr: null,
      isBranchStale: true,
      hasActiveSessions: false,
      isMainBranch: true,
    });
    assert.equal(result.state, 'stale');
  });
});
