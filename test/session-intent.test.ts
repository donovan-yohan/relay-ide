import { describe, it, expect } from 'vitest';
import {
  resolveIntent,
  issueToBranchName,
} from '../frontend/src/lib/session-intent.js';
import type {
  PickerItem,
  SessionIntent,
} from '../frontend/src/lib/session-intent.js';
import type { GitHubIssue } from '../frontend/src/lib/types.js';
import type {
  PullRequest,
  SessionSummary,
  WorktreeInfo,
} from '../frontend/src/lib/types.js';

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
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

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
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

function makeWorktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
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

describe('resolveIntent', () => {
  it('returns review-pr intent for reviewer on open PR', () => {
    const item: PickerItem = {
      kind: 'pr',
      pr: makePr({ role: 'reviewer', state: 'OPEN' }),
    };
    const intents = resolveIntent(item, 'reviewer', [], []);
    expect(intents.length >= 1).toBeTruthy();
    expect(intents[0]!.type).toBe('review-pr');
    expect(intents[0]!.color).toBe('info');
    expect(intents[0]!.prompt).toBeTruthy(); // review prompt should exist
  });

  it('returns merge-pr intent for author on open mergeable PR', () => {
    const item: PickerItem = {
      kind: 'pr',
      pr: makePr({ role: 'author', mergeable: 'MERGEABLE' }),
    };
    const intents = resolveIntent(item, 'author', [], []);
    expect(intents.length >= 1).toBeTruthy();
    expect(intents[0]!.type).toBe('merge-pr');
    expect(intents[0]!.color).toBe('success');
    expect(intents[0]!.prompt).toBe(null); // merge is a GitHub link
  });

  it('returns resume-session when matching session exists', () => {
    const pr = makePr({ headRefName: 'feat/test' });
    const session = makeSession({ branchName: 'feat/test' });
    const item: PickerItem = { kind: 'pr', pr };
    const intents = resolveIntent(item, 'author', [session], []);
    // resume-session should appear in the intents
    const resume = intents.find((i) => i.type === 'resume-session');
    expect(resume).toBeTruthy();
    expect(resume!.existingSessionId).toBe('sess-1');
  });

  it('returns open-branch for branch without session', () => {
    const item: PickerItem = {
      kind: 'branch',
      name: 'feat/new',
      ahead: 3,
      behind: 0,
      prNumber: null,
      repoPath: '/path/to/repo',
    };
    const intents = resolveIntent(item, 'author', [], []);
    expect(intents.length >= 1).toBeTruthy();
    expect(intents[0]!.type).toBe('open-branch');
    expect(intents[0]!.prompt).toBeTruthy();
  });

  it('returns resume-session for branch with existing session', () => {
    const session = makeSession({ branchName: 'feat/existing' });
    const item: PickerItem = {
      kind: 'branch',
      name: 'feat/existing',
      ahead: 1,
      behind: 0,
      prNumber: null,
      repoPath: '/path/to/repo',
    };
    const intents = resolveIntent(item, 'author', [session], []);
    expect(intents[0]!.type).toBe('resume-session');
    expect(intents[0]!.existingSessionId).toBe('sess-1');
  });

  it('returns start-from-issue for GitHub issue', () => {
    const item: PickerItem = {
      kind: 'issue',
      issue: {
        number: 45,
        title: 'Mobile virtual keyboard covers input',
        url: 'https://github.com/test/repo/issues/45',
        state: 'OPEN',
        labels: [{ name: 'bug', color: 'ff0000' }],
        assignees: [{ login: 'user' }],
        createdAt: '2026-03-29T00:00:00Z',
        updatedAt: '2026-03-29T00:00:00Z',
        repoName: 'repo',
        repoPath: '/path/to/repo',
      },
    };
    const intents = resolveIntent(item, 'author', [], []);
    expect(intents.length >= 1).toBeTruthy();
    expect(intents[0]!.type).toBe('start-from-issue');
    expect(intents[0]!.prompt).toBeTruthy();
    expect(intents[0]!.prompt!.includes('#45')).toBeTruthy();
    expect(
      intents[0]!.prompt!.includes('Mobile virtual keyboard covers input')
    ).toBeTruthy();
  });

  it('returns archive for merged PR', () => {
    const item: PickerItem = { kind: 'pr', pr: makePr({ state: 'MERGED' }) };
    const intents = resolveIntent(item, 'author', [], []);
    expect(intents[0]!.type).toBe('archive');
  });

  it('returns fix-conflicts for PR with conflicts', () => {
    const item: PickerItem = {
      kind: 'pr',
      pr: makePr({ mergeable: 'CONFLICTING' }),
    };
    const intents = resolveIntent(item, 'author', [], []);
    expect(intents[0]!.type).toBe('fix-conflicts');
    expect(intents[0]!.color).toBe('error');
  });

  it('always returns at least one intent', () => {
    const item: PickerItem = { kind: 'pr', pr: makePr() };
    const intents = resolveIntent(item, 'author', [], []);
    expect(intents.length >= 1).toBeTruthy();
  });

  it('returns archive for closed PR', () => {
    const item: PickerItem = { kind: 'pr', pr: makePr({ state: 'CLOSED' }) };
    const intents = resolveIntent(item, 'author', [], []);
    expect(intents[0]!.type).toBe('archive');
  });

  it('issue branch match does not false-positive on longer numbers', () => {
    // Session on issue-123 should NOT match when resolving intent for issue #12
    const session = makeSession({ branchName: 'feat/issue-123-some-feature' });
    const item: PickerItem = {
      kind: 'issue',
      issue: {
        number: 12,
        title: 'Short issue',
        url: 'https://github.com/test/repo/issues/12',
        state: 'OPEN',
        labels: [],
        assignees: [],
        createdAt: '2026-03-29T00:00:00Z',
        updatedAt: '2026-03-29T00:00:00Z',
        repoName: 'repo',
        repoPath: '/path/to/repo',
      },
    };
    const intents = resolveIntent(item, 'author', [session], []);
    // Should NOT resume the session for issue-123
    expect(intents[0]!.type).toBe('start-from-issue');
  });

  it('issue branch match works for exact issue number', () => {
    const session = makeSession({
      branchName: 'feat/issue-45-mobile-keyboard',
    });
    const item: PickerItem = {
      kind: 'issue',
      issue: {
        number: 45,
        title: 'Mobile keyboard issue',
        url: 'https://github.com/test/repo/issues/45',
        state: 'OPEN',
        labels: [],
        assignees: [],
        createdAt: '2026-03-29T00:00:00Z',
        updatedAt: '2026-03-29T00:00:00Z',
        repoName: 'repo',
        repoPath: '/path/to/repo',
      },
    };
    const intents = resolveIntent(item, 'author', [session], []);
    expect(intents[0]!.type).toBe('resume-session');
  });
});

describe('issueToBranchName', () => {
  function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
    return {
      number: 1,
      title: 'Test issue title',
      url: 'https://github.com/test/repo/issues/1',
      state: 'OPEN',
      labels: [],
      assignees: [],
      createdAt: '2026-03-29T00:00:00Z',
      updatedAt: '2026-03-29T00:00:00Z',
      repoName: 'repo',
      repoPath: '/path/to/repo',
      ...overrides,
    };
  }

  it('uses feat prefix by default', () => {
    const name = issueToBranchName(
      makeIssue({ number: 10, title: 'Add dark mode support' })
    );
    expect(name).toBe('feat/issue-10-add-dark-mode-support');
  });

  it('uses fix prefix for bug label', () => {
    const name = issueToBranchName(
      makeIssue({
        number: 42,
        title: 'Button not clickable',
        labels: [{ name: 'bug', color: 'ff0000' }],
      })
    );
    expect(name).toBe('fix/issue-42-button-not-clickable');
  });

  it('strips special characters from title', () => {
    const name = issueToBranchName(
      makeIssue({ number: 5, title: "Can't open [modal] (broken)" })
    );
    expect(name).toBe('feat/issue-5-cant-open-modal-broken');
  });

  it('truncates to 5 words', () => {
    const name = issueToBranchName(
      makeIssue({
        number: 99,
        title: 'This is a very long issue title that goes on forever',
      })
    );
    expect(name).toBe('feat/issue-99-this-is-a-very-long');
  });

  it('handles single-word title', () => {
    const name = issueToBranchName(makeIssue({ number: 3, title: 'Crash' }));
    expect(name).toBe('feat/issue-3-crash');
  });
});
