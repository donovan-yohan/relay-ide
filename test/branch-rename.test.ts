import { test, describe, expect } from 'vitest';
import { MOUNTAIN_NAMES } from '../server/types.js';
import { branchToDisplayName } from '../server/git.js';

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

describe('branchToDisplayName', () => {
  test('converts kebab-case to sentence case', () => {
    expect(branchToDisplayName('fix-mobile-scroll-bug')).toBe(
      'Fix mobile scroll bug'
    );
  });

  test('strips common branch prefixes', () => {
    expect(branchToDisplayName('feature/add-auth')).toBe('Add auth');
    expect(branchToDisplayName('fix/api-timeout')).toBe('Api timeout');
    expect(branchToDisplayName('chore/update-deps')).toBe('Update deps');
  });

  test('handles simple names', () => {
    expect(branchToDisplayName('lhotse')).toBe('Lhotse');
  });

  test('handles underscores', () => {
    expect(branchToDisplayName('fix_the_thing')).toBe('Fix the thing');
  });
});
