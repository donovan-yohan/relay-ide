import type {
  PullRequest,
  SessionSummary,
  WorktreeInfo,
} from '../../frontend/src/lib/types.js';

export function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'Test PR',
    url: 'https://github.com/test/repo/pull/1',
    headRefName: 'feat/test',
    baseRefName: 'main',
    state: 'OPEN',
    author: 'user',
    role: 'author',
    updatedAt: '2026-03-29T00:00:00Z',
    additions: 10,
    deletions: 5,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    ciStatus: 'SUCCESS',
    isDraft: false,
    ...overrides,
  };
}

export function makeSession(
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id: 'sess-1',
    type: 'agent',
    agent: 'claude',
    repoName: 'repo',
    repoPath: '/path/to/repo',
    worktreePath: '/path/to/worktree',
    cwd: '/path/to/worktree',
    branchName: 'feat/test',
    displayName: 'test session',
    createdAt: '2026-03-29T00:00:00Z',
    lastActivity: '2026-03-29T00:00:00Z',
    idle: false,
    ...overrides,
  };
}

export function makeWorktree(
  overrides: Partial<WorktreeInfo> = {}
): WorktreeInfo {
  return {
    name: 'everest',
    path: '/path/to/worktree',
    repoName: 'repo',
    repoPath: '/path/to/repo',
    displayName: 'everest',
    lastActivity: '2026-03-29T00:00:00Z',
    branchName: 'feat/test',
    ...overrides,
  };
}
