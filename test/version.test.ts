import { test, expect } from 'vitest';

function semverLessThan(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
  }
  return false;
}

test('semverLessThan returns true when major is lower', () => {
  expect(semverLessThan('1.0.0', '2.0.0')).toBe(true);
});

test('semverLessThan returns true when minor is lower', () => {
  expect(semverLessThan('1.1.0', '1.2.0')).toBe(true);
});

test('semverLessThan returns true when patch is lower', () => {
  expect(semverLessThan('1.1.1', '1.1.2')).toBe(true);
});

test('semverLessThan returns false for equal versions', () => {
  expect(semverLessThan('1.1.1', '1.1.1')).toBe(false);
});

test('semverLessThan returns false when current is greater', () => {
  expect(semverLessThan('2.0.0', '1.9.9')).toBe(false);
});

test('semverLessThan handles major version jumps', () => {
  expect(semverLessThan('1.9.9', '2.0.0')).toBe(true);
});

test('semverLessThan handles two-segment versions gracefully', () => {
  expect(semverLessThan('1.0', '1.1')).toBe(true);
});
