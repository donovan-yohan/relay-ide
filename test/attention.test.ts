import { describe, it, expect } from 'vitest';
import {
  computeAttentionScore,
  sortByAttention,
} from '../frontend/src/lib/state/attention.js';
import type { SidebarItem } from '../frontend/src/lib/types.js';

function makeScoreItem(
  overrides: Partial<SidebarItem> & {
    displayState: SidebarItem['displayState'];
  }
): SidebarItem {
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
    const permission = computeAttentionScore(
      makeScoreItem({ displayState: 'permission' })
    );
    const running = computeAttentionScore(
      makeScoreItem({ displayState: 'running' })
    );
    expect(permission > running).toBeTruthy();
  });

  it('needs-answer scores above error', () => {
    const needsAnswer = computeAttentionScore(
      makeScoreItem({ displayState: 'needs-answer' })
    );
    const error = computeAttentionScore(
      makeScoreItem({ displayState: 'error' })
    );
    expect(needsAnswer > error).toBeTruthy();
  });

  it('error scores above unseen-idle', () => {
    const error = computeAttentionScore(
      makeScoreItem({ displayState: 'error' })
    );
    const unseen = computeAttentionScore(
      makeScoreItem({ displayState: 'unseen-idle' })
    );
    expect(error > unseen).toBeTruthy();
  });

  it('unseen-idle scores above running', () => {
    const unseen = computeAttentionScore(
      makeScoreItem({ displayState: 'unseen-idle' })
    );
    const running = computeAttentionScore(
      makeScoreItem({ displayState: 'running' })
    );
    expect(unseen > running).toBeTruthy();
  });

  it('inactive scores lowest', () => {
    const inactive = computeAttentionScore(
      makeScoreItem({ displayState: 'inactive' })
    );
    const seenIdle = computeAttentionScore(
      makeScoreItem({ displayState: 'seen-idle' })
    );
    expect(inactive < seenIdle).toBeTruthy();
  });

  it('unread bonus stacks with state score', () => {
    const unread = computeAttentionScore(
      makeScoreItem({ displayState: 'unseen-idle', isUnread: true })
    );
    const read = computeAttentionScore(
      makeScoreItem({ displayState: 'unseen-idle', isUnread: false })
    );
    expect(unread > read).toBeTruthy();
  });

  it('changes-requested PR adds urgency', () => {
    const withPr = computeAttentionScore(
      makeScoreItem({
        displayState: 'running',
        prStatus: 'changes-requested',
      })
    );
    const withoutPr = computeAttentionScore(
      makeScoreItem({
        displayState: 'running',
      })
    );
    expect(withPr > withoutPr).toBeTruthy();
    expect(withPr - withoutPr).toBeCloseTo(200);
  });

  it('review-requested PR adds urgency', () => {
    const withPr = computeAttentionScore(
      makeScoreItem({
        displayState: 'running',
        prStatus: 'review-requested',
      })
    );
    const withoutPr = computeAttentionScore(
      makeScoreItem({
        displayState: 'running',
      })
    );
    expect(withPr - withoutPr).toBeCloseTo(150);
  });

  it('recency contributes to score', () => {
    const recent = computeAttentionScore(
      makeScoreItem({
        displayState: 'running',
        lastActivity: new Date().toISOString(),
      })
    );
    const old = computeAttentionScore(
      makeScoreItem({
        displayState: 'running',
        lastActivity: new Date(Date.now() - 120 * 60_000).toISOString(),
      })
    );
    expect(recent > old).toBeTruthy();
  });
});

describe('sortByAttention', () => {
  it('sorts permission above running', () => {
    const items = [
      makeScoreItem({ id: 'a', displayState: 'running' }),
      makeScoreItem({ id: 'b', displayState: 'permission' }),
    ];
    const sorted = sortByAttention(items);
    expect(sorted[0]!.id).toBe('b');
  });
});
