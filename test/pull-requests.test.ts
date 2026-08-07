import { describe, it, expect } from 'vitest';
import type { PullRequest, PullRequestsResponse } from '../server/types.js';

describe('PullRequest types', () => {
  it('constructs a valid author PR', () => {
    const pr: PullRequest = {
      number: 42,
      title: 'Fix bug',
      url: 'https://github.com/owner/repo/pull/42',
      headRefName: 'fix/bug',
      baseRefName: 'main',
      state: 'OPEN',
      author: 'testuser',
      role: 'author',
      updatedAt: '2026-02-24T00:00:00Z',
      additions: 10,
      deletions: 5,
      reviewDecision: 'APPROVED',
      mergeable: 'MERGEABLE',
      isDraft: false,
      ciStatus: null,
    };
    expect(pr.role).toBe('author');
    expect(pr.state).toBe('OPEN');
  });

  it('constructs a valid reviewer PR', () => {
    const pr: PullRequest = {
      number: 43,
      title: 'Add feature',
      url: 'https://github.com/owner/repo/pull/43',
      headRefName: 'feat/new',
      baseRefName: 'main',
      state: 'OPEN',
      author: 'otheruser',
      role: 'reviewer',
      updatedAt: '2026-02-24T00:00:00Z',
      additions: 50,
      deletions: 20,
      reviewDecision: null,
      mergeable: null,
      isDraft: false,
      ciStatus: null,
    };
    expect(pr.role).toBe('reviewer');
  });

  it('constructs a valid response with error', () => {
    const response: PullRequestsResponse = {
      prs: [],
      error: 'gh_not_authenticated',
    };
    expect(response.prs.length).toBe(0);
    expect(response.error).toBe('gh_not_authenticated');
  });

  it('constructs a valid response without error', () => {
    const response: PullRequestsResponse = {
      prs: [
        {
          number: 1,
          title: 'Test',
          url: 'https://github.com/o/r/pull/1',
          headRefName: 'test',
          baseRefName: 'main',
          state: 'OPEN',
          author: 'user',
          role: 'author',
          updatedAt: '2026-02-24T00:00:00Z',
          additions: 0,
          deletions: 0,
          reviewDecision: null,
          mergeable: null,
          isDraft: false,
          ciStatus: null,
        },
      ],
    };
    expect(response.prs.length).toBe(1);
    expect(response.error).toBe(undefined);
  });
});
