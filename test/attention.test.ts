import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAttentionScore, sortByAttention } from '../frontend/src/lib/state/attention.js';
import type { SidebarItem } from '../frontend/src/lib/types.js';

function makeScoreItem(overrides: Partial<SidebarItem> & { displayState: SidebarItem['displayState'] }): SidebarItem {
  return {
    id: 'test',
    kind: 'worktree',
    path: '/test',
    repoPath: '/repo',
    displayName: 'test',
    branchName: 'main',
    lastActivity: new Date().toISOString(),
    lastKnownBackendState: null,
    sessions: [],
    ...overrides,
  };
}

describe('computeAttentionScore', () => {
  it('permission scores highest', () => {
    const permission = computeAttentionScore(makeScoreItem({ displayState: 'permission' }));
    const running = computeAttentionScore(makeScoreItem({ displayState: 'running' }));
    assert.ok(permission > running);
  });

  it('needs-answer scores above error', () => {
    const needsAnswer = computeAttentionScore(makeScoreItem({ displayState: 'needs-answer' }));
    const error = computeAttentionScore(makeScoreItem({ displayState: 'error' }));
    assert.ok(needsAnswer > error);
  });

  it('error scores above unseen-idle', () => {
    const error = computeAttentionScore(makeScoreItem({ displayState: 'error' }));
    const unseen = computeAttentionScore(makeScoreItem({ displayState: 'unseen-idle' }));
    assert.ok(error > unseen);
  });

  it('unseen-idle scores above running', () => {
    const unseen = computeAttentionScore(makeScoreItem({ displayState: 'unseen-idle' }));
    const running = computeAttentionScore(makeScoreItem({ displayState: 'running' }));
    assert.ok(unseen > running);
  });

  it('inactive scores lowest', () => {
    const inactive = computeAttentionScore(makeScoreItem({ displayState: 'inactive' }));
    const seenIdle = computeAttentionScore(makeScoreItem({ displayState: 'seen-idle' }));
    assert.ok(inactive < seenIdle);
  });

  it('unread bonus stacks with state score', () => {
    const unread = computeAttentionScore(makeScoreItem({ displayState: 'unseen-idle', isUnread: true }));
    const read = computeAttentionScore(makeScoreItem({ displayState: 'unseen-idle', isUnread: false }));
    assert.ok(unread > read);
  });

  it('changes-requested PR adds urgency', () => {
    const withPr = computeAttentionScore(makeScoreItem({
      displayState: 'running',
      prStatus: 'changes-requested',
    }));
    const withoutPr = computeAttentionScore(makeScoreItem({
      displayState: 'running',
    }));
    assert.ok(withPr > withoutPr);
    assert.equal(withPr - withoutPr, 200);
  });

  it('review-requested PR adds urgency', () => {
    const withPr = computeAttentionScore(makeScoreItem({
      displayState: 'running',
      prStatus: 'review-requested',
    }));
    const withoutPr = computeAttentionScore(makeScoreItem({
      displayState: 'running',
    }));
    assert.equal(withPr - withoutPr, 150);
  });

  it('recency contributes to score', () => {
    const recent = computeAttentionScore(makeScoreItem({
      displayState: 'running',
      lastActivity: new Date().toISOString(),
    }));
    const old = computeAttentionScore(makeScoreItem({
      displayState: 'running',
      lastActivity: new Date(Date.now() - 120 * 60_000).toISOString(),
    }));
    assert.ok(recent > old);
  });
});

describe('sortByAttention', () => {
  it('sorts permission above running', () => {
    const items = [
      makeScoreItem({ id: 'a', displayState: 'running' }),
      makeScoreItem({ id: 'b', displayState: 'permission' }),
    ];
    const sorted = sortByAttention(items);
    assert.equal(sorted[0]!.id, 'b');
  });
});
