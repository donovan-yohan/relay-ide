import { test, expect } from 'vitest';
import { semverLessThan } from '../server/utils.js';

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

// Nightly / pre-release comparison tests

test('nightly-to-nightly: older build < newer build', () => {
  expect(
    semverLessThan(
      '0.1.0-nightly.20260404.200',
      '0.1.0-nightly.20260405.238'
    )
  ).toBe(true);
});

test('nightly-to-nightly: same build is not less than', () => {
  expect(
    semverLessThan(
      '0.1.0-nightly.20260405.238',
      '0.1.0-nightly.20260405.238'
    )
  ).toBe(false);
});

test('nightly-to-nightly: newer build is not less than older', () => {
  expect(
    semverLessThan(
      '0.1.0-nightly.20260405.238',
      '0.1.0-nightly.20260404.200'
    )
  ).toBe(false);
});

test('nightly-to-nightly: same date, different build number', () => {
  expect(
    semverLessThan(
      '0.1.0-nightly.20260405.100',
      '0.1.0-nightly.20260405.238'
    )
  ).toBe(true);
});

test('pre-release is less than release (same base version)', () => {
  expect(semverLessThan('0.1.0-nightly.20260405.238', '0.1.0')).toBe(true);
});

test('release is not less than pre-release (same base version)', () => {
  expect(semverLessThan('0.1.0', '0.1.0-nightly.20260405.238')).toBe(false);
});

test('nightly with lower base version is less than higher release', () => {
  expect(semverLessThan('0.1.0-nightly.20260405.238', '0.2.0')).toBe(true);
});

test('nightly with higher base version beats lower release', () => {
  expect(semverLessThan('0.2.0-nightly.20260405.1', '0.1.0')).toBe(false);
});

test('fewer pre-release identifiers is lower precedence', () => {
  expect(semverLessThan('0.1.0-nightly', '0.1.0-nightly.1')).toBe(true);
});
