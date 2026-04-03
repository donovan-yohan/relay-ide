import { describe, it, expect } from 'vitest';
import { extractOwnerRepo } from '../server/git.js';
import { isStalePr } from '../server/gh.js';
import type { PrInfo } from '../server/types.js';

describe('extractOwnerRepo', () => {
  it('parses an SSH URL with .git suffix', () => {
    expect(extractOwnerRepo('git@github.com:donovan-yohan/relay-ide.git')).toBe(
      'donovan-yohan/relay-ide'
    );
  });

  it('parses an SSH URL without .git suffix', () => {
    expect(extractOwnerRepo('git@github.com:owner/repo')).toBe('owner/repo');
  });

  it('parses an HTTPS URL with .git suffix', () => {
    expect(extractOwnerRepo('https://github.com/owner/repo.git')).toBe(
      'owner/repo'
    );
  });

  it('parses an HTTPS URL without .git suffix', () => {
    expect(extractOwnerRepo('https://github.com/owner/repo')).toBe(
      'owner/repo'
    );
  });

  it('is host-agnostic and parses a non-GitHub HTTPS URL', () => {
    expect(extractOwnerRepo('https://gitlab.com/owner/repo.git')).toBe(
      'owner/repo'
    );
  });

  it('returns null for an empty string', () => {
    expect(extractOwnerRepo('')).toBe(null);
  });

  it('returns null for a malformed URL', () => {
    expect(extractOwnerRepo('not-a-url')).toBe(null);
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
    expect(
      isStalePr(makePr({ state: 'OPEN', updatedAt: '2020-01-01T00:00:00Z' }))
    ).toBe(false);
  });

  it('MERGED PR updated more than 1 day ago is stale', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(isStalePr(makePr({ state: 'MERGED', updatedAt: twoDaysAgo }))).toBe(
      true
    );
  });

  it('CLOSED PR updated more than 1 day ago is stale', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(isStalePr(makePr({ state: 'CLOSED', updatedAt: twoDaysAgo }))).toBe(
      true
    );
  });

  it('MERGED PR updated less than 1 day ago is not stale (grace period)', () => {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    expect(isStalePr(makePr({ state: 'MERGED', updatedAt: oneHourAgo }))).toBe(
      false
    );
  });

  it('PR with empty updatedAt is stale', () => {
    expect(isStalePr(makePr({ state: 'MERGED', updatedAt: '' }))).toBe(true);
  });

  it('PR with unparseable updatedAt is stale', () => {
    expect(
      isStalePr(makePr({ state: 'CLOSED', updatedAt: 'not-a-date' }))
    ).toBe(true);
  });
});
