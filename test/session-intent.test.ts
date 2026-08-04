import { describe, it, expect } from 'vitest';
import {
  resolveIntent,
  issueToBranchName,
} from '../frontend/src/lib/session-intent.js';
import type { PickerItem } from '../frontend/src/lib/session-intent.js';
import type { GitHubIssue } from '../frontend/src/lib/types.js';
import { makePr, makeSession } from './helpers/frontend-factories.js';

describe('resolveIntent', () => {
  it('returns review-pr intent for reviewer on open PR', () => {
    const item: PickerItem = {
      kind: 'pr',
      pr: makePr({ role: 'reviewer', state: 'OPEN' }),
    };
    const intents = resolveIntent(item, 'reviewer', [], []);
    expect(intents.length).toBeGreaterThanOrEqual(1);
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
    expect(intents.length).toBeGreaterThanOrEqual(1);
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
    expect(intents.length).toBeGreaterThanOrEqual(1);
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
    expect(intents.length).toBeGreaterThanOrEqual(1);
    expect(intents[0]!.type).toBe('start-from-issue');
    expect(intents[0]!.prompt).toBeTruthy();
    expect(intents[0]!.prompt).toContain('#45');
    expect(intents[0]!.prompt).toContain(
      'Mobile virtual keyboard covers input'
    );
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
    expect(intents.length).toBeGreaterThanOrEqual(1);
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
