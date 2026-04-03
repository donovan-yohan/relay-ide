import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractOwnerRepo } from '../server/git.js';
import { isStalePr } from '../server/gh.js';
import type { PrInfo } from '../server/types.js';

describe('extractOwnerRepo', () => {
  it('parses an SSH URL with .git suffix', () => {
    assert.equal(
      extractOwnerRepo('git@github.com:donovan-yohan/claude-remote-cli.git'),
      'donovan-yohan/claude-remote-cli'
    );
  });

  it('parses an SSH URL without .git suffix', () => {
    assert.equal(extractOwnerRepo('git@github.com:owner/repo'), 'owner/repo');
  });

  it('parses an HTTPS URL with .git suffix', () => {
    assert.equal(
      extractOwnerRepo('https://github.com/owner/repo.git'),
      'owner/repo'
    );
  });

  it('parses an HTTPS URL without .git suffix', () => {
    assert.equal(
      extractOwnerRepo('https://github.com/owner/repo'),
      'owner/repo'
    );
  });

  it('is host-agnostic and parses a non-GitHub HTTPS URL', () => {
    assert.equal(
      extractOwnerRepo('https://gitlab.com/owner/repo.git'),
      'owner/repo'
    );
  });

  it('returns null for an empty string', () => {
    assert.equal(extractOwnerRepo(''), null);
  });

  it('returns null for a malformed URL', () => {
    assert.equal(extractOwnerRepo('not-a-url'), null);
  });
});

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 1,
    title: 'test',
    url: '',
    state: 'OPEN',
    headRefName: 'main',
    baseRefName: 'main',
    isDraft: false,
    reviewDecision: null,
    additions: 0,
    deletions: 0,
    mergeable: 'UNKNOWN',
    unresolvedCommentCount: 0,
    updatedAt: '',
    ...overrides,
  };
}

describe('isStalePr', () => {
  it('OPEN PR is never stale regardless of age', () => {
    assert.equal(
      isStalePr(makePr({ state: 'OPEN', updatedAt: '2020-01-01T00:00:00Z' })),
      false
    );
  });

  it('MERGED PR updated more than 1 day ago is stale', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    assert.equal(
      isStalePr(makePr({ state: 'MERGED', updatedAt: twoDaysAgo })),
      true
    );
  });

  it('CLOSED PR updated more than 1 day ago is stale', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    assert.equal(
      isStalePr(makePr({ state: 'CLOSED', updatedAt: twoDaysAgo })),
      true
    );
  });

  it('MERGED PR updated less than 1 day ago is not stale (grace period)', () => {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    assert.equal(
      isStalePr(makePr({ state: 'MERGED', updatedAt: oneHourAgo })),
      false
    );
  });

  it('PR with empty updatedAt is stale', () => {
    assert.equal(isStalePr(makePr({ state: 'MERGED', updatedAt: '' })), true);
  });

  it('PR with unparseable updatedAt is stale', () => {
    assert.equal(
      isStalePr(makePr({ state: 'CLOSED', updatedAt: 'not-a-date' })),
      true
    );
  });
});
