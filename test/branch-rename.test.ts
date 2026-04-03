import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MOUNTAIN_NAMES } from '../server/types.js';
import { branchToDisplayName } from '../server/git.js';

describe('MOUNTAIN_NAMES', () => {
  test('contains 30 mountain names', () => {
    assert.equal(MOUNTAIN_NAMES.length, 30);
  });

  test('all names are lowercase kebab-case', () => {
    for (const name of MOUNTAIN_NAMES) {
      assert.match(
        name,
        /^[a-z][a-z0-9-]*$/,
        `Mountain name "${name}" is not kebab-case`
      );
    }
  });

  test('no duplicate names', () => {
    const unique = new Set(MOUNTAIN_NAMES);
    assert.equal(unique.size, MOUNTAIN_NAMES.length);
  });

  test('cycling wraps around at array length', () => {
    let idx = 28;
    const name1 = MOUNTAIN_NAMES[idx % MOUNTAIN_NAMES.length];
    idx++;
    const name2 = MOUNTAIN_NAMES[idx % MOUNTAIN_NAMES.length];
    idx++;
    const name3 = MOUNTAIN_NAMES[idx % MOUNTAIN_NAMES.length];

    assert.equal(name1, 'whitney');
    assert.equal(name2, 'hood');
    assert.equal(name3, 'everest'); // wraps back to start
  });
});

describe('branchToDisplayName', () => {
  test('converts kebab-case to sentence case', () => {
    assert.equal(
      branchToDisplayName('fix-mobile-scroll-bug'),
      'Fix mobile scroll bug'
    );
  });

  test('strips common branch prefixes', () => {
    assert.equal(branchToDisplayName('feature/add-auth'), 'Add auth');
    assert.equal(branchToDisplayName('fix/api-timeout'), 'Api timeout');
    assert.equal(branchToDisplayName('chore/update-deps'), 'Update deps');
  });

  test('handles simple names', () => {
    assert.equal(branchToDisplayName('lhotse'), 'Lhotse');
  });

  test('handles underscores', () => {
    assert.equal(branchToDisplayName('fix_the_thing'), 'Fix the thing');
  });
});
