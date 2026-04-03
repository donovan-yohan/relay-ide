import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
/* eslint-disable no-console -- temporary CI debug */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const targetPath = path.resolve(
  __dirname,
  '../frontend/src/lib/session-intent.js'
);
console.error(`[DEBUG] __dirname=${__dirname}`);
console.error(`[DEBUG] target=${targetPath}`);
console.error(`[DEBUG] exists=${fs.existsSync(targetPath)}`);
console.error(`[DEBUG] cwd=${process.cwd()}`);
if (fs.existsSync(path.resolve(__dirname, '../frontend'))) {
  console.error(
    `[DEBUG] frontend dir contents: ${fs.readdirSync(path.resolve(__dirname, '../frontend/src/lib')).join(', ')}`
  );
}
/* eslint-enable no-console */

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
    assert.ok(intents.length >= 1);
    assert.equal(intents[0]!.type, 'review-pr');
    assert.equal(intents[0]!.color, 'info');
    assert.ok(intents[0]!.prompt); // review prompt should exist
  });

  it('returns merge-pr intent for author on open mergeable PR', () => {
    const item: PickerItem = {
      kind: 'pr',
      pr: makePr({ role: 'author', mergeable: 'MERGEABLE' }),
    };
    const intents = resolveIntent(item, 'author', [], []);
    assert.ok(intents.length >= 1);
    assert.equal(intents[0]!.type, 'merge-pr');
    assert.equal(intents[0]!.color, 'success');
    assert.equal(intents[0]!.prompt, null); // merge is a GitHub link
  });

  it('returns resume-session when matching session exists', () => {
    const pr = makePr({ headRefName: 'feat/test' });
    const session = makeSession({ branchName: 'feat/test' });
    const item: PickerItem = { kind: 'pr', pr };
    const intents = resolveIntent(item, 'author', [session], []);
    // resume-session should appear in the intents
    const resume = intents.find((i) => i.type === 'resume-session');
    assert.ok(resume);
    assert.equal(resume!.existingSessionId, 'sess-1');
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
    assert.ok(intents.length >= 1);
    assert.equal(intents[0]!.type, 'open-branch');
    assert.ok(intents[0]!.prompt);
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
    assert.equal(intents[0]!.type, 'resume-session');
    assert.equal(intents[0]!.existingSessionId, 'sess-1');
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
    assert.ok(intents.length >= 1);
    assert.equal(intents[0]!.type, 'start-from-issue');
    assert.ok(intents[0]!.prompt);
    assert.ok(intents[0]!.prompt!.includes('#45'));
    assert.ok(
      intents[0]!.prompt!.includes('Mobile virtual keyboard covers input')
    );
  });

  it('returns archive for merged PR', () => {
    const item: PickerItem = { kind: 'pr', pr: makePr({ state: 'MERGED' }) };
    const intents = resolveIntent(item, 'author', [], []);
    assert.equal(intents[0]!.type, 'archive');
  });

  it('returns fix-conflicts for PR with conflicts', () => {
    const item: PickerItem = {
      kind: 'pr',
      pr: makePr({ mergeable: 'CONFLICTING' }),
    };
    const intents = resolveIntent(item, 'author', [], []);
    assert.equal(intents[0]!.type, 'fix-conflicts');
    assert.equal(intents[0]!.color, 'error');
  });

  it('always returns at least one intent', () => {
    const item: PickerItem = { kind: 'pr', pr: makePr() };
    const intents = resolveIntent(item, 'author', [], []);
    assert.ok(intents.length >= 1);
  });

  it('returns archive for closed PR', () => {
    const item: PickerItem = { kind: 'pr', pr: makePr({ state: 'CLOSED' }) };
    const intents = resolveIntent(item, 'author', [], []);
    assert.equal(intents[0]!.type, 'archive');
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
    assert.equal(intents[0]!.type, 'start-from-issue');
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
    assert.equal(intents[0]!.type, 'resume-session');
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
    assert.equal(name, 'feat/issue-10-add-dark-mode-support');
  });

  it('uses fix prefix for bug label', () => {
    const name = issueToBranchName(
      makeIssue({
        number: 42,
        title: 'Button not clickable',
        labels: [{ name: 'bug', color: 'ff0000' }],
      })
    );
    assert.equal(name, 'fix/issue-42-button-not-clickable');
  });

  it('strips special characters from title', () => {
    const name = issueToBranchName(
      makeIssue({ number: 5, title: "Can't open [modal] (broken)" })
    );
    assert.equal(name, 'feat/issue-5-cant-open-modal-broken');
  });

  it('truncates to 5 words', () => {
    const name = issueToBranchName(
      makeIssue({
        number: 99,
        title: 'This is a very long issue title that goes on forever',
      })
    );
    assert.equal(name, 'feat/issue-99-this-is-a-very-long');
  });

  it('handles single-word title', () => {
    const name = issueToBranchName(makeIssue({ number: 3, title: 'Crash' }));
    assert.equal(name, 'feat/issue-3-crash');
  });
});
