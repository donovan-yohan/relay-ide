import { test, describe, expect } from 'vitest';
import { MOUNTAIN_NAMES } from '../server/types.js';
import { phraseToBranchName } from '../server/git.js';

describe('MOUNTAIN_NAMES', () => {
  test('contains 30 mountain names', () => {
    expect(MOUNTAIN_NAMES.length).toBe(30);
  });

  test('all names are lowercase kebab-case', () => {
    for (const name of MOUNTAIN_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  test('no duplicate names', () => {
    const unique = new Set(MOUNTAIN_NAMES);
    expect(unique.size).toBe(MOUNTAIN_NAMES.length);
  });

  test('cycling wraps around at array length', () => {
    let idx = 28;
    const name1 = MOUNTAIN_NAMES[idx % MOUNTAIN_NAMES.length];
    idx++;
    const name2 = MOUNTAIN_NAMES[idx % MOUNTAIN_NAMES.length];
    idx++;
    const name3 = MOUNTAIN_NAMES[idx % MOUNTAIN_NAMES.length];

    expect(name1).toBe('whitney');
    expect(name2).toBe('hood');
    expect(name3).toBe('everest'); // wraps back to start
  });
});

describe('phraseToBranchName', () => {
  test('converts a phrase to kebab-case', () => {
    expect(phraseToBranchName('Fix the mobile scroll overflow')).toBe(
      'fix-the-mobile-scroll-overflow'
    );
  });

  test('strips special characters', () => {
    expect(phraseToBranchName("Add user's authentication!")).toBe(
      'add-users-authentication'
    );
  });

  test('collapses multiple spaces and hyphens', () => {
    expect(phraseToBranchName('Fix  the   bug')).toBe('fix-the-bug');
    expect(phraseToBranchName('fix--the--bug')).toBe('fix-the-bug');
  });

  test('trims leading and trailing hyphens', () => {
    expect(phraseToBranchName(' -Fix the bug- ')).toBe('fix-the-bug');
  });

  test('truncates to 60 characters', () => {
    const long =
      'This is a very long descriptive phrase that should be truncated to sixty characters max';
    const result = phraseToBranchName(long);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).toBe(
      'this-is-a-very-long-descriptive-phrase-that-should-be-trunca'
    );
  });

  test('preserves numbers', () => {
    expect(phraseToBranchName('Fix issue 42 in auth')).toBe(
      'fix-issue-42-in-auth'
    );
  });
});
